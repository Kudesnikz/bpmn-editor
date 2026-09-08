import BpmnModdle from 'bpmn-moddle';
import { BPMN_NS, MARKER_NS, fail, parseXml, renderXml, walkXml, xmlFingerprint, type XmlNode } from './xml.js';

export interface JsonElement {
  type: string;
  properties: Record<string, any>;
  attributes?: Record<string, string>;
  extensions?: Array<XmlNode | string>;
}
export interface BpmnDocument {
  format: 'bpmn-json';
  version: 1;
  rootId: string;
  namespaces: Record<string, string>;
  elements: Record<string, JsonElement>;
}
export const JSON_LIMIT = 4 * 1024 * 1024;
export const MAX_ELEMENTS = 5000;
export const standardNamespaces: Record<string, string> = {
  bpmn: BPMN_NS,
  bpmndi: 'http://www.omg.org/spec/BPMN/20100524/DI',
  dc: 'http://www.omg.org/spec/DD/20100524/DC',
  di: 'http://www.omg.org/spec/DD/20100524/DI',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance'
};
export const moddle = new BpmnModdle();
const primitiveTypes = new Set(['String', 'Boolean', 'Integer', 'Real']);
const enumValues = new Map<string, string[]>(moddle.getPackages().flatMap((pkg: any) => (pkg.enumerations || []).map((entry: any) => [`${pkg.prefix}:${entry.name}`, entry.literalValues.map((literal: any) => literal.name)])));
export function isScalarType(type: string): boolean { return primitiveTypes.has(type) || enumValues.has(type); }
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const markerKey = 'jsoncodec:token';

export function descriptor(type: string): any {
  try { return moddle.getType(type).$descriptor; }
  catch { return fail('UNKNOWN_BPMN_TYPE', 'Unknown BPMN type', { type }); }
}

export function propertyDescriptor(type: string, key: string): any {
  const property = descriptor(type).properties.find((p: any) => p.name === key);
  if (!property || property.isVirtual || key === 'id') fail('UNKNOWN_PROPERTY', 'Unknown or immutable property', { type, property: key });
  return property;
}

