import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { documentToXml, xmlToDocument } from '../src/server/json-bpmn/codec.js';
import { applyOperations } from '../src/server/json-bpmn/operations.js';
import { projectDocument } from '../src/server/json-bpmn/projection.js';

const shop = async () => xmlToDocument(await readFile('diagrams/shop.bpmn', 'utf8'));

describe('BPMN JSON operations and bounded reading', () => {
  it('renames without touching DI or mutating the original snapshot', async () => {
    const original = await shop();
    const result = applyOperations(original, [{ op: 'update_properties', element_id: 'Task_Pay', set: { name: 'Оплатить картой' } }]);
    expect(original.elements.Task_Pay!.properties.name).not.toBe('Оплатить картой');
    expect(result.document.elements.Task_Pay!.properties.name).toBe('Оплатить картой');
    for (const [id, element] of Object.entries(original.elements)) if (element.type.startsWith('bpmndi:')) expect(result.document.elements[id]).toEqual(element);
    await documentToXml(result.document);
  });

  it('inserts a task preserving original flow ID and wiring incoming/outgoing', async () => {
    const original = await shop();
    const result = applyOperations(original, [{ op: 'insert_task_on_flow', flow_id: 'Flow_1', task: { id: 'Task_Notify', type: 'bpmn:SendTask', name: 'Notify' }, new_flow_id: 'Flow_Notify' }]);
    expect(result.document.elements.Flow_1!.properties).toMatchObject({ sourceRef: 'StartEvent_Enter', targetRef: 'Task_Notify' });
    expect(result.document.elements.Flow_Notify!.properties).toMatchObject({ sourceRef: 'Task_Notify', targetRef: 'Task_EnterStore' });
    expect(result.document.elements.Task_Notify!.properties).toMatchObject({ incoming: ['Flow_1'], outgoing: ['Flow_Notify'] });
    await documentToXml(result.document);
  });

  it('requires cascade and cleans only connected flows and DI', async () => {
    const original = await shop();
    expect(() => applyOperations(original, [{ op: 'remove_element', element_id: 'Task_Pay' }])).toThrow(/References exist/);
    const { document } = applyOperations(original, [{ op: 'remove_element', element_id: 'Task_Pay', cascade: true }]);
    expect(document.elements.Task_Pay).toBeUndefined();
    expect(document.elements.Task_Pay_di).toBeUndefined();
    expect(document.elements.Flow_5).toBeUndefined();
    expect(document.elements.Flow_6).toBeUndefined();
    expect(document.elements.Task_ScanProduct).toBeDefined();
    expect(document.elements.Task_ExitCheck).toBeDefined();
    await documentToXml(document);
  });

  it('reports the failed operation without partially modifying its input', async () => {
    const original = await shop();
    const copy = structuredClone(original);
    expect(() => applyOperations(original, [
      { op: 'update_properties', element_id: 'Task_Pay', set: { name: 'changed' } },
      { op: 'remove_element', element_id: 'missing' }
    ])).toThrow();
    expect(original).toEqual(copy);
  });

  it('preserves literal text matching a deleted ID and reports changed containing elements', async () => {
    const original = await shop();
    original.elements.Task_ScanProduct!.properties.name = 'Task_Pay';
    original.elements.Task_ScanProduct!.properties.documentation = [{ type: 'bpmn:Documentation', properties: { text: 'Flow_5' } }];
    const result = applyOperations(original, [{ op: 'remove_element', element_id: 'Task_Pay', cascade: true }]);
    expect(result.document.elements.Task_ScanProduct!.properties.name).toBe('Task_Pay');
    expect(result.document.elements.Task_ScanProduct!.properties.documentation[0].properties.text).toBe('Flow_5');
    expect(result.changedIds).toContain('Process_StorePurchase');
    expect(result.removedIds).toContain('Task_Pay');
    await documentToXml(result.document);
  });

  it('returns a fragment without expanding every sibling of its parents', async () => {
    const result = projectDocument(await shop(), 'revision1', { scope: 'fragment', selector: { element_ids: ['Task_Pay'], neighbor_depth: 0 } });
    expect(Object.keys(result.document!.elements)).toEqual(['Task_Pay']);
    expect(result.parents!.some(parent => parent.id === 'Process_StorePurchase')).toBe(true);
    expect(result.externalReferenceIds).toContain('Flow_5');
    expect(JSON.stringify(result)).not.toContain('bpmndi:');
  });

  it('paginates deterministic selections and rejects a changed revision', async () => {
    const document = await shop();
    const first = projectDocument(document, 'revision1', { scope: 'full', limit: 5 });
    const second = projectDocument(document, 'revision1', { scope: 'full', limit: 5, cursor: first.nextCursor });
    expect(first.complete).toBe(false);
    expect(Object.keys(first.document!.elements)).toHaveLength(5);
    expect(Object.keys(second.document!.elements).some(id => first.document!.elements[id])).toBe(false);
    expect(() => projectDocument(document, 'revision2', { scope: 'full', limit: 5, cursor: first.nextCursor })).toThrow(/changed/);
  });
});
