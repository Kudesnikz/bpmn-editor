import BpmnModdle from 'bpmn-moddle';
import type { ValidationIssue, ValidationResult } from './types.js';
import { BPMN_NS, parseXml, walkXml } from './json-bpmn/xml.js';

const VISIBLE_SHAPE_TYPES = [
  /Event$/,
  /Task$/,
  /Gateway$/,
  /^bpmn:SubProcess$/,
  /^bpmn:CallActivity$/
];

function issue(code: string, message: string, elementId?: string): ValidationIssue {
  return elementId ? { code, message, elementId } : { code, message };
}

interface Point { x: number; y: number }
interface ShapeGeometry { id: string; type: string; plane: object; x: number; y: number; width: number; height: number }
interface EdgeGeometry { id: string; plane: object; points: Point[]; endpoints: Set<string> }

function isFinitePoint(value: any): value is Point {
  return Number.isFinite(value?.x) && Number.isFinite(value?.y);
}

function pointsEqual(left: Point, right: Point): boolean {
  return Math.abs(left.x - right.x) < 0.01 && Math.abs(left.y - right.y) < 0.01;
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsProperlyIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  if (pointsEqual(a, c) || pointsEqual(a, d) || pointsEqual(b, c) || pointsEqual(b, d)) return false;
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  return first * second < 0 && third * fourth < 0;
}

function shapesOverlap(left: ShapeGeometry, right: ShapeGeometry): boolean {
  const overlapX = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const overlapY = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return overlapX > 2 && overlapY > 2;
}

function isType(element: any, type: string): boolean {
  return element?.$type === type;
}

function collectFlowElements(container: any): any[] {
  const result: any[] = [];
  const pending = [...(container?.flowElements || [])];
  while (pending.length) {
    const element = pending.pop();
    result.push(element);
    if (element?.flowElements) pending.push(...element.flowElements);
  }
  return result;
}

function collectLanes(process: any): any[] {
  const lanes: any[] = [];
  const pending = (process?.laneSets || []).flatMap((set: any) => set.lanes || []);
  while (pending.length) {
    const lane = pending.pop();
    lanes.push(lane);
    pending.push(...(lane?.childLaneSet?.lanes || []));
  }
  return lanes;
}

function rootProcess(element: any): any | null {
  let current = element;
  while (current) {
    if (isType(current, 'bpmn:Process')) return current;
    current = current.$parent;
  }
  return null;
}

function visibleShape(element: any): boolean {
  const type = String(element?.$type || '');
  return VISIBLE_SHAPE_TYPES.some(pattern => pattern.test(type)) || Boolean(element?.$instanceOf?.('bpmn:Activity'))
    || ['bpmn:DataObjectReference', 'bpmn:DataStoreReference', 'bpmn:TextAnnotation', 'bpmn:Group'].includes(type);
}

function flowScope(element: any): any | null {
  let current = element?.$parent;
  while (current) {
    if (isType(current, 'bpmn:Process') || current.$instanceOf?.('bpmn:SubProcess')) return current;
    current = current.$parent;
  }
  return null;
}

