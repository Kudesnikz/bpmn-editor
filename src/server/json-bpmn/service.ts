import { AppError } from '../errors.js';
import type { DiagramRecord } from '../types.js';
import type { DiagramStorage } from '../storage.js';
import { boundedValidation } from './jobs.js';
import type { ReadOptions } from './projection.js';
import { JsonWorkerPool } from './worker-pool.js';

function metadata(input: any) { return { name: input.name, folderId: input.folder_id, description: input.description }; }
function compact(record: DiagramRecord) { const { xml: _xml, ...result } = record; return result; }

export class JsonBpmnService {
  constructor(readonly storage: DiagramStorage, readonly pool: JsonWorkerPool, readonly maxBytes: number) {}

  async read(id: string, options: ReadOptions, inspect = false) {
    if (options.scope !== 'fragment' && options.selector) throw new AppError(400, 'INVALID_SELECTOR', 'selector is only valid for fragment reads');
    const snapshot = await this.storage.get(id);
    return { diagram: compact(snapshot), ...await this.pool.run({ kind: 'read', xml: snapshot.xml, revision: snapshot.revision, options, inspect, maxBytes: this.maxBytes }) };
  }

  private prepare(input: any, xml?: string) {
    const mode = input.layout?.mode ?? (input.document ? 'auto' : 'preserve');
    if (input.document && mode === 'preserve') throw new AppError(400, 'INVALID_LAYOUT_MODE', 'Full documents require auto or provided layout');
    return this.pool.run({ kind: 'prepare', xml, document: input.document, operations: input.operations, layoutMode: mode, planeId: input.layout?.plane_id, scopeIds: input.layout?.scope_ids, maxBytes: this.maxBytes });
  }

  async create(input: any) {
    let prepared: any;
    const result = await this.storage.createPrepared({ id: input.id, ...metadata(input), name: input.name }, async () => prepared = await this.prepare(input));
    return this.writeResult(result.diagram, prepared);
  }

  async update(input: any) {
    const hasDocument = input.document !== undefined, hasOperations = input.operations !== undefined;
    if (input.mode === 'replace' ? (!hasDocument || hasOperations || !input.layout || !['auto', 'provided'].includes(input.layout.mode))
      : input.mode === 'operations' ? (!hasOperations || hasDocument)
      : (hasOperations || hasDocument || input.layout !== undefined || !['name', 'folder_id', 'description'].some(key => input[key] !== undefined))) {
      throw new AppError(400, 'INVALID_UPDATE_MODE', 'Use exactly one mode: operations, complete replacement with explicit auto/provided layout, or metadata');
    }
    if (input.mode !== 'metadata' && ['name', 'folder_id', 'description'].some(key => input[key] !== undefined)) throw new AppError(400, 'INVALID_UPDATE_MODE', 'Change catalog metadata in a separate metadata operation');
    let prepared: any;
    const result = await this.storage.updatePrepared(input.id, { expectedRevision: input.expected_revision, ...metadata(input) }, async xml => {
      prepared = input.mode === 'metadata' ? await this.pool.run({ kind: 'validate_xml', xml, maxBytes: this.maxBytes }) : await this.prepare(input, xml);
      return prepared;
    });
    return this.writeResult(result.diagram, prepared);
  }

  async validate(input: any) {
    if (Boolean(input.document) === Boolean(input.operations)) throw new AppError(400, 'INVALID_REQUEST', 'Supply either document or operations');
    let xml: string | undefined;
    if (input.operations) {
      if (!input.id || !input.expected_revision) throw new AppError(400, 'REVISION_REQUIRED', 'Operation validation needs id and expected_revision');
      const snapshot = await this.storage.get(input.id);
      if (snapshot.revision !== input.expected_revision) throw new AppError(409, 'REVISION_CONFLICT', 'Diagram was changed by another client', { currentRevision: snapshot.revision });
      xml = snapshot.xml;
    } else if (input.id || input.expected_revision) throw new AppError(400, 'INVALID_REQUEST', 'Document validation does not take an existing diagram id or revision');
    const prepared = await this.prepare(input, xml);
    return { validation: boundedValidation(prepared.validation), changedIds: prepared.changedIds, removedIds: prepared.removedIds, layoutScopeIds: prepared.layoutScopeIds, ...(input.expected_revision ? { revision: input.expected_revision } : {}) };
  }

  async duplicate(input: any) {
    const result = await this.storage.duplicatePrepared(input.source_id, { id: input.new_id, expectedRevision: input.expected_revision, ...metadata(input), name: input.name }, xml => this.pool.run({ kind: 'validate_xml', xml, maxBytes: this.maxBytes }));
    return this.writeResult(result.diagram, { validation: result.validation });
  }

  private writeResult(diagram: DiagramRecord, prepared: any) {
    return { diagram: compact(diagram), validation: boundedValidation(prepared.validation), changedIds: prepared.changedIds || [], removedIds: prepared.removedIds || [], layoutScopeIds: prepared.layoutScopeIds || [] };
  }
}
