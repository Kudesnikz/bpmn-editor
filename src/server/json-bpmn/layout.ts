import { layoutProcess } from 'bpmn-auto-layout';
import { documentFingerprint, documentToXml, xmlToDocument, type BpmnDocument, type JsonElement } from './codec.js';
import { descendants, ownership, semanticDocument, scopeOf } from './graph.js';
import type { Changes } from './operations.js';
import { fail } from './xml.js';

export type LayoutMode = 'preserve' | 'auto' | 'provided';
interface Bounds { x: number; y: number; width: number; height: number }
interface Point { x: number; y: number }
const center = (b: Bounds): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const overlap = (a: Bounds, b: Bounds, margin = 12) => a.x < b.x + b.width + margin && a.x + a.width + margin > b.x && a.y < b.y + b.height + margin && a.y + a.height + margin > b.y;
const inside = (a: Bounds, b: Bounds) => a.x >= b.x + 36 && a.y >= b.y + 20 && a.x + a.width <= b.x + b.width - 20 && a.y + a.height <= b.y + b.height - 20;
const visible = (type: string) => /Event$|Task$|Gateway$/.test(type) || ['bpmn:SubProcess', 'bpmn:CallActivity', 'bpmn:Transaction', 'bpmn:AdHocSubProcess', 'bpmn:TextAnnotation', 'bpmn:DataObjectReference', 'bpmn:DataStoreReference'].includes(type);

export function layoutRoot(document: BpmnDocument, elementId: string): string | undefined {
  const parents = ownership(document);
  let current: string | undefined = elementId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const element = document.elements[current];
    if (!element) return undefined;
    if (element.type === 'bpmn:Collaboration') return current;
    if (element.type === 'bpmn:Process') {
      const participant = Object.entries(document.elements).find(([, e]) => e.type === 'bpmn:Participant' && e.properties.processRef === current)?.[0];
      return participant ? parents.get(participant)?.ownerId : current;
    }
    current = parents.get(current)?.ownerId;
  }
  return undefined;
}

function needsRelayout(document: BpmnDocument, ids: string[], reason: string): never {
  fail('RELAYOUT_REQUIRED', reason, { elementIds: ids, layoutScopeIds: [...new Set(ids.map(id => layoutRoot(document, id)).filter(Boolean))] });
}

function freshId(document: BpmnDocument, base: string): string {
  let id = base;
  let suffix = 1;
  while (Object.hasOwn(document.elements, id)) id = `${base}_${suffix++}`;
  return id;
}

