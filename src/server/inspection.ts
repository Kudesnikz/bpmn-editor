import BpmnModdle from 'bpmn-moddle';
import type {
  DiagramInspection,
  InspectedCollaboration,
  InspectedElement,
  InspectedFlow,
  InspectedLane,
  InspectedProcess
} from './types.js';
import { validateBpmn } from './validation.js';

function compactType(value: unknown): string {
  return String(value || '').replace(/^bpmn:/, '');
}

function optionalName(value: unknown): { name?: string } {
  const name = typeof value === 'string' ? value.trim() : '';
  return name ? { name } : {};
}

function elementSummary(element: any): InspectedElement {
  return { id: String(element?.id || ''), type: compactType(element?.$type), ...optionalName(element?.name) };
}

function flowSummary(flow: any): InspectedFlow {
  return {
    ...elementSummary(flow),
    ...(flow?.sourceRef?.id ? { sourceId: String(flow.sourceRef.id) } : {}),
    ...(flow?.targetRef?.id ? { targetId: String(flow.targetRef.id) } : {})
  };
}

function collectFlowElements(container: any): any[] {
  const result: any[] = [];
  for (const element of container?.flowElements || []) {
    result.push(element);
    if (element?.flowElements) result.push(...collectFlowElements(element));
  }
  return result;
}

function collectLanes(process: any): InspectedLane[] {
  const lanes: InspectedLane[] = [];
  const visit = (lane: any) => {
    lanes.push({
      ...elementSummary(lane),
      flowNodeIds: (lane?.flowNodeRef || []).map((node: any) => String(node?.id || '')).filter(Boolean)
    });
    for (const child of lane?.childLaneSet?.lanes || []) visit(child);
  };
  for (const laneSet of process?.laneSets || []) {
    for (const lane of laneSet?.lanes || []) visit(lane);
  }
  return lanes;
}

function isStructuralElement(element: any): boolean {
  const type = String(element?.$type || '');
  return /Event$|Task$|Gateway$|^bpmn:SubProcess$|^bpmn:CallActivity$/.test(type);
}

function isDiShape(element: any): boolean {
  return element?.$type === 'bpmndi:BPMNShape';
}

function isDiEdge(element: any): boolean {
  return element?.$type === 'bpmndi:BPMNEdge';
}

export async function inspectBpmn(xml: string, maxBytes: number): Promise<DiagramInspection> {
  const validation = await validateBpmn(xml, maxBytes);
  const empty = {
    statistics: {
      processes: 0,
      collaborations: 0,
      participants: 0,
      lanes: 0,
      events: 0,
      tasks: 0,
      gateways: 0,
      subprocesses: 0,
      sequenceFlows: 0,
      messageFlows: 0
    },
    di: { diagramCount: 0, planeCount: 0, shapeCount: 0, edgeCount: 0, complete: false },
    processes: [] as InspectedProcess[],
    collaborations: [] as InspectedCollaboration[],
    validation
  };

  let definitions: any;
  try {
    ({ rootElement: definitions } = await new BpmnModdle().fromXML(xml));
  } catch {
    return empty;
  }

  const rootElements: any[] = definitions?.rootElements || [];
  const rawProcesses = rootElements.filter(element => element?.$type === 'bpmn:Process');
  const rawCollaborations = rootElements.filter(element => element?.$type === 'bpmn:Collaboration');
  const allFlowElements = rawProcesses.flatMap(collectFlowElements);
  const lanes = rawProcesses.flatMap(collectLanes);

  const processes: InspectedProcess[] = rawProcesses.map(process => {
    const flowElements = collectFlowElements(process);
    return {
      ...elementSummary(process),
      isExecutable: Boolean(process?.isExecutable),
      lanes: collectLanes(process),
      elements: flowElements.filter(isStructuralElement).map(elementSummary),
      sequenceFlows: flowElements.filter(element => element?.$type === 'bpmn:SequenceFlow').map(flowSummary)
    };
  });

  const collaborations: InspectedCollaboration[] = rawCollaborations.map(collaboration => ({
    ...elementSummary(collaboration),
    participants: (collaboration?.participants || []).map((participant: any) => ({
      ...elementSummary(participant),
      ...(participant?.processRef?.id ? { processId: String(participant.processRef.id) } : {})
    })),
    messageFlows: (collaboration?.messageFlows || []).map(flowSummary)
  }));

  const diagrams: any[] = definitions?.diagrams || [];
  const planes = diagrams.map(diagram => diagram?.plane).filter(Boolean);
  const diElements = planes.flatMap(plane => plane?.planeElement || []);
  const diErrorCodes = new Set([
    'NO_BPMN_DIAGRAM',
    'NO_BPMN_PLANE',
    'BROKEN_PLANE_REFERENCE',
    'INVALID_PLANE_REFERENCE',
    'BROKEN_DI_REFERENCE',
    'INVALID_DI_BOUNDS',
    'INVALID_DI_WAYPOINT',
    'MISSING_DI_SHAPE',
    'MISSING_DI_EDGE'
  ]);

  return {
    statistics: {
      processes: processes.length,
      collaborations: collaborations.length,
      participants: collaborations.reduce((count, collaboration) => count + collaboration.participants.length, 0),
      lanes: lanes.length,
      events: allFlowElements.filter(element => /Event$/.test(String(element?.$type || ''))).length,
      tasks: allFlowElements.filter(element => /Task$/.test(String(element?.$type || ''))).length,
      gateways: allFlowElements.filter(element => /Gateway$/.test(String(element?.$type || ''))).length,
      subprocesses: allFlowElements.filter(element => element?.$type === 'bpmn:SubProcess').length,
      sequenceFlows: allFlowElements.filter(element => element?.$type === 'bpmn:SequenceFlow').length,
      messageFlows: collaborations.reduce((count, collaboration) => count + collaboration.messageFlows.length, 0)
    },
    di: {
      diagramCount: diagrams.length,
      planeCount: planes.length,
      shapeCount: diElements.filter(isDiShape).length,
      edgeCount: diElements.filter(isDiEdge).length,
      complete: validation.errors.every(error => !diErrorCodes.has(error.code))
    },
    processes,
    collaborations,
    validation
  };
}