export function assertJsonSafe(value: unknown): void {
  const stack = [{ value, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++count > 200000 || current.depth > 128) fail('MODEL_LIMIT_EXCEEDED', 'JSON structure exceeds processing limits');
    if (typeof current.value === 'number' && !Number.isFinite(current.value)) fail('INVALID_BPMN_JSON', 'Numbers must be finite');
    if (current.value && typeof current.value === 'object') {
      for (const [key, child] of Object.entries(current.value)) {
        if (forbidden.has(key)) fail('INVALID_BPMN_JSON', 'Unsafe object key');
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > JSON_LIMIT) fail('PAYLOAD_TOO_LARGE', 'BPMN JSON exceeds 4 MiB');
}

function extractExtensions(root: XmlNode): Map<string, Array<XmlNode | string>> {
  const extensions = new Map<string, Array<XmlNode | string>>();
  walkXml(root, node => {
    if (node.name.uri !== BPMN_NS || node.name.local !== 'extensionElements') return;
    const token = String(extensions.size);
    extensions.set(token, node.children);
    node.children = [];
    node.namespaces.jsoncodec = MARKER_NS;
    node.attributes.push({ uri: MARKER_NS, prefix: 'jsoncodec', local: 'token', value: token });
  });
  return extensions;
}

async function parseModel(xml: string): Promise<any> {
  try {
    const parsed = await moddle.fromXML(xml);
    if (parsed.warnings?.length) fail('UNSUPPORTED_XML_CONTENT', 'XML contains unresolved or unsupported content', { warningCount: parsed.warnings.length });
    return parsed.rootElement;
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error;
    fail('INVALID_XML', 'BPMN XML could not be parsed');
  }
}

export async function xmlToDocument(xml: string, audit = true): Promise<BpmnDocument> {
  const tree = parseXml(xml);
  const originalFingerprint = audit ? xmlFingerprint(tree) : '';
  const namespaces = { ...standardNamespaces, ...tree.namespaces };
  const extensions = extractExtensions(tree);
  const root = await parseModel(renderXml(tree));
  if (root.$type !== 'bpmn:Definitions') fail('INVALID_ROOT', 'Expected BPMN definitions');
  if (!root.id) fail('UNSUPPORTED_XML_CONTENT', 'Definitions needs an ID for normalized JSON');
  const elements: Record<string, JsonElement> = Object.create(null);
  const seen = new Set<any>();
  const encode = (element: any, depth: number): JsonElement => {
    if (depth > 128 || seen.has(element)) fail('INVALID_BPMN_JSON', 'Containment is cyclic or too deep');
    seen.add(element);
    const result: JsonElement = { type: element.$type, properties: {} };
    if (element.id) {
      if (elements[element.id]) fail('DUPLICATE_ID', 'BPMN IDs must be unique', { elementId: element.id });
      if (forbidden.has(element.id)) fail('INVALID_BPMN_JSON', 'Unsafe BPMN ID');
      elements[element.id] = result;
      if (Object.keys(elements).length > MAX_ELEMENTS) fail('MODEL_LIMIT_EXCEEDED', 'Too many BPMN elements');
    }
    for (const p of element.$descriptor.properties) {
      if (p.name === 'id' || p.isVirtual) continue;
      if (element.$type === 'bpmn:ExtensionElements' && p.name === 'values') continue;
      // Non-enumerable references must be read explicitly. Omit inherited defaults.
      if (!Object.hasOwn(element, p.name)) continue;
      const value = element[p.name];
      if (value === undefined) continue;
      const one = (v: any): any => {
        if (p.isReference) {
          if (typeof v?.id !== 'string') fail('UNSUPPORTED_XML_CONTENT', 'Reference target has no ID');
          return v.id;
        }
        if (isScalarType(p.type) || v === null || typeof v !== 'object') return v;
        const encoded = encode(v, depth + 1);
        return v.id || encoded;
      };
      result.properties[p.name] = p.isMany ? value.map(one) : one(value);
    }
    const attrs = { ...(element.$attrs || {}) };
    if (attrs[markerKey] !== undefined) {
      result.extensions = extensions.get(attrs[markerKey]) || [];
      delete attrs[markerKey];
    }
    for (const key of Object.keys(attrs)) if (key.startsWith('xmlns')) {
      if (attrs[key] !== MARKER_NS) namespaces[key === 'xmlns' ? '' : key.slice(6)] = attrs[key];
      delete attrs[key];
    }
    if (Object.keys(attrs).length) result.attributes = attrs;
    return result;
  };
  encode(root, 0);
  delete namespaces.jsoncodec;
  const document: BpmnDocument = { format: 'bpmn-json', version: 1, rootId: root.id, namespaces, elements };
  assertJsonSafe(document);
  if (audit) {
    const restored = await documentToXml(document, false);
    if (xmlFingerprint(parseXml(restored)) !== originalFingerprint) fail('CONVERSION_LOSS_DETECTED', 'XML content cannot be represented without changes');
  }
  return document;
}

export async function documentToXml(document: BpmnDocument, audit = true): Promise<string> {
  assertJsonSafe(document);
  if (!document || document.format !== 'bpmn-json' || document.version !== 1 || !document.elements || !document.namespaces || typeof document.rootId !== 'string') {
    fail('INVALID_BPMN_JSON', 'Expected a bpmn-json version 1 document');
  }
  for (const key of Object.keys(document)) if (!['format', 'version', 'rootId', 'namespaces', 'elements'].includes(key)) fail('INVALID_BPMN_JSON', 'Unexpected document property', { property: key });
  if (Object.keys(document.elements).length > MAX_ELEMENTS) fail('MODEL_LIMIT_EXCEEDED', 'Too many BPMN elements');
  const instances = new Map<string, any>();
  const owned = new Set<any>();
  const refs: Array<{ owner: any; property: any; value: any }> = [];
  const extensions = new Map<string, Array<XmlNode | string>>();
  for (const [id, entry] of Object.entries(document.elements)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id)) fail('INVALID_BPMN_JSON', 'Invalid BPMN ID', { elementId: id });
    if (!entry || typeof entry.type !== 'string' || !descriptor(entry.type).properties.some((p: any) => p.isId)) fail('INVALID_BPMN_JSON', 'Indexed element type must support an ID', { elementId: id });
    instances.set(id, moddle.create(entry.type, { id }));
  }
  const fill = (entry: JsonElement, instance: any, depth: number): any => {
    if (depth > 128 || owned.has(instance)) fail('INVALID_BPMN_JSON', 'Containment is cyclic or has multiple owners');
    owned.add(instance);
    if (!entry.properties || typeof entry.properties !== 'object' || Array.isArray(entry.properties)) fail('INVALID_BPMN_JSON', 'Element properties must be an object');
    for (const key of Object.keys(entry)) if (!['type', 'properties', 'attributes', 'extensions'].includes(key)) fail('INVALID_BPMN_JSON', 'Unexpected element property', { property: key });
    for (const [key, value] of Object.entries(entry.properties)) {
      const p = propertyDescriptor(entry.type, key);
      if (p.isMany && !Array.isArray(value)) fail('INVALID_BPMN_JSON', 'Expected an array', { property: key });
      if (!p.isMany && Array.isArray(value)) fail('INVALID_BPMN_JSON', 'Expected a single value', { property: key });
      if (p.isReference) { refs.push({ owner: instance, property: p, value }); continue; }
      const one = (v: any): any => {
        if (isScalarType(p.type)) {
          if (enumValues.has(p.type) && (typeof v !== 'string' || !enumValues.get(p.type)!.includes(v))) fail('INVALID_BPMN_JSON', 'Invalid enum value', { property: key, allowedValues: enumValues.get(p.type) });
          const valid = p.type === 'String' || enumValues.has(p.type) ? typeof v === 'string' : p.type === 'Boolean' ? typeof v === 'boolean' : typeof v === 'number' && Number.isFinite(v) && (p.type !== 'Integer' || Number.isInteger(v));
          if (!valid) fail('INVALID_BPMN_JSON', 'Wrong scalar type', { property: key });
          return v;
        }
        let child: any;
        if (typeof v === 'string' && instances.has(v)) {
          child = instances.get(v);
          fill(document.elements[v]!, child, depth + 1);
        } else if (v && typeof v === 'object' && typeof v.type === 'string') {
          child = moddle.create(v.type);
          fill(v, child, depth + 1);
        } else fail('INVALID_BPMN_JSON', 'Expected a contained element', { property: key });
        if (p.type !== 'Element' && !child.$instanceOf(p.type)) fail('INVALID_BPMN_JSON', 'Wrong containment type', { property: key });
        child.$parent = instance;
        return child;
      };
      instance.set(key, p.isMany ? value.map(one) : one(value));
    }
    if (entry.attributes) {
      for (const [key, value] of Object.entries(entry.attributes)) {
        if (!key.includes(':') || key.startsWith('xmlns') || key.startsWith('jsoncodec:') || typeof value !== 'string') fail('INVALID_BPMN_JSON', 'Only namespaced extension attributes are allowed');
        const prefix = key.split(':')[0]!;
        if (!document.namespaces[prefix] || document.namespaces[prefix] === BPMN_NS) fail('INVALID_BPMN_JSON', 'Unknown or standard attribute namespace');
        instance.$attrs[key] = value;
      }
    }
    if (entry.extensions !== undefined) {
      if (entry.type !== 'bpmn:ExtensionElements' || !Array.isArray(entry.extensions)) fail('INVALID_BPMN_JSON', 'extensions belongs to ExtensionElements');
      const token = String(extensions.size);
      extensions.set(token, entry.extensions);
      instance.$attrs[markerKey] = token;
    }
    return instance;
  };
  const root = instances.get(document.rootId);
  if (!root || root.$type !== 'bpmn:Definitions') fail('INVALID_ROOT', 'rootId must reference Definitions');
  fill(document.elements[document.rootId]!, root, 0);
  for (const instance of instances.values()) if (!owned.has(instance)) fail('INVALID_BPMN_JSON', 'Unattached element', { elementId: instance.id });
  for (const { owner, property: p, value } of refs) {
    const resolve = (id: any) => {
      const target = typeof id === 'string' ? instances.get(id) : undefined;
      if (!target) fail('BROKEN_JSON_REFERENCE', 'Reference target is missing', { elementId: owner.id, property: p.name, targetId: id });
      if (p.type !== 'Element' && !target.$instanceOf(p.type)) fail('BROKEN_JSON_REFERENCE', 'Wrong reference target type', { property: p.name });
      return target;
    };
    owner.set(p.name, p.isMany ? value.map(resolve) : resolve(value));
  }
  for (const [prefix, uri] of Object.entries({ ...document.namespaces, ...(extensions.size ? { jsoncodec: MARKER_NS } : {}) })) {
    if (typeof uri !== 'string' || prefix && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(prefix)) fail('INVALID_BPMN_JSON', 'Invalid namespace');
    if (Object.hasOwn(standardNamespaces, prefix) && standardNamespaces[prefix] !== uri) fail('INVALID_BPMN_JSON', 'Standard namespace cannot be redefined');
    root.$attrs[prefix ? `xmlns:${prefix}` : 'xmlns'] = uri;
  }
  let xml = (await moddle.toXML(root, { format: true })).xml;
  if (extensions.size) {
    const tree = parseXml(xml);
    walkXml(tree, node => {
      const marker = node.attributes.find(a => a.uri === MARKER_NS);
      if (marker) {
        node.children = structuredClone(extensions.get(marker.value)!);
        node.attributes = node.attributes.filter(a => a.uri !== MARKER_NS);
      }
      delete node.namespaces.jsoncodec;
    });
    xml = renderXml(tree);
  }
  // Validate extension XML names, bindings, characters and mixed content as well.
  parseXml(xml);
  if (audit) {
    const restored = await xmlToDocument(xml, false);
    if (documentFingerprint(restored) !== documentFingerprint(document)) fail('CONVERSION_LOSS_DETECTED', 'JSON properties were changed during XML conversion');
  }
  return xml;
}