export function preserveLayout(changes: Changes, planeId?: string): BpmnDocument {
  const document = changes.document;
  const parents = ownership(document);
  const planes = Object.entries(document.elements).filter(([, e]) => e.type === 'bpmndi:BPMNPlane');
  const shapeEntries = () => Object.entries(document.elements).filter(([, e]) => e.type === 'bpmndi:BPMNShape');
  const planeFor = (id: string): [string, JsonElement] => {
    const targetScope = scopeOf(document, id);
    const root = layoutRoot(document, id);
    const existing = shapeEntries().filter(([, e]) => e.properties.bpmnElement === id);
    const preferred = existing.map(([key]) => parents.get(key)?.ownerId);
    const candidates = planes.filter(([key, e]) => planeId ? key === planeId : preferred.length ? preferred.includes(key) : e.properties.bpmnElement === targetScope || e.properties.bpmnElement === root);
    if (candidates.length !== 1) fail('PLANE_REQUIRED', 'Select one plane for geometry changes', { elementId: id, planeIds: candidates.map(([key]) => key) });
    return candidates[0]!;
  };
  const shapeFor = (id: string, plane: JsonElement): JsonElement | undefined => (plane.properties.planeElement || [])
    .map((key: string) => document.elements[key]).find((e: JsonElement) => e?.type === 'bpmndi:BPMNShape' && e.properties.bpmnElement === id);
  const append = (plane: JsonElement, id: string, entry: JsonElement) => {
    document.elements[id] = entry;
    plane.properties.planeElement = [...(plane.properties.planeElement || []), id];
  };
  const moved = new Set<string>();
  for (const id of changes.geometryIds) {
    const element = document.elements[id];
    if (!element) continue;
    if (['bpmn:Lane', 'bpmn:Participant', 'bpmn:SubProcess', 'bpmn:Transaction', 'bpmn:AdHocSubProcess'].includes(element.type)) {
      if (!shapeEntries().some(([, e]) => e.properties.bpmnElement === id)) needsRelayout(document, [id], 'Adding or resizing a container requires relayout or provided DI');
    }
    if (!visible(element.type)) continue;
    if (element.type === 'bpmn:BoundaryEvent') needsRelayout(document, [id], 'Boundary-event placement requires relayout or provided DI');
    const [, plane] = planeFor(id);
    const existing = shapeFor(id, plane);
    const hint = changes.hints[id];
    if (existing && !hint) continue;
    const width = /Event$/.test(element.type) ? 36 : /Gateway$/.test(element.type) ? 50 : 100;
    const height = /Event$/.test(element.type) ? 36 : /Gateway$/.test(element.type) ? 50 : 80;
    const nodeScope = scopeOf(document, id);
    const inferredLane = Object.entries(document.elements).find(([, e]) => e.type === 'bpmn:Lane' && e.properties.flowNodeRef?.includes(id))?.[0];
    const laneId = hint?.laneId || inferredLane;
    const participantId = Object.entries(document.elements).find(([, e]) => e.type === 'bpmn:Participant' && e.properties.processRef === nodeScope)?.[0];
    const containerId = laneId || (nodeScope && document.elements[nodeScope]?.type !== 'bpmn:Process' ? nodeScope : participantId);
    const container = containerId ? shapeFor(containerId, plane)?.properties.bounds?.properties as Bounds | undefined : undefined;
    if (containerId && !container) needsRelayout(document, [id], 'Container DI is missing on this plane');
    const obstacleEntries = (plane.properties.planeElement || []).map((key: string) => document.elements[key]).filter((e: JsonElement) => e?.type === 'bpmndi:BPMNShape' && e.properties.bpmnElement !== id);
    const obstacles: Bounds[] = obstacleEntries.filter((e: JsonElement) => {
      const bpmnType = document.elements[e.properties.bpmnElement]?.type || '';
      return visible(bpmnType) && e.properties.bpmnElement !== containerId;
    }).map((e: JsonElement) => e.properties.bounds.properties);
    const after = hint?.afterId ? shapeFor(hint.afterId, plane)?.properties.bounds?.properties as Bounds | undefined : undefined;
    const candidates: Bounds[] = [];
    if (after) candidates.push({ x: after.x + after.width + 40, y: after.y + (after.height - height) / 2, width, height });
    if (existing) candidates.push({ ...existing.properties.bounds.properties });
    const area = container || { x: 0, y: 0, width: Math.max(1000, ...obstacles.map(b => b.x + b.width + 300)), height: Math.max(800, ...obstacles.map(b => b.y + b.height + 300)) };
    for (let y = area.y + 40; y + height <= area.y + area.height - 20 && candidates.length < 2000; y += 100) {
      for (let x = area.x + 50; x + width <= area.x + area.width - 20 && candidates.length < 2000; x += 140) candidates.push({ x, y, width, height });
    }
    const bounds = candidates.find(candidate => (!container || inside(candidate, container)) && obstacles.every(obstacle => !overlap(candidate, obstacle)));
    if (!bounds) needsRelayout(document, [id], 'No free space in the existing container');
    if (existing) existing.properties.bounds = { type: 'dc:Bounds', properties: bounds };
    else append(plane, freshId(document, `${id}_di`), { type: 'bpmndi:BPMNShape', properties: { bpmnElement: id, bounds: { type: 'dc:Bounds', properties: bounds } } });
    moved.add(id);
  }
  const flows = Object.entries(document.elements).filter(([id, e]) => ['bpmn:SequenceFlow', 'bpmn:MessageFlow', 'bpmn:Association'].includes(e.type)
    && (changes.geometryIds.includes(id) || moved.has(e.properties.sourceRef) || moved.has(e.properties.targetRef)));
  for (const [id, flow] of flows) {
    const [, plane] = planeFor(id);
    const source = shapeFor(flow.properties.sourceRef, plane)?.properties.bounds?.properties as Bounds | undefined;
    const target = shapeFor(flow.properties.targetRef, plane)?.properties.bounds?.properties as Bounds | undefined;
    if (!source || !target) needsRelayout(document, [id], 'Flow endpoint DI is missing');
    const obstacles = (plane.properties.planeElement || []).map((key: string) => document.elements[key]).filter((e: JsonElement) => e?.type === 'bpmndi:BPMNShape'
      && ![flow.properties.sourceRef, flow.properties.targetRef].includes(e.properties.bpmnElement)
      && visible(document.elements[e.properties.bpmnElement]?.type || '')).map((e: JsonElement) => e.properties.bounds.properties as Bounds);
    const waypoints = route(source, target, obstacles);
    if (!waypoints) needsRelayout(document, [id], 'No local route avoiding existing shapes');
    let edge = (plane.properties.planeElement || []).map((key: string) => document.elements[key]).find((e: JsonElement) => e?.type === 'bpmndi:BPMNEdge' && e.properties.bpmnElement === id);
    if (!edge) {
      edge = { type: 'bpmndi:BPMNEdge', properties: { bpmnElement: id } };
      append(plane, freshId(document, `${id}_di`), edge);
    }
    edge.properties.waypoint = waypoints.map(point => ({ type: 'dc:Point', properties: point }));
  }
  return document;
}

