import { documentToXml, xmlToDocument, describeTypes, type BpmnDocument } from './codec.js';
import { semanticDocument } from './graph.js';
import { autoLayout, layoutRoot, preserveLayout, type LayoutMode } from './layout.js';
import { applyOperations, type Operation } from './operations.js';
import { projectDocument, type ReadOptions } from './projection.js';
import { fail } from './xml.js';
import { validateBpmn } from '../validation.js';
import { inspectBpmn } from '../inspection.js';

export type JsonJob =
  | { kind: 'validate_xml'; xml: string; maxBytes: number }
  | { kind: 'read'; xml: string; revision: string; options: ReadOptions; inspect?: boolean; maxBytes: number }
  | { kind: 'types'; types: string[] }
  | { kind: 'prepare'; xml?: string; document?: BpmnDocument; operations?: Operation[]; layoutMode: LayoutMode; planeId?: string; scopeIds?: string[]; maxBytes: number };

export async function executeJsonJob(job: JsonJob): Promise<any> {
  if (job.kind === 'validate_xml') return { xml: job.xml, validation: await validateBpmn(job.xml, job.maxBytes) };
  if (job.kind === 'types') return { types: describeTypes(job.types) };
  if (job.kind === 'read') {
    const document = await xmlToDocument(job.xml);
    const result = projectDocument(document, job.revision, job.options);
    if (!job.inspect) return result;
    const inspection = await inspectBpmn(job.xml, job.maxBytes);
    const output = { ...result, inspection: { ...inspection, validation: boundedValidation(inspection.validation) } };
    if (Buffer.byteLength(JSON.stringify(output)) > 256 * 1024) fail('RESPONSE_TOO_LARGE', 'Inspection is too large; use get_diagram with a fragment selector');
    return output;
  }
  let document: BpmnDocument;
  let changedIds: string[] = [], removedIds: string[] = [], layoutScopeIds: string[] = [];
  if (job.operations) {
    if (!job.xml) fail('INVALID_REQUEST', 'Operations require an existing XML snapshot');
    const changes = applyOperations(await xmlToDocument(job.xml), job.operations);
    document = changes.document;
    changedIds = changes.changedIds;
    removedIds = changes.removedIds;
    // Verify semantic graph before sending it to either geometry engine.
    await documentToXml(document);
    if (job.layoutMode === 'preserve') document = preserveLayout(changes, job.planeId);
    else if (job.layoutMode === 'auto') {
      const affected = [...new Set(changes.geometryIds.map(id => layoutRoot(document, id)).filter((id): id is string => Boolean(id)))];
      layoutScopeIds = job.scopeIds || affected;
      if (affected.some(id => !layoutScopeIds.includes(id))) fail('INVALID_LAYOUT_SCOPE', 'Auto layout scope must include every affected process/collaboration', { requiredScopeIds: affected });
      if (layoutScopeIds.length) document = await autoLayout(document, layoutScopeIds);
    }
  } else if (job.document) {
    document = structuredClone(job.document);
    await documentToXml(document);
    if (job.layoutMode === 'preserve') fail('INVALID_REQUEST', 'Full replacement requires auto or provided layout');
    if (job.layoutMode === 'auto') {
      if (job.scopeIds) fail('INVALID_LAYOUT_SCOPE', 'Full documents require layout of the whole supplied model');
      document = await autoLayout(semanticDocument(document));
      layoutScopeIds = job.scopeIds || [...new Set(Object.keys(document.elements).map(id => layoutRoot(document, id)).filter((id): id is string => Boolean(id)))];
    }
  } else if (job.xml) document = await xmlToDocument(job.xml);
  else fail('INVALID_REQUEST', 'Supply document or operations');
  const xml = await documentToXml(document);
  const validation = await validateBpmn(xml, job.maxBytes);
  return { xml, validation, changedIds, removedIds, layoutScopeIds };
}

export function boundedValidation(validation: Awaited<ReturnType<typeof validateBpmn>>) {
  return { valid: validation.valid, errors: validation.errors.slice(0, 25), warnings: validation.warnings.slice(0, 25), errorCount: validation.errors.length, warningCount: validation.warnings.length };
}