export function documentFingerprint(document: BpmnDocument): string {
  const normalize = (value: any): any => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      if (value.name?.uri !== undefined && Array.isArray(value.children) && Array.isArray(value.attributes)) return xmlFingerprint(value, true);
      if (typeof value.type === 'string' && value.properties && typeof value.properties === 'object') {
        // Moddle omits explicit values equal to metamodel defaults when writing.
        // Their absence on the next parse is equivalent, not data loss.
        const properties = descriptor(value.type).properties;
        value = { ...value, properties: Object.fromEntries(Object.entries(value.properties).filter(([key, item]) => {
          const property = properties.find((candidate: any) => candidate.name === key);
          return property?.default === undefined || item !== property.default;
        })) };
        if (value.attributes) {
          const attributes = Object.fromEntries(Object.entries(value.attributes).filter(([key, item]) => {
            const [prefix, local] = key.split(':');
            if (local !== 'type' || document.namespaces[prefix!] !== standardNamespaces.xsi || typeof item !== 'string') return true;
            const [typePrefix, typeLocal] = item.split(':');
            const [modelPrefix, modelLocal] = value.type.split(':');
            // xsi:type emitted for polymorphic BPMN properties is already captured
            // by the normalized type. Never discard a contradictory annotation.
            return !(document.namespaces[typePrefix!] === (document.namespaces[modelPrefix] || standardNamespaces[modelPrefix]) && typeLocal === `t${modelLocal}`);
          }));
          value = { ...value, attributes: Object.keys(attributes).length ? attributes : undefined };
        }
      }
      return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined && !(Array.isArray(value[k]) && !value[k].length)).map(k => [k, normalize(value[k])]));
    }
    return value;
  };
  return JSON.stringify(normalize({ rootId: document.rootId, elements: document.elements }));
}

export function describeTypes(types: string[]): unknown[] {
  return types.map(type => enumValues.has(type) ? { type, kind: 'enum', values: enumValues.get(type) } : { type, properties: descriptor(type).properties.filter((p: any) => !p.isVirtual && p.name !== 'id').map((p: any) => ({ name: p.name, type: p.type, kind: p.isReference ? 'reference' : isScalarType(p.type) ? 'scalar' : 'containment', many: Boolean(p.isMany), ...(enumValues.has(p.type) ? { allowedValues: enumValues.get(p.type) } : {}), ...(p.default !== undefined ? { default: p.default } : {}) })) });
}
