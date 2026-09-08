import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import BpmnModdle from 'bpmn-moddle';
import { describe, expect, it } from 'vitest';
import { describeTypes, documentFingerprint, documentToXml, xmlToDocument } from '../src/server/json-bpmn/codec.js';
import { createBlankBpmn } from '../src/server/storage.js';
import { ownership } from '../src/server/json-bpmn/graph.js';
import { applyOperations } from '../src/server/json-bpmn/operations.js';
import { projectDocument } from '../src/server/json-bpmn/projection.js';
import { xmlFingerprint, parseXml } from '../src/server/json-bpmn/xml.js';

describe('loss checked BPMN JSON codec', () => {
  it.each(readdirSync('diagrams').filter(name => name.endsWith('.bpmn')))('round-trips %s with all non-enumerable references', async file => {
      const xml = await readFile(path.join('diagrams', file), 'utf8');
      const document = await xmlToDocument(xml, false);
      const restoredXml = await documentToXml(document);
      expect(xmlFingerprint(parseXml(restoredXml)), file).toBe(xmlFingerprint(parseXml(xml)));
      await xmlToDocument(xml);
      expect(documentFingerprint(await xmlToDocument(restoredXml)), file).toBe(documentFingerprint(document));
  });

  it('retains actual flow, process, lane and DI targets in shop', async () => {
    const document = await xmlToDocument(await readFile('diagrams/shop.bpmn', 'utf8'));
    expect(document.elements.Flow_1?.properties).toMatchObject({ sourceRef: 'StartEvent_Enter', targetRef: 'Task_EnterStore' });
    expect(document.elements.Participant_Store?.properties.processRef).toBe('Process_StorePurchase');
    expect(document.elements.Flow_1_di?.properties.bpmnElement).toBe('Flow_1');
    const { rootElement } = await new BpmnModdle().fromXML(await documentToXml(document));
    const process = rootElement.rootElements.find((e: any) => e.id === 'Process_StorePurchase');
    const flow = process.flowElements.find((e: any) => e.id === 'Flow_1');
    expect(flow.sourceRef.id).toBe('StartEvent_Enter');
    expect(flow.targetRef.id).toBe('Task_EnterStore');
  });

  it('retains and edits foreign mixed content and scoped namespaces', async () => {
    const xml = `<b:definitions xmlns:b="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="urn:test">
      <b:process id="P"><b:extensionElements><v:config xmlns:v="urn:vendor" v:mode="v:advanced">before<v:child xmlns:v="urn:child">inside</v:child>after</v:config></b:extensionElements></b:process>
    </b:definitions>`;
    const document = await xmlToDocument(xml);
    const extension = document.elements.P!.properties.extensionElements;
    expect(extension.extensions[0].children[0]).toBe('before');
    expect(xmlFingerprint(parseXml(await documentToXml(document)))).toBe(xmlFingerprint(parseXml(xml)));
    extension.extensions[0].children[0] = 'changed';
    const result = await documentToXml(document);
    expect(result).toContain('changed');
    expect(result).toContain('urn:child');
    expect((await xmlToDocument(result)).elements.P!.properties.extensionElements.extensions[0].children.at(-1)).toBe('after');
  });

  it('fails closed on broken references, unsafe keys and unknown properties', async () => {
    const document = await xmlToDocument(await readFile('diagrams/shop.bpmn', 'utf8'));
    const broken = structuredClone(document);
    broken.elements.Flow_1!.properties.targetRef = 'missing';
    await expect(documentToXml(broken)).rejects.toMatchObject({ code: 'BROKEN_JSON_REFERENCE' });
    const invalid = structuredClone(document);
    invalid.elements.Flow_1!.properties.unknown = 'x';
    await expect(documentToXml(invalid)).rejects.toMatchObject({ code: 'UNKNOWN_PROPERTY' });
    await expect(documentToXml(JSON.parse('{"__proto__":{}}'))).rejects.toMatchObject({ code: 'INVALID_BPMN_JSON' });
    await expect(xmlToDocument('<!DOCTYPE x><x/>')).rejects.toMatchObject({ code: 'UNSUPPORTED_XML_CONTENT' });
  });

  it('distinguishes explicit non-default BPMN values from omitted defaults', async () => {
    const document = await xmlToDocument(await readFile('diagrams/shop.bpmn', 'utf8'));
    const processId = Object.keys(document.elements).find(id => document.elements[id]!.type === 'bpmn:Process')!;
    const explicitFalse = structuredClone(document);
    explicitFalse.elements[processId]!.properties.isExecutable = false;
    const explicitTrue = structuredClone(document);
    explicitTrue.elements[processId]!.properties.isExecutable = true;
    expect(documentFingerprint(explicitFalse)).not.toBe(documentFingerprint(explicitTrue));
    const restored = await xmlToDocument(await documentToXml(explicitTrue));
    expect(restored.elements[processId]!.properties.isExecutable).toBe(true);
  });

  it('round-trips BPMN enums as scalars, without treating repeated values as containment IDs', async () => {
    const document = await xmlToDocument(createBlankBpmn('enum', 'Enums'));
    document.elements.Process_enum!.properties.processType = 'Public';
    for (const id of ['Gateway_A', 'Gateway_B']) document.elements[id] = { type: 'bpmn:ExclusiveGateway', properties: { gatewayDirection: 'Diverging' } };
    document.elements.Diverging = { type: 'bpmn:Task', properties: { name: 'Literal ID collision' } };
    document.elements.Process_enum!.properties.flowElements.push('Gateway_A', 'Gateway_B', 'Diverging');
    expect(ownership(document).get('Diverging')?.ownerId).toBe('Process_enum');
    const restored = await xmlToDocument(await documentToXml(document));
    expect(restored.elements.Process_enum!.properties.processType).toBe('Public');
    expect(restored.elements.Gateway_A!.properties.gatewayDirection).toBe('Diverging');
    const fragment = projectDocument(restored, 'r', { scope: 'fragment', selector: { element_ids: ['Gateway_A'], neighbor_depth: 0 } });
    expect(fragment.externalReferenceIds).not.toContain('Diverging');
    const removed = applyOperations(restored, [{ op: 'remove_element', element_id: 'Diverging' }]);
    expect(removed.document.elements.Gateway_A!.properties.gatewayDirection).toBe('Diverging');
    const changed = applyOperations(removed.document, [{ op: 'update_properties', element_id: 'Gateway_A', set: { gatewayDirection: 'Converging' } }]);
    await documentToXml(changed.document);
    changed.document.elements.Gateway_A!.properties.gatewayDirection = 'NotADirection';
    await expect(documentToXml(changed.document)).rejects.toMatchObject({ code: 'INVALID_BPMN_JSON', details: { property: 'gatewayDirection' } });
    expect(describeTypes(['bpmn:GatewayDirection'])).toEqual([{ type: 'bpmn:GatewayDirection', kind: 'enum', values: ['Unspecified', 'Converging', 'Diverging', 'Mixed'] }]);
  });
});
