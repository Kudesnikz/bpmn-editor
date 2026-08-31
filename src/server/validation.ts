import BpmnModdle from 'bpmn-moddle';
import type { ValidationIssue, ValidationResult } from './types.js';

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
interface ShapeGeometry { id: string; type: string; x: number; y: number; width: number; height: number }
interface EdgeGeometry { id: string; points: Point[]; endpoints: Set<string> }

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
  for (const element of container?.flowElements || []) {
    result.push(element);
    if (element?.flowElements) result.push(...collectFlowElements(element));
  }
  return result;
}

function collectLanes(process: any): any[] {
  const lanes: any[] = [];
  const visit = (lane: any) => {
    lanes.push(lane);
    for (const childSet of lane?.childLaneSet ? [lane.childLaneSet] : []) {
      for (const child of childSet?.lanes || []) visit(child);
    }
  };
  for (const laneSet of process?.laneSets || []) {
    for (const lane of laneSet?.lanes || []) visit(lane);
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
  return VISIBLE_SHAPE_TYPES.some(pattern => pattern.test(type));
}

function extractXmlIds(xml: string): string[] {
  const ids: string[] = [];
  const idPattern = /\bid\s*=\s*(["'])(.*?)\1/g;
  for (const match of xml.matchAll(idPattern)) {
    if (match[2]) ids.push(match[2]);
  }
  return ids;
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
  for (const id of extractXmlIds(xml)) idCounts.set(id, (idCounts.get(id) || 0) + 1);
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
    const message = error instanceof Error ? error.message : String(error);
    errors.push(issue('INVALID_XML', `Unable to parse BPMN XML: ${message}`));
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
    } else if (!['bpmn:Process', 'bpmn:Collaboration'].includes(String(plane.bpmnElement.$type))) {
      errors.push(issue('INVALID_PLANE_REFERENCE', 'BPMNPlane must reference a process or collaboration', plane?.id));
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
          shapeGeometries.push({ id: bpmnId, type: String(diElement.bpmnElement.$type), x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
        }
      }
      if (isType(diElement, 'bpmndi:BPMNEdge')) {
        const points: any[] = diElement.waypoint || [];
        edgeIds.set(bpmnId, points.length);
        if (points.some(point => !isFinitePoint(point))) {
          errors.push(issue('INVALID_DI_WAYPOINT', `BPMNEdge for ${bpmnId} contains an invalid waypoint`, bpmnId));
        } else {
          const endpoints = new Set<string>([diElement.bpmnElement?.sourceRef?.id, diElement.bpmnElement?.targetRef?.id].filter(Boolean));
          edgeGeometries.push({ id: bpmnId, points, endpoints });
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
    if (!shapeIds.has(participant.id)) {
      errors.push(issue('MISSING_DI_SHAPE', `Participant ${participant.id} has no BPMNShape`, participant.id));
    }
  }

  for (const process of processes) {
    if (!process.name?.trim()) warnings.push(issue('MISSING_NAME', `Process ${process.id} has no name`, process.id));
    const flowElements = collectFlowElements(process);
    for (const lane of collectLanes(process)) {
      if (!lane.name?.trim()) warnings.push(issue('MISSING_NAME', `Lane ${lane.id} has no name`, lane.id));
      if (!shapeIds.has(lane.id)) errors.push(issue('MISSING_DI_SHAPE', `Lane ${lane.id} has no BPMNShape`, lane.id));
    }

    for (const element of flowElements) {
      if (visibleShape(element) && !shapeIds.has(element.id)) {
        errors.push(issue('MISSING_DI_SHAPE', `${element.$type} ${element.id} has no BPMNShape`, element.id));
      }
      if ((/Task$/.test(element?.$type || '') || /Gateway$/.test(element?.$type || '')) && !element.name?.trim()) {
        warnings.push(issue('MISSING_NAME', `${element.$type} ${element.id} has no name`, element.id));
      }
      if (isType(element, 'bpmn:SequenceFlow')) {
        const waypointCount = edgeIds.get(element.id) || 0;
        if (waypointCount < 2) {
          errors.push(issue('MISSING_DI_EDGE', `SequenceFlow ${element.id} needs a BPMNEdge with at least two waypoints`, element.id));
        }
        if (!element.sourceRef || !element.targetRef) {
          errors.push(issue('BROKEN_FLOW_REFERENCE', `SequenceFlow ${element.id} needs sourceRef and targetRef`, element.id));
        } else if (rootProcess(element.sourceRef)?.id !== rootProcess(element.targetRef)?.id) {
          errors.push(issue('SEQUENCE_FLOW_ACROSS_POOLS', `SequenceFlow ${element.id} crosses process boundaries`, element.id));
        }
      }
    }
  }

  for (const collaboration of collaborations) {
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
        if (isType(endpoint, 'bpmn:Participant')) return endpoint;
        const process = rootProcess(endpoint);
        return process?.id ? participantForProcess.get(process.id) : undefined;
      };
      const sourceParticipant = participantFor(messageFlow.sourceRef);
      const targetParticipant = participantFor(messageFlow.targetRef);
      if (!sourceParticipant || !targetParticipant || sourceParticipant.id === targetParticipant.id) {
        errors.push(issue('INVALID_MESSAGE_FLOW', `MessageFlow ${messageFlow.id} must connect distinct participants`, messageFlow.id));
      }
    }
  }

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
      if (shapesOverlap(left, right)) {
        warnings.push(issue('OVERLAPPING_SHAPES', `Shapes ${left.id} and ${right.id} overlap`, left.id));
      }
    }
  }

  let crossingWarnings = 0;
  for (let leftIndex = 0; leftIndex < edgeGeometries.length && crossingWarnings < 50; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < edgeGeometries.length && crossingWarnings < 50; rightIndex += 1) {
      const left = edgeGeometries[leftIndex]!;
      const right = edgeGeometries[rightIndex]!;
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
