import { descriptor, isScalarType, type BpmnDocument, type JsonElement } from './codec.js';
import { fail } from './xml.js';

export interface PropertyVisit { ownerId: string; element: JsonElement; key: string; descriptor: any; value: any }

export function visitProperties(document: BpmnDocument, visit: (property: PropertyVisit) => void): void {
  const pending = Object.entries(document.elements).map(([ownerId, element]) => ({ ownerId, element }));
  while (pending.length) {
    const { ownerId, element } = pending.pop()!;
    for (const p of descriptor(element.type).properties) {
      const value = element.properties[p.name];
      if (value === undefined) continue;
      visit({ ownerId, element, key: p.name, descriptor: p, value });
      if (!p.isReference) for (const child of p.isMany ? value : [value]) {
        if (child && typeof child === 'object' && typeof child.type === 'string') pending.push({ ownerId, element: child });
      }
    }
  }
}

export function ownership(document: BpmnDocument): Map<string, { ownerId: string; element: JsonElement; key: string }> {
  const parents = new Map<string, { ownerId: string; element: JsonElement; key: string }>();
  visitProperties(document, ({ ownerId, element, key, descriptor: p, value }) => {
    if (p.isReference || isScalarType(p.type)) return;
    for (const child of p.isMany ? value : [value]) if (typeof child === 'string') {
      if (parents.has(child)) fail('INVALID_BPMN_JSON', 'Element has multiple containment owners', { elementId: child });
      parents.set(child, { ownerId, element, key });
    }
  });
  return parents;
}

export function descendants(document: BpmnDocument, rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const [id, parent] of ownership(document)) children.set(parent.ownerId, [...(children.get(parent.ownerId) || []), id]);
  const result = new Set<string>();
  const pending = [rootId];
  while (pending.length) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    pending.push(...(children.get(id) || []));
  }
  return result;
}

export function semanticDocument(document: BpmnDocument): BpmnDocument {
  const result = structuredClone(document);
  const diagramIds = result.elements[result.rootId]!.properties.diagrams || [];
  const removed = new Set<string>();
  for (const id of diagramIds) for (const child of descendants(result, id)) removed.add(child);
  delete result.elements[result.rootId]!.properties.diagrams;
  for (const id of removed) delete result.elements[id];
  visitProperties(result, ({ element, key, descriptor: p, value }) => {
    if (!p.isReference) return;
    if (p.isMany) element.properties[key] = value.filter((id: string) => !removed.has(id));
    else if (removed.has(value)) delete element.properties[key];
  });
  return result;
}

export function scopeOf(document: BpmnDocument, id: string): string | undefined {
  const parents = ownership(document);
  const seen = new Set<string>();
  let current = parents.get(id)?.ownerId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const type = document.elements[current]?.type;
    if (type && ['bpmn:Process', 'bpmn:SubProcess', 'bpmn:Transaction', 'bpmn:AdHocSubProcess'].includes(type)) return current;
    current = parents.get(current)?.ownerId;
  }
  return undefined;
}
