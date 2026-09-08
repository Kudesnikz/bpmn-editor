import { AppError } from '../errors.js';
import { assertJsonSafe, descriptor, isScalarType, propertyDescriptor, type BpmnDocument, type JsonElement } from './codec.js';
import { descendants, ownership, scopeOf, visitProperties } from './graph.js';
import { fail } from './xml.js';

export interface Operation { op: string; [key: string]: any }
export interface Changes { document: BpmnDocument; changedIds: string[]; removedIds: string[]; geometryIds: string[]; hints: Record<string, { afterId?: string; laneId?: string }> }
const flowTypes = ['bpmn:SequenceFlow', 'bpmn:MessageFlow', 'bpmn:Association'];

export function applyOperations(original: BpmnDocument, operations: Operation[]): Changes {
  assertJsonSafe(operations);
  if (!Array.isArray(operations) || !operations.length || operations.length > 200) fail('INVALID_OPERATIONS', 'Supply 1–200 operations');
  const document = structuredClone(original);
  const changed = new Set<string>();
  const removed = new Set<string>();
  const geometry = new Set<string>();
  const hints: Changes['hints'] = {};
  const get = (id: any): JsonElement => {
    if (typeof id !== 'string' || !Object.hasOwn(document.elements, id)) fail('PATCH_TARGET_NOT_FOUND', 'Element was not found', { elementId: id });
    return document.elements[id]!;
  };
  const attach = (id: string, parentId: string, property: string) => {
    const parent = get(parentId);
    const p = propertyDescriptor(parent.type, property);
    if (p.isReference || isScalarType(p.type)) fail('INVALID_OPERATIONS', 'Parent property must be containment');
    if (p.isMany) parent.properties[property] = [...(parent.properties[property] || []), id];
    else {
      if (parent.properties[property] !== undefined) fail('INVALID_OPERATIONS', 'Containment property is occupied');
      parent.properties[property] = id;
    }
    changed.add(parentId);
  };
  const detach = (id: string) => {
    const parent = ownership(document).get(id);
    if (!parent) fail('INVALID_OPERATIONS', 'Root element cannot be detached');
    const value = parent.element.properties[parent.key];
    if (Array.isArray(value)) parent.element.properties[parent.key] = value.filter(v => v !== id);
    else delete parent.element.properties[parent.key];
    changed.add(parent.ownerId);
  };
  const add = (id: string, entry: JsonElement, parentId: string, property: string) => {
    if (Object.hasOwn(document.elements, id)) fail('DUPLICATE_ID', 'Element already exists', { elementId: id });
    descriptor(entry.type);
    document.elements[id] = structuredClone(entry);
    attach(id, parentId, property);
    changed.add(id);
    geometry.add(id);
  };
  const syncFlow = (id: string, previous?: JsonElement) => {
    const flow = get(id);
    if (flow.type !== 'bpmn:SequenceFlow') return;
    for (const [field, direction] of [['sourceRef', 'outgoing'], ['targetRef', 'incoming']] as const) {
      const old = previous?.properties[field];
      if (old && document.elements[old]) {
        const node = get(old);
        if (Array.isArray(node.properties[direction])) node.properties[direction] = node.properties[direction].filter((v: string) => v !== id);
        changed.add(old);
      }
      const nodeId = flow.properties[field];
      if (!nodeId || !document.elements[nodeId]) continue;
      const node = get(nodeId);
      node.properties[direction] = [...new Set([...(node.properties[direction] || []), id])];
      changed.add(nodeId);
    }
  };
  const remove = (id: string, cascade: boolean) => {
    const target = get(id);
    if (id === document.rootId) fail('INVALID_OPERATIONS', 'Definitions cannot be removed');
    if ((target.properties.flowElements?.length || target.properties.flowNodeRef?.length || target.properties.childLaneSet?.properties?.lanes?.length)
      || Object.values(document.elements).some(e => e.type === 'bpmn:BoundaryEvent' && e.properties.attachedToRef === id)) {
      fail('PATCH_WOULD_BREAK_REFERENCES', 'Explicitly move or remove contained business elements and boundary events first', { elementId: id });
    }
    const deleting = descendants(document, id);
    let incoming: PropertyVisitLocal[] = [];
    const collect = () => {
      incoming = [];
      visitProperties(document, v => {
        if (!v.descriptor.isReference || deleting.has(v.ownerId)) return;
        const values = v.descriptor.isMany ? v.value : [v.value];
        if (values.some((ref: string) => deleting.has(ref))) incoming.push(v);
      });
    };
    collect();
    if (incoming.length && !cascade) fail('PATCH_WOULD_BREAK_REFERENCES', 'References exist; use cascade or update them explicitly', { elementId: id, referencingIds: [...new Set(incoming.map(v => v.ownerId))] });
    if (cascade) {
      // Only related connections and DI are implicit deletions, never business nodes.
      let size: number;
      do {
        size = deleting.size;
        collect();
        for (const v of incoming) {
          const type = get(v.ownerId).type;
          if (flowTypes.includes(type) || type.startsWith('bpmndi:')) for (const child of descendants(document, v.ownerId)) deleting.add(child);
        }
      } while (size !== deleting.size);
      collect();
      for (const v of incoming) {
        if (!['incoming', 'outgoing', 'default', 'flowNodeRef'].includes(v.key)) fail('PATCH_WOULD_BREAK_REFERENCES', 'Explicitly repair business references before removing this element', { elementId: id, referencingId: v.ownerId, property: v.key });
        if (v.descriptor.isMany) v.element.properties[v.key] = v.value.filter((ref: string) => !deleting.has(ref));
        else delete v.element.properties[v.key];
        changed.add(v.ownerId);
      }
    }
    // Remove containment entries before deleting descendants.
    visitProperties(document, v => {
      if (v.descriptor.isReference || deleting.has(v.ownerId) || isScalarType(v.descriptor.type)) return;
      if (v.descriptor.isMany && Array.isArray(v.value)) {
        const retained = v.value.filter((ref: any) => typeof ref !== 'string' || !deleting.has(ref));
        if (retained.length !== v.value.length) { v.element.properties[v.key] = retained; changed.add(v.ownerId); }
      } else if (typeof v.value === 'string' && deleting.has(v.value)) {
        delete v.element.properties[v.key]; changed.add(v.ownerId);
      }
    });
    for (const key of deleting) { delete document.elements[key]; removed.add(key); changed.add(key); }
  };
  type PropertyVisitLocal = Parameters<Parameters<typeof visitProperties>[1]>[0];

  operations.forEach((operation, index) => {
    try {
      const id = operation.element_id;
      switch (operation.op) {
        case 'update_properties': {
          const element = get(id);
          for (const [key, value] of Object.entries(operation.set || {})) {
            const p = propertyDescriptor(element.type, key);
            if (p.isReference) fail('INVALID_OPERATIONS', 'Use set_reference for references', { property: key });
            if (!isScalarType(p.type) && (typeof value === 'string' || Array.isArray(value) && value.some(v => typeof v === 'string'))) fail('INVALID_OPERATIONS', 'Use containment operations for indexed elements');
            element.properties[key] = structuredClone(value);
          }
          for (const key of operation.unset || []) {
            const p = propertyDescriptor(element.type, key);
            if (p.isReference || !isScalarType(p.type) && typeof element.properties[key] === 'string') fail('INVALID_OPERATIONS', 'Use reference or containment operations');
            delete element.properties[key];
          }
          changed.add(id);
          break;
        }
        case 'add_element':
          add(id, operation.element, operation.parent_id, operation.property);
          hints[id] = { afterId: operation.after_id, laneId: operation.lane_id };
          if (operation.lane_id) {
            const lane = get(operation.lane_id);
            if (lane.type !== 'bpmn:Lane') fail('INVALID_OPERATIONS', 'lane_id must reference a Lane');
            lane.properties.flowNodeRef = [...(lane.properties.flowNodeRef || []), id];
          }
          syncFlow(id);
          break;
        case 'set_reference': {
          const element = get(id);
          const before = structuredClone(element);
          const p = propertyDescriptor(element.type, operation.property);
          if (!p.isReference || ['incoming', 'outgoing'].includes(p.name)) fail('INVALID_OPERATIONS', 'Reference is managed by flow operations');
          if (operation.value === null) delete element.properties[p.name];
          else element.properties[p.name] = structuredClone(operation.value);
          syncFlow(id, before);
          changed.add(id);
          geometry.add(id);
          break;
        }
        case 'connect':
          add(id, { type: operation.type, properties: { ...(operation.properties || {}), sourceRef: operation.source_id, targetRef: operation.target_id } }, operation.parent_id, operation.type === 'bpmn:SequenceFlow' ? 'flowElements' : operation.type === 'bpmn:MessageFlow' ? 'messageFlows' : 'artifacts');
          if (!flowTypes.includes(operation.type)) fail('INVALID_OPERATIONS', 'Unsupported connection type');
          syncFlow(id);
          break;
        case 'reconnect_flow': {
          const flow = get(id);
          if (!flowTypes.includes(flow.type)) fail('INVALID_OPERATIONS', 'Expected a connection');
          const before = structuredClone(flow);
          if (operation.source_id !== undefined) flow.properties.sourceRef = operation.source_id;
          if (operation.target_id !== undefined) flow.properties.targetRef = operation.target_id;
          syncFlow(id, before);
          changed.add(id); geometry.add(id);
          break;
        }
        case 'insert_task_on_flow': {
          const flowId = operation.flow_id;
          const flow = get(flowId);
          if (flow.type !== 'bpmn:SequenceFlow') fail('INVALID_OPERATIONS', 'Expected a sequence flow');
          const before = structuredClone(flow);
          const parentId = scopeOf(document, flowId);
          if (!parentId) fail('INVALID_OPERATIONS', 'Flow has no owning scope');
          const task = operation.task;
          if (!descriptor(task.type).allTypes.some((t: any) => t.name === 'bpmn:Task')) fail('INVALID_OPERATIONS', 'Expected a task type');
          add(task.id, { type: task.type, properties: { name: task.name, ...(task.properties || {}) } }, parentId, 'flowElements');
          flow.properties.targetRef = task.id;
          syncFlow(flowId, before);
          add(operation.new_flow_id, { type: 'bpmn:SequenceFlow', properties: { sourceRef: task.id, targetRef: before.properties.targetRef } }, parentId, 'flowElements');
          syncFlow(operation.new_flow_id);
          const laneId = operation.lane_id || Object.entries(document.elements).find(([, e]) => e.type === 'bpmn:Lane' && e.properties.flowNodeRef?.includes(before.properties.sourceRef))?.[0];
          if (laneId) get(laneId).properties.flowNodeRef = [...(get(laneId).properties.flowNodeRef || []), task.id];
          hints[task.id] = { afterId: before.properties.sourceRef, laneId };
          changed.add(flowId); geometry.add(flowId);
          break;
        }
        case 'move_element': {
          get(id);
          if (operation.parent_id) {
            if (descendants(document, id).has(operation.parent_id)) fail('INVALID_OPERATIONS', 'Containment cycle');
            detach(id); attach(id, operation.parent_id, operation.property);
          }
          if (Object.hasOwn(operation, 'lane_id')) {
            for (const [laneId, lane] of Object.entries(document.elements)) if (lane.type === 'bpmn:Lane' && lane.properties.flowNodeRef?.includes(id)) {
              lane.properties.flowNodeRef = lane.properties.flowNodeRef.filter((v: string) => v !== id); changed.add(laneId);
            }
            if (operation.lane_id !== null) {
              const lane = get(operation.lane_id);
              if (lane.type !== 'bpmn:Lane') fail('INVALID_OPERATIONS', 'Expected a lane');
              lane.properties.flowNodeRef = [...(lane.properties.flowNodeRef || []), id];
            }
          }
          hints[id] = { laneId: operation.lane_id, afterId: operation.after_id };
          changed.add(id); geometry.add(id);
          break;
        }
        case 'remove_element': remove(id, operation.cascade === true); break;
        case 'reorder_children': {
          const element = get(id);
          const p = propertyDescriptor(element.type, operation.property);
          const current = element.properties[p.name];
          const next = operation.ids;
          if (p.isReference || !p.isMany || !Array.isArray(current) || !Array.isArray(next) || current.length !== next.length || new Set(next).size !== next.length || next.some(v => !current.includes(v))) fail('INVALID_OPERATIONS', 'Supply every existing child exactly once');
          element.properties[p.name] = [...next]; changed.add(id);
          break;
        }
        case 'replace_extensions': {
          const element = get(id);
          propertyDescriptor(element.type, 'extensionElements');
          element.properties.extensionElements = { type: 'bpmn:ExtensionElements', properties: {}, extensions: structuredClone(operation.extensions) };
          changed.add(id); break;
        }
        case 'set_bounds':
        case 'set_waypoints': {
          const property = operation.op === 'set_bounds' ? 'bounds' : 'waypoint';
          const type = operation.op === 'set_bounds' ? 'bpmndi:BPMNShape' : 'bpmndi:BPMNEdge';
          const candidates = Object.entries(document.elements).filter(([, e]) => e.type === type && e.properties.bpmnElement === id);
          const parents = ownership(document);
          const filtered = operation.plane_id ? candidates.filter(([key]) => parents.get(key)?.ownerId === operation.plane_id) : candidates;
          if (filtered.length !== 1) fail('PLANE_REQUIRED', 'Select exactly one DI representation with plane_id');
          const [diId, di] = filtered[0]!;
          di.properties[property] = operation.op === 'set_bounds' ? { type: 'dc:Bounds', properties: operation.bounds } : operation.waypoints.map((point: any) => ({ type: 'dc:Point', properties: point }));
          changed.add(diId); break;
        }
        default: fail('INVALID_OPERATIONS', 'Unknown operation', { operation: operation.op });
      }
    } catch (error) {
      if (error instanceof AppError) throw new AppError(error.status, error.code, error.message, { operationIndex: index, ...(error.details as object || {}) });
      fail('INVALID_OPERATIONS', 'Invalid operation arguments', { operationIndex: index });
    }
  });
  return { document, changedIds: [...changed], removedIds: [...removed], geometryIds: [...geometry], hints };
}
