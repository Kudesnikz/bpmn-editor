import { describe, expect, it } from 'vitest';
import { validateBpmn } from '../src/server/validation.js';
import { documentToXml, xmlToDocument } from '../src/server/json-bpmn/codec.js';
import { renderXml } from '../src/server/json-bpmn/xml.js';

const shape = (id: string, extra = '', suffix = '') => `<bpmndi:BPMNShape id="${id}_di${suffix}" bpmnElement="${id}" ${extra}><dc:Bounds x="100" y="100" width="100" height="80"/></bpmndi:BPMNShape>`;
const edge = (id: string) => `<bpmndi:BPMNEdge id="${id}_di" bpmnElement="${id}"><di:waypoint x="100" y="100"/><di:waypoint x="200" y="100"/></bpmndi:BPMNEdge>`;
const plane = (id: string, root: string, content: string) => `<bpmndi:BPMNDiagram id="Diagram_${id}"><bpmndi:BPMNPlane id="Plane_${id}" bpmnElement="${root}">${content}</bpmndi:BPMNPlane></bpmndi:BPMNDiagram>`;
const xml = (semantic: string, di: string) => `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="D" targetNamespace="urn:test">${semantic}${di}</bpmn:definitions>`;
const errors = async (source: string) => (await validateBpmn(source, 2097152)).errors.map(error => error.code);

describe('BPMN scope and per-plane validation', () => {
  const subprocess = '<bpmn:process id="P"><bpmn:subProcess id="Sub"><bpmn:startEvent id="Inner"/></bpmn:subProcess></bpmn:process>';
  it('allows hidden subprocess internals and a separate subprocess plane', async () => {
    const collapsed = xml(subprocess, plane('main', 'P', shape('Sub', 'isExpanded="false"')));
    expect(await errors(collapsed)).toEqual([]);
    const ownPlane = xml(subprocess, plane('main', 'P', shape('Sub', 'isExpanded="false"')) + plane('sub', 'Sub', shape('Inner')));
    expect(await errors(ownPlane)).toEqual([]);
    const document = await xmlToDocument(ownPlane);
    expect(document.elements.Plane_sub?.properties.bpmnElement).toBe('Sub');
    expect(await errors(await documentToXml(document))).toEqual([]);
  });
  it('requires expanded subprocess children in that plane, not a different one', async () => {
    const missing = xml(subprocess, plane('main', 'P', shape('Sub', 'isExpanded="true"')) + plane('sub', 'Sub', shape('Inner')));
    expect(await errors(missing)).toContain('MISSING_DI_SHAPE');
    const complete = xml(subprocess, plane('main', 'P', shape('Sub', 'isExpanded="true"') + shape('Inner', '', '_main')) + plane('sub', 'Sub', shape('Inner')));
    expect(await errors(complete)).toEqual([]);
  });
  it('rejects sequence flow crossing a subprocess boundary within the same process', async () => {
    const semantic = '<bpmn:process id="P"><bpmn:task id="Outer"/><bpmn:subProcess id="Sub"><bpmn:task id="Inner"/></bpmn:subProcess><bpmn:sequenceFlow id="F" sourceRef="Outer" targetRef="Inner"/></bpmn:process>';
    expect(await errors(xml(semantic, plane('main', 'P', shape('Outer') + shape('Sub', 'isExpanded="true"') + shape('Inner') + edge('F'))))).toContain('SEQUENCE_FLOW_ACROSS_SCOPES');
  });
  it('requires boundary events to attach to activities in the same scope', async () => {
    const semantic = '<bpmn:process id="P"><bpmn:task id="Outer"/><bpmn:subProcess id="Sub"><bpmn:boundaryEvent id="Boundary" attachedToRef="Outer"><bpmn:timerEventDefinition/></bpmn:boundaryEvent></bpmn:subProcess></bpmn:process>';
    expect(await errors(xml(semantic, plane('main', 'P', shape('Outer') + shape('Sub'))))).toContain('INVALID_BOUNDARY_HOST');
  });
  it('rejects lane references outside their subprocess scope', async () => {
    const semantic = '<bpmn:process id="P"><bpmn:laneSet id="LS"><bpmn:lane id="Lane"><bpmn:flowNodeRef>Inner</bpmn:flowNodeRef></bpmn:lane></bpmn:laneSet><bpmn:subProcess id="Sub"><bpmn:task id="Inner"/></bpmn:subProcess></bpmn:process>';
    expect(await errors(xml(semantic, plane('main', 'P', shape('Lane') + shape('Sub'))))).toContain('INVALID_LANE_MEMBER');
  });
  it('does not count ID text in comments or attributes as duplicate XML IDs', async () => {
    const source = xml('<!-- id="Start" --><bpmn:process id="P"><bpmn:startEvent id="Start" name="literal id=&quot;Start&quot;"/></bpmn:process>', plane('main', 'P', shape('Start')));
    expect(await errors(source)).toEqual([]);
  });
  it('rejects hostile namespace/name fields before XML rendering', () => {
    expect(() => renderXml({ name: { uri: 'urn:vendor', prefix: 'v', local: 'node x="injected"' }, namespaces: { v: 'urn:vendor' }, attributes: [], children: [] })).toThrow(/Invalid XML name/);
    expect(() => renderXml({ name: { uri: 'urn:vendor', prefix: 'v', local: 'node' }, namespaces: { 'x="bad"': 'urn:bad' }, attributes: [], children: [] })).toThrow(/Invalid namespace/);
  });
});
