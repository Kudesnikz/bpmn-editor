import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';
import { isScalarType, type BpmnDocument } from './codec.js';
import { descendants, ownership, semanticDocument, visitProperties } from './graph.js';
import { fail } from './xml.js';

export interface ReadOptions {
  scope: 'summary' | 'semantic' | 'full' | 'fragment';
  selector?: { element_ids?: string[]; container_id?: string; types?: string[]; query?: string; neighbor_depth?: number; include_di?: boolean };
  cursor?: string;
  limit?: number;
}

export function projectDocument(input: BpmnDocument, revision: string, options: ReadOptions) {
  const source = options.scope === 'full' || options.selector?.include_di ? input : semanticDocument(input);
  const statistics: Record<string, number> = {};
  for (const element of Object.values(source.elements)) statistics[element.type] = (statistics[element.type] || 0) + 1;
  const omittedSections = options.scope === 'full' || options.selector?.include_di ? [] : ['di'];
  if (options.scope === 'summary') return { revision, scope: options.scope, complete: true, selectionComplete: true, documentComplete: false, omittedSections: ['elements', 'di'], statistics };
  let selected = new Set(Object.keys(source.elements));
  const parents = ownership(source);
  if (options.scope === 'fragment') {
    const selector = options.selector;
    if (!selector || !(selector.element_ids?.length || selector.container_id || selector.types?.length || selector.query)) fail('INVALID_SELECTOR', 'A fragment requires an explicit selector');
    const depth = selector.neighbor_depth ?? 1;
    if (!Number.isInteger(depth) || depth < 0 || depth > 2) fail('INVALID_SELECTOR', 'neighbor_depth must be 0–2');
    if (selector.element_ids?.some(id => !source.elements[id]) || selector.container_id && !source.elements[selector.container_id]) fail('PATCH_TARGET_NOT_FOUND', 'Requested element or container does not exist');
    const within = selector.container_id ? descendants(source, selector.container_id) : undefined;
    selected = new Set(Object.keys(source.elements).filter(id => {
      const element = source.elements[id]!;
      return (!selector.element_ids?.length || selector.element_ids.includes(id))
        && (!within || within.has(id))
        && (!selector.types?.length || selector.types.includes(element.type))
        && (!selector.query || `${id} ${element.properties.name || ''}`.toLocaleLowerCase().includes(selector.query.toLocaleLowerCase()));
    }));
    for (let hop = 0; hop < depth; hop++) {
      const previous = new Set(selected);
      for (const [flowId, flow] of Object.entries(source.elements)) {
        if (!['bpmn:SequenceFlow', 'bpmn:MessageFlow', 'bpmn:Association'].includes(flow.type)) continue;
        const ends = [flow.properties.sourceRef, flow.properties.targetRef] as string[];
        if (previous.has(flowId) || ends.some(id => previous.has(id))) {
          selected.add(flowId);
          for (const id of ends) if (source.elements[id]) selected.add(id);
        }
      }
    }
    if (selector.include_di) {
      for (const [id, element] of Object.entries(source.elements)) if (element.type.startsWith('bpmndi:') && selected.has(element.properties.bpmnElement)) {
        for (const child of descendants(source, id)) selected.add(child);
      }
    }
    omittedSections.push('unselectedElements');
  }
  const ids = [...selected].sort();
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_SELECTOR', 'limit must be 1–100');
  const selectionHash = createHash('sha256').update(JSON.stringify({ scope: options.scope, selector: options.selector || null, limit })).digest('hex');
  let offset = 0;
  if (options.cursor) {
    let cursor: any;
    try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')); }
    catch { fail('INVALID_CURSOR', 'Cursor is invalid'); }
    if (cursor.revision !== revision) throw new AppError(409, 'REVISION_CONFLICT', 'Diagram changed during paginated reading', { currentRevision: revision });
    if (cursor.selectionHash !== selectionHash || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > ids.length) fail('INVALID_CURSOR', 'Cursor does not match the selection');
    offset = cursor.offset;
  }
  const pageIds: string[] = [];
  const elements: BpmnDocument['elements'] = Object.create(null);
  const parentContext = new Map<string, { id: string; type: string; name?: string; parentId?: string }>();
  const external = new Set<string>();
  const addContext = (id: string) => {
    const seen = new Set<string>();
    let parent = parents.get(id)?.ownerId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const element = source.elements[parent]!;
      parentContext.set(parent, { id: parent, type: element.type, ...(element.properties.name ? { name: element.properties.name } : {}), parentId: parents.get(parent)?.ownerId });
      parent = parents.get(parent)?.ownerId;
    }
  };
  let bytes = Buffer.byteLength(JSON.stringify(source.namespaces)) + 4096;
  for (const id of ids.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify([id, source.elements[id]]));
    if (bytes + size > 240 * 1024) {
      if (!pageIds.length) fail('RESPONSE_TOO_LARGE', 'One element exceeds the response limit; request a summary');
      break;
    }
    elements[id] = source.elements[id]!;
    pageIds.push(id);
    bytes += size;
    addContext(id);
  }
  visitProperties({ ...source, elements }, ({ descriptor: p, value }) => {
    if (isScalarType(p.type) && !p.isReference) return;
    for (const id of p.isMany ? value : [value]) if (typeof id === 'string' && !elements[id]) external.add(id);
  });
  for (const id of pageIds) parentContext.delete(id);
  const nextOffset = offset + pageIds.length;
  const result = {
    revision,
    scope: options.scope,
    complete: nextOffset === ids.length,
    selectionComplete: nextOffset === ids.length,
    documentComplete: options.scope === 'full' && offset === 0 && nextOffset === ids.length,
    omittedSections,
    totalElements: ids.length,
    offset,
    document: { format: source.format, version: source.version, rootId: source.rootId, namespaces: source.namespaces, elements },
    parents: [...parentContext.values()],
    externalReferenceIds: [...external].sort(),
    ...(nextOffset < ids.length ? { nextCursor: Buffer.from(JSON.stringify({ revision, selectionHash, offset: nextOffset })).toString('base64url') } : {})
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) fail('RESPONSE_TOO_LARGE', 'Context exceeds response limit; reduce limit or neighbor_depth');
  return result;
}
