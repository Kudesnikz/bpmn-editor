import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiagramStorage, createBlankBpmn } from '../src/server/storage.js';
import { JsonWorkerPool } from '../src/server/json-bpmn/worker-pool.js';

describe('prepared JSON storage commits', () => {
  let directory: string;
  let storage: DiagramStorage;
  let pool: JsonWorkerPool;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'bpmn-prepared-'));
    storage = new DiagramStorage(directory, path.resolve('diagrams'), 'http://test', 2097152);
    await storage.initialize();
    pool = new JsonWorkerPool();
  });
  afterEach(async () => { await pool.close(); await rm(directory, { recursive: true, force: true }); });

  it('commits a worker-prepared rename and keeps geometry and other XML data', async () => {
    const original = await storage.get('shop');
    const result = await storage.updatePrepared('shop', { expectedRevision: original.revision }, xml => pool.run({
      kind: 'prepare', xml, operations: [{ op: 'update_properties', element_id: 'Task_Pay', set: { name: 'Changed by JSON' } }], layoutMode: 'preserve', maxBytes: 2097152
    }));
    expect(result.validation.valid).toBe(true);
    expect(result.diagram.revision).not.toBe(original.revision);
    expect(result.diagram.xml).toContain('Changed by JSON');
    expect(await readFile(path.join(directory, 'shop.bpmn'), 'utf8')).toBe(result.diagram.xml);
  });

  it('preserves mixed-content extensions through worker preparation, disk commit and restart', async () => {
    const extension = '<bpmn:extensionElements><v:settings xmlns:v="urn:vendor" v:mode="advanced">before<v:child flag="yes">inside</v:child>after</v:settings></bpmn:extensionElements>';
    const xml = createBlankBpmn('extended', 'Extended').replace('isExecutable="false">', `isExecutable="false">${extension}`);
    const created = await storage.create({ id: 'extended', name: 'Extended', xml });
    const result = await storage.updatePrepared('extended', { expectedRevision: created.diagram.revision }, source => pool.run({ kind: 'prepare', xml: source, operations: [{ op: 'update_properties', element_id: 'StartEvent_extended', set: { name: 'New start' } }], layoutMode: 'preserve', maxBytes: 2097152 }));
    const restarted = new DiagramStorage(directory, path.resolve('diagrams'), 'http://test', 2097152);
    await restarted.initialize();
    expect((await restarted.get('extended')).xml).toBe(result.diagram.xml);
    expect(result.diagram.xml).toContain('before');
    expect(result.diagram.xml).toContain('inside');
    expect(result.diagram.xml).toContain('after');
    expect(result.diagram.xml).toContain('urn:vendor');
    expect(result.diagram.xml).toContain('New start');
  });

  it('allows an XML client to save during preparation and then rejects the stale JSON commit', async () => {
    const original = await storage.get('shop');
    let signal!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { signal = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const pending = storage.updatePrepared('shop', { expectedRevision: original.revision, name: 'JSON edit' }, async xml => {
      signal(); await barrier;
      return { xml, validation: await storage.validate(xml) };
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await entered;
    const manual = await storage.update('shop', { expectedRevision: original.revision, name: 'Manual edit' });
    release();
    await rejected;
    expect(await storage.get('shop')).toEqual(manual.diagram);
  });

  it('does not touch catalog or XML when preparation fails', async () => {
    const original = await storage.get('shop');
    const index = await readFile(path.join(directory, 'index.json'), 'utf8');
    await expect(storage.updatePrepared('shop', { expectedRevision: original.revision }, async () => { throw new Error('Preparation failed'); })).rejects.toThrow('Preparation failed');
    expect(await storage.get('shop')).toEqual(original);
    expect(await readFile(path.join(directory, 'index.json'), 'utf8')).toBe(index);
  });

  it('rejects invalid prepared XML before creating any file', async () => {
    await expect(storage.createPrepared({ id: 'invalid', name: 'Invalid' }, async () => ({ xml: '<invalid/>', validation: { valid: false, errors: [{ code: 'INVALID_ROOT', message: 'Invalid' }], warnings: [] } }))).rejects.toMatchObject({ code: 'INVALID_BPMN' });
    expect((await storage.list()).map(d => d.id).sort()).toEqual(['return', 'shop']);
    await expect(readFile(path.join(directory, 'invalid.bpmn'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
