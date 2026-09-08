import { createMcpHandler, McpServer, ResourceTemplate, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { isAppError } from '../errors.js';
import { logEvent } from '../logger.js';
import { createSchema, documentSchema, metadata, mutationSchema, readSchema, validateSchema } from './schemas.js';
import { JsonBpmnService } from './service.js';

export const JSON_MODELING_GUIDE = `Experimental BPMN JSON v1. XML remains the only stored format.
Read before updates and use the exact diagram revision. Preserve existing BPMN IDs. No diagram/folder deletion tools exist.
Start with list_folders/list_diagrams, then summary or inspect_diagram; read only a relevant fragment for local changes.
Use stable folder_id and the exact catalogRevision from list_folders for folder changes.
Prefer mode=operations over replacing the whole document. get_diagram requires scope=summary|semantic|fragment|full.
Fragments and pages are projections, never full replacement documents. Follow nextCursor at the same revision; restart if revision changes.
elements maps existing element IDs to {type,properties}; reference properties contain IDs; anonymous typed children are inline.
Call describe_bpmn_types for the particular types needed, not the entire metamodel. Unknown properties are rejected.
Use lanes for roles in a process, pools for independent participants. Sequence flows stay inside one process/subprocess scope; message flows connect distinct participants of one collaboration.
Use preserve layout for local edits. Existing shapes/containers stay fixed. RELAYOUT_REQUIRED means explicitly authorize auto layout for the reported process/collaboration or supply DI; do not silently escalate.
Full replacement needs explicit auto or provided layout. New diagrams default to auto. Every stored model needs valid BPMN DI.
Run validate_bpmn before writing complex changes. Validation never reserves a revision. On conflict read again and reconcile rather than retry blindly.
remove_element only removes a BPMN element, not a diagram. Cascade is limited to its related flows and DI; business children and boundary events need explicit handling.
Extensions are namespace-aware opaque XML trees, not interpreted business settings. Unsupported or lossy conversion fails without a write.
After writes return diagram.url to the user; do not fetch or echo a full document just to confirm success.`;

const instructions = `Read before changing; use exact expected_revision. Preserve IDs and complete BPMN DI. Never delete diagrams or folders. Read list_folders before folder changes and use expected_catalog_revision. Prefer fragments and operations; preserve existing geometry. On REVISION_CONFLICT reread, never overwrite blindly. JSON v1 is experimental.\n\n${JSON_MODELING_GUIDE}`;
const id = z.string().min(1).max(512);

function buildServer(service: JsonBpmnService) {
  const server = new McpServer({ name: 'bpmn-json', version: '1.0.0', title: 'BPMN JSON MCP (experimental)' }, { instructions });
  const register = (name: string, description: string, schema: any, write: boolean, operation: (input: any) => Promise<any>) => {
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: !write, destructiveHint: write && name === 'update_diagram', idempotentHint: !write, openWorldHint: false } }, async (input: any): Promise<CallToolResult> => {
      const started = Date.now();
      try {
        const data = await operation(input);
        logEvent('mcp_json_tool', { tool: name, result: 'success', durationMs: Date.now() - started });
        return { content: [{ type: 'text', text: data.diagram?.url ? `Completed. ${data.diagram.url}` : 'Completed; see structuredContent.' }], structuredContent: { ok: true, ...data } };
      } catch (error) {
        const code = isAppError(error) ? error.code : 'INTERNAL_ERROR';
        logEvent('mcp_json_tool', { tool: name, result: 'error', code, durationMs: Date.now() - started });
        return { isError: true, content: [{ type: 'text', text: code }], structuredContent: { ok: false, error: { code, message: isAppError(error) ? error.message : 'BPMN JSON processing failed', ...(isAppError(error) && error.details !== undefined ? { details: error.details } : {}) } } };
      }
    });
  };
  register('list_diagrams', 'List diagram metadata and revisions without XML or JSON model content.', z.object({ query: z.string().max(200).optional(), folder_id: id.nullable().optional(), include_descendants: z.boolean().optional() }).strict(), false, async input => {
    let diagrams = await service.storage.list(input.query, input.folder_id ?? undefined, input.include_descendants ?? true);
    if (input.folder_id === null) diagrams = diagrams.filter(diagram => diagram.folderId === null);
    return { diagrams };
  });
  register('list_folders', 'List stable folder IDs, paths, counts and current catalogRevision.', z.object({}).strict(), false, () => service.storage.listFolders());
  register('get_diagram', 'Read summary, semantic, full or selected fragment JSON. Omit DI for token-efficient edits. Paginated results are never full replacements.', readSchema, false, ({ id: diagramId, ...options }) => service.read(diagramId, options));
  register('inspect_diagram', 'Read compact BPMN structure and validation without full XML or geometry.', z.object({ id }).strict(), false, ({ id: diagramId }) => service.read(diagramId, { scope: 'summary' }, true));
  register('describe_bpmn_types', 'Describe scalar, reference and containment properties of requested BPMN types.', z.object({ types: z.array(id).min(1).max(20) }).strict(), false, ({ types }) => service.pool.run({ kind: 'types', types }));
  register('validate_bpmn', 'Dry-run a complete JSON document or operations at an exact revision. Does not save or reserve the revision.', validateSchema, false, input => service.validate(input));
  register('create_diagram', 'Create a diagram from complete BPMN JSON, validating and generating DI by default.', createSchema, true, input => service.create(input));
  register('update_diagram', 'Atomically apply operations, replace a complete document, or change metadata at expected_revision. Never supply a fragment as replacement.', mutationSchema, true, input => service.update(input));
  register('duplicate_diagram', 'Copy original XML unchanged with a new diagram ID at the source revision; omitted folder/description are inherited.', z.object({ source_id: id, expected_revision: id, new_id: id, ...metadata, name: z.string().min(1).max(120) }).strict(), true, input => service.duplicate(input));
  register('create_folder', 'Create a root or nested folder at the current catalog revision.', z.object({ name: z.string().min(1).max(80), parent_id: id.nullable().optional(), expected_catalog_revision: id }).strict(), true, input => service.storage.createFolder({ name: input.name, parentId: input.parent_id, expectedCatalogRevision: input.expected_catalog_revision }));
  register('update_folder', 'Rename/move a folder. Omit parent_id to preserve its parent, null moves to root.', z.object({ id, name: z.string().min(1).max(80).optional(), parent_id: id.nullable().optional(), expected_catalog_revision: id }).strict(), true, input => service.storage.updateFolder(input.id, { name: input.name, parentId: input.parent_id, expectedCatalogRevision: input.expected_catalog_revision }));

  const resource = (name: string, uri: string, description: string, data: () => Promise<any>) => server.registerResource(name, uri, { description, mimeType: 'application/json' }, async url => ({ contents: [{ uri: url.href, mimeType: 'application/json', text: JSON.stringify(await data()) }] }));
  resource('catalog', 'bpmn-json://catalog', 'Current diagram and nested folder catalog', () => service.storage.getCatalog());
  resource('schema', 'bpmn-json://schema', 'BPMN JSON v1 complete-document JSON Schema', async () => z.toJSONSchema(documentSchema));
  server.registerResource('modeling-guide', 'bpmn-json://modeling-guide', { mimeType: 'text/plain' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: JSON_MODELING_GUIDE }] }));
  server.registerResource('type', new ResourceTemplate('bpmn-json://type/{qname}', { list: undefined }), { mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await service.pool.run({ kind: 'types', types: [decodeURIComponent(String(variables.qname))] })) }] }));
  return server;
}

export function createJsonMcpHandler(service: JsonBpmnService) {
  return createMcpHandler(() => buildServer(service), { legacy: 'stateless', responseMode: 'auto', onerror: () => logEvent('mcp_json_handler_error', { result: 'error' }) });
}