function route(source: Bounds, target: Bounds, obstacles: Bounds[]): Point[] | undefined {
  const s = center(source), t = center(target);
  const ports = (b: Bounds) => [{ x: b.x + b.width, y: b.y + b.height / 2 }, { x: b.x, y: b.y + b.height / 2 }, { x: b.x + b.width / 2, y: b.y }, { x: b.x + b.width / 2, y: b.y + b.height }];
  const blocked = (a: Point, b: Point, rect: Bounds) => {
    if (a.x === b.x) return a.x > rect.x - 4 && a.x < rect.x + rect.width + 4 && Math.max(a.y, b.y) > rect.y - 4 && Math.min(a.y, b.y) < rect.y + rect.height + 4;
    return a.y > rect.y - 4 && a.y < rect.y + rect.height + 4 && Math.max(a.x, b.x) > rect.x - 4 && Math.min(a.x, b.x) < rect.x + rect.width + 4;
  };
  const xs = [...new Set([(s.x + t.x) / 2, ...obstacles.flatMap(b => [b.x - 24, b.x + b.width + 24])])].slice(0, 100);
  const ys = [...new Set([(s.y + t.y) / 2, ...obstacles.flatMap(b => [b.y - 24, b.y + b.height + 24])])].slice(0, 100);
  let best: Point[] | undefined, bestLength = Infinity;
  for (const a of ports(source)) for (const b of ports(target)) {
    const candidates = [
      [a, { x: b.x, y: a.y }, b], [a, { x: a.x, y: b.y }, b],
      ...xs.map(x => [a, { x, y: a.y }, { x, y: b.y }, b]),
      ...ys.map(y => [a, { x: a.x, y }, { x: b.x, y }, b])
    ];
    for (let points of candidates) {
      points = points.filter((point, i) => !i || point.x !== points[i - 1]!.x || point.y !== points[i - 1]!.y);
      if (points.length < 2) continue;
      const interiors = [source, target].map(rect => ({ x: rect.x + 5, y: rect.y + 5, width: rect.width - 10, height: rect.height - 10 }));
      if (points.slice(1).some((point, i) => [...obstacles, ...interiors].some(rect => blocked(points[i]!, point, rect)))) continue;
      const length = points.slice(1).reduce((sum, point, i) => sum + Math.abs(points[i]!.x - point.x) + Math.abs(points[i]!.y - point.y), points.length * 10);
      if (length < bestLength) { best = points; bestLength = length; }
    }
  }
  return best;
}

