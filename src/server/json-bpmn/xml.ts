import { SaxesParser } from 'saxes';
import { AppError } from '../errors.js';

export const BPMN_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
export const MARKER_NS = 'urn:bpmn-json:internal';
export interface XmlName { uri: string; local: string; prefix: string }
export interface XmlAttribute extends XmlName { value: string }
export interface XmlNode {
  name: XmlName;
  namespaces: Record<string, string>;
  attributes: XmlAttribute[];
  children: Array<XmlNode | string>;
}

export function fail(code: string, message: string, details?: unknown): never {
  throw new AppError(422, code, message, details);
}

export function parseXml(xml: string): XmlNode {
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let count = 0;
  parser.on('doctype', () => fail('UNSUPPORTED_XML_CONTENT', 'DOCTYPE is not supported'));
  parser.on('processinginstruction', () => fail('UNSUPPORTED_XML_CONTENT', 'Processing instructions are not supported'));
  parser.on('error', () => fail('INVALID_XML', 'XML syntax is invalid'));
  parser.on('opentag', tag => {
    if (++count > 20000 || stack.length >= 128) fail('MODEL_LIMIT_EXCEEDED', 'XML structure exceeds processing limits');
    const node: XmlNode = {
      name: { uri: tag.uri, local: tag.local, prefix: tag.prefix },
      namespaces: { ...(stack.at(-1)?.namespaces || {}), ...tag.ns },
      attributes: Object.values(tag.attributes).filter(a => a.uri !== 'http://www.w3.org/2000/xmlns/')
        .map(a => ({ uri: a.uri, local: a.local, prefix: a.prefix, value: a.value })),
      children: []
    };
    if (stack.length) stack.at(-1)!.children.push(node);
    else root = node;
    stack.push(node);
  });
  const appendText = (text: string) => {
    const node = stack.at(-1);
    if (!node) return;
    const last = node.children.at(-1);
    if (typeof last === 'string') node.children[node.children.length - 1] = last + text;
    else node.children.push(text);
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  // Comments are not part of BPMN semantics. Text and CDATA are preserved.
  parser.on('closetag', () => { stack.pop(); });
  parser.write(xml).close();
  if (!root) fail('INVALID_XML', 'XML document has no root');
  return root;
}

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
const qualified = (name: XmlName) => name.prefix ? `${name.prefix}:${name.local}` : name.local;
const ncName = /^[\p{L}_][\p{L}\p{N}\p{M}_.\-\u00b7]*$/u;

function validateName(name: XmlName, attribute = false): void {
  if (!name || typeof name.uri !== 'string' || typeof name.prefix !== 'string' || !ncName.test(name.local)
    || name.prefix && !ncName.test(name.prefix) || name.prefix && !name.uri
    || name.prefix === 'xmlns' || name.uri === 'http://www.w3.org/2000/xmlns/'
    || name.prefix === 'xml' && name.uri !== 'http://www.w3.org/XML/1998/namespace'
    || attribute && name.uri && !name.prefix) fail('INVALID_EXTENSION_XML', 'Invalid XML name or namespace binding');
}

export function renderXml(node: XmlNode, inherited: Record<string, string> = {}): string {
  validateName(node.name);
  if (!node.namespaces || typeof node.namespaces !== 'object' || !Array.isArray(node.attributes) || !Array.isArray(node.children)) fail('INVALID_EXTENSION_XML', 'Invalid XML tree');
  for (const [prefix, uri] of Object.entries(node.namespaces)) {
    if (typeof uri !== 'string' || prefix && !ncName.test(prefix) || prefix === 'xmlns'
      || prefix === 'xml' && uri !== 'http://www.w3.org/XML/1998/namespace') fail('INVALID_EXTENSION_XML', 'Invalid namespace declaration');
  }
  for (const attribute of node.attributes) {
    validateName(attribute, true);
    if (typeof attribute.value !== 'string') fail('INVALID_EXTENSION_XML', 'XML attribute values must be strings');
  }
  const ns = { ...inherited, ...node.namespaces };
  if (node.name.uri) ns[node.name.prefix] = node.name.uri;
  else if (!node.name.prefix && ns['']) ns[''] = '';
  for (const attribute of node.attributes) if (attribute.uri && attribute.prefix) ns[attribute.prefix] = attribute.uri;
  const declarations = Object.entries(ns).filter(([prefix, uri]) => prefix !== 'xml' && inherited[prefix] !== uri)
    .map(([prefix, uri]) => ` xmlns${prefix ? `:${prefix}` : ''}="${escapeAttribute(uri)}"`).join('');
  const attributes = node.attributes.map(a => ` ${qualified(a)}="${escapeAttribute(a.value)}"`).join('');
  const content = node.children.map(child => typeof child === 'string' ? escapeText(child) : renderXml(child, ns)).join('');
  return `<${qualified(node.name)}${declarations}${attributes}>${content}</${qualified(node.name)}>`;
}

export function walkXml(root: XmlNode, visit: (node: XmlNode) => void): void {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    visit(node);
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (typeof child !== 'string' && child) pending.push(child);
    }
  }
}

/** Namespace-aware audit independent of the moddle codec. */
export function xmlFingerprint(node: XmlNode, foreign = false): string {
  const opaque = foreign || node.name.uri !== BPMN_NS && !node.name.uri.startsWith('http://www.omg.org/spec/');
  const attributes = node.attributes.map(a => {
    let value = a.value;
    if (['http://www.omg.org/spec/DD/20100524/DC', 'http://www.omg.org/spec/DD/20100524/DI'].includes(node.name.uri)
      && !a.uri && ['x', 'y', 'width', 'height'].includes(a.local) && value.trim() && Number.isFinite(Number(value))) {
      value = String(Number(value));
    }
    if (a.uri === 'http://www.w3.org/2001/XMLSchema-instance' && a.local === 'type') {
      const [prefix, local] = value.split(':');
      value = local ? `{${node.namespaces[prefix!] || prefix}}${local}` : value;
    }
    return [a.uri, a.local, value];
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  let children = node.children.filter(c => typeof c !== 'string' || opaque || c.trim().length > 0)
    .map(c => typeof c === 'string' ? ['text', c] : [c.name.uri, c.name.local, xmlFingerprint(c, opaque)]);
  // Moddle emits property groups in metamodel order. Order within a property is retained.
  if (!opaque && !children.some(c => c[0] === 'text')) children = children.sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`));
  return JSON.stringify([node.name.uri, node.name.local, attributes, children]);
}