export async function validateBpmn(xml: string, maxBytes: number): Promise<ValidationResult> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const byteLength = Buffer.byteLength(xml || '', 'utf8');

  if (!xml?.trim()) {
    return { valid: false, errors: [issue('EMPTY_XML', 'BPMN XML is empty')], warnings };
  }
  if (byteLength > maxBytes) {
    return {
      valid: false,
      errors: [issue('XML_TOO_LARGE', `BPMN XML exceeds the ${maxBytes} byte limit`)],
      warnings
    };
  }

  const idCounts = new Map<string, number>();
  try {
    const tree = parseXml(xml);
    walkXml(tree, node => {
      if (![BPMN_NS, 'http://www.omg.org/spec/BPMN/20100524/DI', 'http://www.omg.org/spec/DD/20100524/DC', 'http://www.omg.org/spec/DD/20100524/DI'].includes(node.name.uri)) return;
      const id = node.attributes.find(attribute => !attribute.uri && attribute.local === 'id')?.value;
      if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
    });
  } catch {
    return { valid: false, errors: [issue('INVALID_XML', 'XML syntax or processing limits are invalid')], warnings };
  }
  for (const [id, count] of idCounts) {
    if (count > 1) errors.push(issue('DUPLICATE_ID', `Duplicate BPMN id: ${id}`, id));
  }

  let definitions: any;
  try {
    const parsed = await new BpmnModdle().fromXML(xml);
    definitions = parsed.rootElement;
    for (const warning of parsed.warnings || []) {
      const message = warning?.message || String(warning);
      const brokenReference = /unresolved reference/i.test(message);
      const brokenStructure = /unparsable content|unknown type|property .* not found/i.test(message);
      const target = brokenReference || brokenStructure ? errors : warnings;
      target.push(issue(brokenReference ? 'BROKEN_REFERENCE' : brokenStructure ? 'INVALID_BPMN_STRUCTURE' : 'MODDLE_WARNING', message));
    }
  } catch (error) {
    errors.push(issue('INVALID_XML', 'Unable to parse BPMN XML'));
    return { valid: false, errors, warnings };
  }

  if (!isType(definitions, 'bpmn:Definitions')) {
    errors.push(issue('INVALID_ROOT', 'Root element must be bpmn:Definitions'));
    return { valid: false, errors, warnings };
  }

  const rootElements: any[] = definitions.rootElements || [];
  const processes = rootElements.filter(element => isType(element, 'bpmn:Process'));
  const collaborations = rootElements.filter(element => isType(element, 'bpmn:Collaboration'));
  if (!processes.length && !collaborations.length) {
    errors.push(issue('NO_PROCESS', 'Definitions must contain a process or collaboration'));
  }

  const diagrams: any[] = definitions.diagrams || [];
  if (!diagrams.length) {
    errors.push(issue('NO_BPMN_DIAGRAM', 'BPMNDiagram and BPMNPlane are required'));
  }

  const shapeIds = new Set<string>();
  const edgeIds = new Map<string, number>();
  const shapeGeometries: ShapeGeometry[] = [];
  const edgeGeometries: EdgeGeometry[] = [];
  for (const diagram of diagrams) {
    const plane = diagram?.plane;
    if (!plane) {
      errors.push(issue('NO_BPMN_PLANE', 'Every BPMNDiagram must contain a BPMNPlane', diagram?.id));
      continue;
    }
    if (!plane.bpmnElement) {
      errors.push(issue('BROKEN_PLANE_REFERENCE', 'BPMNPlane must reference a process or collaboration', plane?.id));
    } else if (!['bpmn:Process', 'bpmn:Collaboration'].includes(String(plane.bpmnElement.$type)) && !plane.bpmnElement.$instanceOf?.('bpmn:SubProcess')) {
      errors.push(issue('INVALID_PLANE_REFERENCE', 'BPMNPlane must reference a process, collaboration or subprocess', plane?.id));
    }
    for (const diElement of plane.planeElement || []) {
      const bpmnId = diElement?.bpmnElement?.id;
      if (!bpmnId) {
        errors.push(issue('BROKEN_DI_REFERENCE', 'BPMN DI element has no bpmnElement reference', diElement?.id));
        continue;
      }
      if (isType(diElement, 'bpmndi:BPMNShape')) {
        shapeIds.add(bpmnId);
        const bounds = diElement.bounds;
        if (!Number.isFinite(bounds?.x) || !Number.isFinite(bounds?.y) || !Number.isFinite(bounds?.width) || !Number.isFinite(bounds?.height) || bounds.width <= 0 || bounds.height <= 0) {
          errors.push(issue('INVALID_DI_BOUNDS', `BPMNShape for ${bpmnId} needs finite, positive bounds`, bpmnId));
        } else {
          shapeGeometries.push({ id: bpmnId, plane, type: String(diElement.bpmnElement.$type), x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
        }
      }
      if (isType(diElement, 'bpmndi:BPMNEdge')) {
        const points: any[] = diElement.waypoint || [];
        edgeIds.set(bpmnId, points.length);
        if (points.some(point => !isFinitePoint(point))) {
          errors.push(issue('INVALID_DI_WAYPOINT', `BPMNEdge for ${bpmnId} contains an invalid waypoint`, bpmnId));
        } else {
          const endpoints = new Set<string>([diElement.bpmnElement?.sourceRef?.id, diElement.bpmnElement?.targetRef?.id].filter(Boolean));
          edgeGeometries.push({ id: bpmnId, plane, points, endpoints });
          if (points.length < 2) errors.push(issue('MISSING_DI_EDGE', `Edge ${bpmnId} needs at least two waypoints`, bpmnId));
          if (points.some((point, index) => index > 0 && pointsEqual(points[index - 1]!, point))) {
            warnings.push(issue('DEGENERATE_EDGE', `BPMNEdge for ${bpmnId} contains repeated waypoints`, bpmnId));
          }
        }
      }
    }
  }

  const processById = new Map(processes.map(process => [process.id, process]));
  const participants: any[] = collaborations.flatMap(collaboration => collaboration.participants || []);
  const participantForProcess = new Map<string, any>();
  for (const participant of participants) {
    if (participant.processRef?.id) participantForProcess.set(participant.processRef.id, participant);
    if (!participant.name?.trim()) warnings.push(issue('MISSING_NAME', `Participant ${participant.id} has no name`, participant.id));
  }

  for (const process of processes) {
    if (!process.name?.trim()) warnings.push(issue('MISSING_NAME', `Process ${process.id} has no name`, process.id));
    const flowElements = collectFlowElements(process);
    for (const container of [process, ...flowElements.filter(element => element.$instanceOf?.('bpmn:SubProcess'))]) {
    for (const lane of collectLanes(container)) {
      if (!lane.name?.trim()) warnings.push(issue('MISSING_NAME', `Lane ${lane.id} has no name`, lane.id));
      for (const node of lane.flowNodeRef || []) if (!node.$instanceOf?.('bpmn:FlowNode') || flowScope(node) !== container) {
        errors.push(issue('INVALID_LANE_MEMBER', `Lane ${lane.id} references a node outside its flow scope`, lane.id));
      }
    }
    }

    for (const element of flowElements) {
      if (isType(element, 'bpmn:BoundaryEvent')) {
        const host = element.attachedToRef;
        if (!host?.$instanceOf?.('bpmn:Activity') || flowScope(host) !== flowScope(element)) errors.push(issue('INVALID_BOUNDARY_HOST', `Boundary event ${element.id} needs an activity in its own scope`, element.id));
        if ((element.incoming || []).length || flowElements.some(flow => isType(flow, 'bpmn:SequenceFlow') && flow.targetRef === element)) errors.push(issue('INVALID_BOUNDARY_INCOMING', `Boundary event ${element.id} cannot have incoming sequence flow`, element.id));
      }
      if ((/Task$/.test(element?.$type || '') || /Gateway$/.test(element?.$type || '')) && !element.name?.trim()) {
        warnings.push(issue('MISSING_NAME', `${element.$type} ${element.id} has no name`, element.id));
      }
      if (isType(element, 'bpmn:SequenceFlow')) {
        if (!element.sourceRef || !element.targetRef) {
          errors.push(issue('BROKEN_FLOW_REFERENCE', `SequenceFlow ${element.id} needs sourceRef and targetRef`, element.id));
        } else if (rootProcess(element.sourceRef)?.id !== rootProcess(element.targetRef)?.id) {
          errors.push(issue('SEQUENCE_FLOW_ACROSS_POOLS', `SequenceFlow ${element.id} crosses process boundaries`, element.id));
        } else if (flowScope(element) !== flowScope(element.sourceRef) || flowScope(element) !== flowScope(element.targetRef)) {
          errors.push(issue('SEQUENCE_FLOW_ACROSS_SCOPES', `SequenceFlow ${element.id} crosses a subprocess boundary`, element.id));
        } else if (!element.sourceRef.$instanceOf?.('bpmn:FlowNode') || !element.targetRef.$instanceOf?.('bpmn:FlowNode')) {
          errors.push(issue('BROKEN_FLOW_REFERENCE', `SequenceFlow ${element.id} endpoints must be flow nodes`, element.id));
        }
      }
    }
  }

  for (const collaboration of collaborations) {
    const localParticipants: any[] = collaboration.participants || [];
    for (const messageFlow of collaboration.messageFlows || []) {
      const waypointCount = edgeIds.get(messageFlow.id) || 0;
      if (waypointCount < 2) {
        errors.push(issue('MISSING_DI_EDGE', `MessageFlow ${messageFlow.id} needs a BPMNEdge with at least two waypoints`, messageFlow.id));
      }
      if (!messageFlow.sourceRef || !messageFlow.targetRef) {
        errors.push(issue('BROKEN_FLOW_REFERENCE', `MessageFlow ${messageFlow.id} needs sourceRef and targetRef`, messageFlow.id));
        continue;
      }
      const participantFor = (endpoint: any) => {
        if (isType(endpoint, 'bpmn:Participant')) return localParticipants.includes(endpoint) ? endpoint : undefined;
        const process = rootProcess(endpoint);
        return process ? localParticipants.find(participant => participant.processRef === process) : undefined;
      };
      const sourceParticipant = participantFor(messageFlow.sourceRef);
      const targetParticipant = participantFor(messageFlow.targetRef);
      if (!sourceParticipant || !targetParticipant || sourceParticipant.id === targetParticipant.id) {
        errors.push(issue('INVALID_MESSAGE_FLOW', `MessageFlow ${messageFlow.id} must connect distinct participants`, messageFlow.id));
      }
    }
  }

  // A shape in another plane cannot satisfy this plane's requirements. Collapsed
  // subprocess internals are intentionally absent unless opened in a separate plane.
  const covered = new Set<any>();
  for (const diagram of diagrams) {
    const plane = diagram.plane;
    if (!plane?.bpmnElement) continue;
    const shapes = new Map<any, any>();
    const edges = new Map<any, any>();
    for (const item of plane.planeElement || []) {
      const map = isType(item, 'bpmndi:BPMNShape') ? shapes : edges;
      if (map.has(item.bpmnElement)) errors.push(issue('DUPLICATE_DI_ELEMENT', 'Element has multiple representations in one plane', item.bpmnElement?.id));
      map.set(item.bpmnElement, item);
    }
    const requireShape = (element: any) => {
      if (!shapes.has(element)) errors.push(issue('MISSING_DI_SHAPE', `Element ${element.id} needs a shape in plane ${plane.id || diagram.id}`, element.id));
    };
    const requireEdge = (element: any) => {
      if ((edges.get(element)?.waypoint?.length || 0) < 2) errors.push(issue('MISSING_DI_EDGE', `Flow ${element.id} needs an edge in plane ${plane.id || diagram.id}`, element.id));
    };
    const root = plane.bpmnElement;
    covered.add(root);
    const containers: any[] = [];
    if (isType(root, 'bpmn:Collaboration')) {
      for (const participant of root.participants || []) {
        requireShape(participant);
        if (participant.processRef) { containers.push(participant.processRef); covered.add(participant.processRef); }
      }
      for (const flow of root.messageFlows || []) requireEdge(flow);
    } else containers.push(root);
    while (containers.length) {
      const container = containers.pop();
      for (const lane of collectLanes(container)) requireShape(lane);
      for (const element of [...(container.flowElements || []), ...(container.artifacts || [])]) {
        if (visibleShape(element)) requireShape(element);
        if (isType(element, 'bpmn:SequenceFlow') || isType(element, 'bpmn:Association')) requireEdge(element);
        if (element.$instanceOf?.('bpmn:SubProcess') && shapes.get(element)?.isExpanded === true) containers.push(element);
      }
    }
  }
  for (const root of [...processes, ...collaborations]) if (!covered.has(root)) errors.push(issue('MISSING_DI_PLANE', `Root ${root.id} is not represented by any BPMN plane`, root.id));

  for (const participant of participants) {
    if (participant.processRef?.id && !processById.has(participant.processRef.id)) {
      errors.push(issue('BROKEN_PROCESS_REFERENCE', `Participant ${participant.id} references an unknown process`, participant.id));
    }
  }

  const overlapCandidates = shapeGeometries.filter(shape => /(?:Event|Task|Gateway)$/.test(shape.type) && shape.type !== 'bpmn:BoundaryEvent');
  for (let leftIndex = 0; leftIndex < overlapCandidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < overlapCandidates.length; rightIndex += 1) {
      const left = overlapCandidates[leftIndex]!;
      const right = overlapCandidates[rightIndex]!;
      if (left.plane === right.plane && shapesOverlap(left, right)) {
        warnings.push(issue('OVERLAPPING_SHAPES', `Shapes ${left.id} and ${right.id} overlap`, left.id));
      }
    }
  }

  let crossingWarnings = 0;
  for (let leftIndex = 0; leftIndex < edgeGeometries.length && crossingWarnings < 50; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < edgeGeometries.length && crossingWarnings < 50; rightIndex += 1) {
      const left = edgeGeometries[leftIndex]!;
      const right = edgeGeometries[rightIndex]!;
      if (left.plane !== right.plane) continue;
      if ([...left.endpoints].some(endpoint => right.endpoints.has(endpoint))) continue;
      const crosses = left.points.slice(1).some((point, segmentIndex) =>
        right.points.slice(1).some((otherPoint, otherSegmentIndex) =>
          segmentsProperlyIntersect(left.points[segmentIndex]!, point, right.points[otherSegmentIndex]!, otherPoint)
        )
      );
      if (crosses) {
        warnings.push(issue('POTENTIAL_EDGE_CROSSING', `Edges ${left.id} and ${right.id} cross`, left.id));
        crossingWarnings += 1;
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