/** Regenerate selected roots, merging DI only; never trust a layouter with semantics/extensions. */
export async function autoLayout(document: BpmnDocument, scopeIds?: string[]): Promise<BpmnDocument> {
  const result = structuredClone(document);
  const semantic = semanticDocument(document);
  const root = semantic.elements[semantic.rootId]!;
  const collaborations = Object.entries(semantic.elements).filter(([, e]) => e.type === 'bpmn:Collaboration').map(([id]) => id);
  const independent = Object.entries(semantic.elements).filter(([id, e]) => e.type === 'bpmn:Process' && layoutRoot(semantic, id) === id).map(([id]) => id);
  const scopes = scopeIds?.length ? [...new Set(scopeIds)] : [...collaborations, ...independent];
  if (!scopes.length) fail('LAYOUT_UNSUPPORTED', 'No process or collaboration can be laid out');
  for (const scopeId of scopes) {
    const target = semantic.elements[scopeId];
    if (!target || !['bpmn:Process', 'bpmn:Collaboration'].includes(target.type)) fail('LAYOUT_UNSUPPORTED', 'Unsupported layout root', { scopeId });
    const layoutInput = structuredClone(semantic);
    // The library selects the first collaboration, otherwise the first process.
    const discarded = collaborations.filter(id => id !== scopeId);
    for (const id of discarded) for (const child of descendants(layoutInput, id)) delete layoutInput.elements[child];
    layoutInput.elements[layoutInput.rootId]!.properties.rootElements = [scopeId, ...root.properties.rootElements.filter((id: string) => id !== scopeId && !discarded.includes(id))];
    let laidOut: BpmnDocument;
    try {
      const { xml } = await layoutProcess(await documentToXml(layoutInput));
      laidOut = await xmlToDocument(xml);
    } catch (error) {
      if (error instanceof Error && 'code' in error && String(error.code).startsWith('CONVERSION')) throw error;
      fail('LAYOUT_UNSUPPORTED', 'Automatic layout cannot represent this model', { scopeId });
    }
    const covered = descendants(semantic, scopeId);
    if (target.type === 'bpmn:Collaboration') for (const participant of Object.values(semantic.elements).filter(e => e.type === 'bpmn:Participant' && target.properties.participants?.some((id: string) => semantic.elements[id] === e))) {
      if (participant.properties.processRef) for (const child of descendants(semantic, participant.properties.processRef)) covered.add(child);
    }
    const definitions = result.elements[result.rootId]!;
    const retained: string[] = [];
    for (const diagramId of definitions.properties.diagrams || []) {
      const diagram = result.elements[diagramId]!;
      const plane = typeof diagram.properties.plane === 'string' ? result.elements[diagram.properties.plane] : diagram.properties.plane;
      if (covered.has(plane?.properties.bpmnElement)) for (const id of descendants(result, diagramId)) delete result.elements[id];
      else retained.push(diagramId);
    }
    definitions.properties.diagrams = retained;
    const diIds = new Set<string>();
    for (const diagramId of laidOut.elements[laidOut.rootId]!.properties.diagrams || []) for (const id of descendants(laidOut, diagramId)) diIds.add(id);
    if (!diIds.size) fail('LAYOUT_UNSUPPORTED', 'Layout produced no DI', { scopeId });
    const idMap = new Map<string, string>();
    for (const id of diIds) {
      const next = freshId(result, id);
      idMap.set(id, next);
      result.elements[next] = { type: 'reserved', properties: {} };
    }
    const copy = (value: any): any => {
      if (typeof value === 'string') return idMap.get(value) || value;
      if (Array.isArray(value)) return value.map(copy);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child)]));
      return value;
    };
    for (const id of diIds) result.elements[idMap.get(id)!] = copy(laidOut.elements[id]);
    definitions.properties.diagrams.push(...laidOut.elements[laidOut.rootId]!.properties.diagrams.map((id: string) => idMap.get(id)!));
  }
  if (documentFingerprint(semanticDocument(result)) !== documentFingerprint(semantic)) fail('CONVERSION_LOSS_DETECTED', 'Layout changed BPMN semantics');
  return result;
}
