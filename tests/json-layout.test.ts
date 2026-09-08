import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { documentFingerprint, documentToXml, xmlToDocument } from '../src/server/json-bpmn/codec.js';
import { semanticDocument } from '../src/server/json-bpmn/graph.js';
import { autoLayout, preserveLayout } from '../src/server/json-bpmn/layout.js';
import { applyOperations } from '../src/server/json-bpmn/operations.js';
import { validateBpmn } from '../src/server/validation.js';
import { createBlankBpmn } from '../src/server/storage.js';
import { executeJsonJob } from '../src/server/json-bpmn/jobs.js';

describe('BPMN JSON geometry', () => {
  it('relayouts one independent process while retaining the other plane exactly', async () => {
    const left = await xmlToDocument(createBlankBpmn('left', 'Left'));
    const right = await xmlToDocument(createBlankBpmn('right', 'Right'));
    const root = left.elements[left.rootId]!;
    const rightRoot = right.elements[right.rootId]!;
    for (const [id, entry] of Object.entries(right.elements)) if (id !== right.rootId) left.elements[id] = structuredClone(entry);
    root.properties.rootElements.push(...rightRoot.properties.rootElements);
    root.properties.diagrams.push(...rightRoot.properties.diagrams);
    const before = structuredClone(left);
    const output = await autoLayout(left, ['Process_left']);
    for (const [id, entry] of Object.entries(right.elements)) if (id !== right.rootId) expect(output.elements[id], id).toEqual(entry);
    expect(left).toEqual(before);
    expect(documentFingerprint(semanticDocument(output))).toBe(documentFingerprint(semanticDocument(before)));
    expect((await validateBpmn(await documentToXml(output), 2097152)).errors).toEqual([]);
  });

  it('rejects an auto-layout scope that excludes the changed process', async () => {
    const xml = createBlankBpmn('scope', 'Scope');
    await expect(executeJsonJob({ kind: 'prepare', xml, operations: [{ op: 'add_element', element_id: 'Task_Added', element: { type: 'bpmn:Task', properties: { name: 'Added' } }, parent_id: 'Process_scope', property: 'flowElements' }], layoutMode: 'auto', scopeIds: ['Another_Process'], maxBytes: 2097152 })).rejects.toMatchObject({ code: 'INVALID_LAYOUT_SCOPE' });
  });

  it('lays out boundary timer semantics without changing attachment or timer expression', async () => {
    const document = semanticDocument(await xmlToDocument(createBlankBpmn('timer', 'Timer')));
    Object.assign(document.elements, {
      Task_Wait: { type: 'bpmn:UserTask', properties: { name: 'Wait for approval' } },
      Timer: { type: 'bpmn:BoundaryEvent', properties: { attachedToRef: 'Task_Wait', cancelActivity: true, eventDefinitions: [{ type: 'bpmn:TimerEventDefinition', properties: { timeDuration: { type: 'bpmn:FormalExpression', properties: { body: 'PT1H' } } } }] } },
      End: { type: 'bpmn:EndEvent', properties: {} },
      Flow_Start: { type: 'bpmn:SequenceFlow', properties: { sourceRef: 'StartEvent_timer', targetRef: 'Task_Wait' } },
      Flow_End: { type: 'bpmn:SequenceFlow', properties: { sourceRef: 'Task_Wait', targetRef: 'End' } },
      Flow_Timeout: { type: 'bpmn:SequenceFlow', properties: { sourceRef: 'Timer', targetRef: 'End' } }
    });
    document.elements.Process_timer!.properties.flowElements.push('Task_Wait', 'Timer', 'End', 'Flow_Start', 'Flow_End', 'Flow_Timeout');
    const roundtrip = await xmlToDocument(await documentToXml(document, false), false);
    for (const [id, entry] of Object.entries(document.elements)) expect(documentFingerprint({ ...document, elements: { [id]: roundtrip.elements[id]! } }), id).toBe(documentFingerprint({ ...document, elements: { [id]: entry } }));
    const output = await autoLayout(document);
    expect(documentFingerprint(semanticDocument(output))).toBe(documentFingerprint(document));
    expect((await validateBpmn(await documentToXml(output), 2097152)).errors).toEqual([]);
  });
  it('generates complete DI for a semantic collaboration without changing semantics', async () => {
    const input = semanticDocument(await xmlToDocument(await readFile('diagrams/shop.bpmn', 'utf8')));
    const output = await autoLayout(input);
    expect(documentFingerprint(semanticDocument(output))).toBe(documentFingerprint(input));
    expect((await validateBpmn(await documentToXml(output), 2 * 1024 * 1024)).errors).toEqual([]);
  });

  it('locally inserts a task without moving any existing shape', async () => {
    const input = await xmlToDocument(await readFile('diagrams/shop.bpmn', 'utf8'));
    const changes = applyOperations(input, [{ op: 'insert_task_on_flow', flow_id: 'Flow_1', task: { id: 'Task_New', type: 'bpmn:Task', name: 'New task' }, new_flow_id: 'Flow_New' }]);
    const output = preserveLayout(changes);
    for (const [id, element] of Object.entries(input.elements)) if (element.type === 'bpmndi:BPMNShape') expect(output.elements[id]).toEqual(element);
    expect(output.elements.Task_New_di).toBeDefined();
    expect(output.elements.Flow_New_di).toBeDefined();
    expect((await validateBpmn(await documentToXml(output), 2 * 1024 * 1024)).errors).toEqual([]);
  });

  it('requires explicit relayout when a container has no room', async () => {
    const input = await xmlToDocument(await readFile('diagrams/shop.bpmn', 'utf8'));
    input.elements.Lane_Buyer_di!.properties.bounds.properties.height = 30;
    const changes = applyOperations(input, [{ op: 'insert_task_on_flow', flow_id: 'Flow_1', task: { id: 'Task_New', type: 'bpmn:Task', name: 'New task' }, new_flow_id: 'Flow_New' }]);
    expect(() => preserveLayout(changes)).toThrow(/No free space/);
    expect(input.elements.Task_New).toBeUndefined();
  });
});
