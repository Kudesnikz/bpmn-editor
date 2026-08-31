import {
  createMcpHandler,
  McpServer,
  ResourceTemplate,
  type CallToolResult,
  type McpHttpHandler
} from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { AppConfig } from './config.js';
import { isAppError } from './errors.js';
import { logError, logEvent } from './logger.js';
import type { DiagramStorage } from './storage.js';

const MODELING_GUIDE = `BPMN modeling rules:
- Before creating, inspect available groups and diagrams. A new non-empty group value creates that group implicitly.
- Always read the current diagram before updating or duplicating it. Use inspect_diagram when a compact structural view is useful.
- Preserve element IDs when their business meaning remains unchanged.
- Every model must include BPMN DI: BPMNDiagram, BPMNPlane, shapes, edges, and waypoints.
- Use lanes for roles in one process and pools/participants for independent parties.
- Sequence flows stay inside one process/pool. Message flows connect distinct participants.
- Prefer semantically correct events, tasks, gateways, subprocesses, boundary events, and message interactions.
- Lay out the primary flow left-to-right with readable labels and minimal crossings.
- The server has no delete tool. Destructive deletion is available only to a human in the web editor.`;

const INSTRUCTIONS = `Before any update or duplicate, call get_diagram and pass its exact revision. Preserve element IDs when meaning is unchanged. Every saved model must be valid BPMN 2.0 with complete BPMN DI. Use lanes for roles, pools for independent participants, sequence flows only within a pool, and message flows only between distinct participants. Never delete diagrams through MCP. After create, update, or duplicate, return the editor URL.\n\n${MODELING_GUIDE}`;

function success(message: string, data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { ok: true, ...data }
  };
}

function failure(error: unknown): CallToolResult {
  const code = isAppError(error) ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: {
      ok: false,
      error: { code, message, ...(isAppError(error) && error.details !== undefined ? { details: error.details } : {}) }
    }
  };
}

async function runTool(
  name: string,
  diagramId: string | undefined,
  operation: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    logEvent('mcp_tool_call', { tool: name, diagramId, result: 'success', durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    logError('mcp_tool_call_failed', error, { tool: name, diagramId, result: 'error', durationMs: Date.now() - startedAt });
    return failure(error);
  }
}

function buildServer(storage: DiagramStorage, config: AppConfig): McpServer {
  const server = new McpServer(
    { name: 'bpmn-mcp-editor', version: '1.0.0', title: 'BPMN MCP Editor' },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool('list_diagrams', {
    title: 'List BPMN diagrams',
    description: 'List available diagrams and their current revisions. Does not return XML.',
    inputSchema: z.object({
      query: z.string().optional().describe('Optional text search over id, name, group, and description'),
      group: z.string().optional().describe('Optional exact group filter')
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, ({ query, group }) => runTool('list_diagrams', undefined, async () => {
    const diagrams = await storage.list(query, group);
    return success(`Found ${diagrams.length} BPMN diagram(s).`, { diagrams });
  }));

  server.registerTool('list_groups', {
    title: 'List BPMN groups',
    description: 'List distinct non-empty diagram groups and diagram counts. Groups are metadata and exist only while they contain diagrams.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, () => runTool('list_groups', undefined, async () => {
    const result = await storage.listGroups();
    return success(`Found ${result.groups.length} BPMN group(s).`, {
      groups: result.groups,
      ungroupedCount: result.ungroupedCount
    });
  }));

  server.registerTool('get_diagram', {
    title: 'Get a BPMN diagram',
    description: 'Read current BPMN XML, metadata, editor URL, and revision. Always call this before update_diagram.',
    inputSchema: z.object({ id: z.string().describe('Stable lowercase kebab-case diagram id') }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, ({ id }) => runTool('get_diagram', id, async () => {
    const diagram = await storage.get(id);
    return success(`Loaded ${diagram.name}. Current revision: ${diagram.revision}`, { diagram });
  }));

  server.registerTool('inspect_diagram', {
    title: 'Inspect a BPMN diagram',
    description: 'Return current metadata, revision, structural graph, BPMN DI coverage, and validation issues without returning full XML.',
    inputSchema: z.object({ id: z.string().describe('Stable lowercase kebab-case diagram id') }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, ({ id }) => runTool('inspect_diagram', id, async () => {
    const inspection = await storage.inspect(id);
    return success(`Inspected ${inspection.diagram.name}. Current revision: ${inspection.diagram.revision}`, { inspection });
  }));

  server.registerTool('validate_bpmn', {
    title: 'Validate BPMN XML',
    description: 'Validate BPMN 2.0 XML, semantics, references, and BPMN DI without saving anything.',
    inputSchema: z.object({ xml: z.string().describe('Complete BPMN 2.0 XML') }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }, ({ xml }) => runTool('validate_bpmn', undefined, async () => {
    const validation = await storage.validate(xml);
    return success(validation.valid ? 'BPMN XML is valid.' : 'BPMN XML is invalid.', { validation });
  }));

  server.registerTool('create_diagram', {
    title: 'Create a BPMN diagram',
    description: 'Validate and atomically create a new BPMN file and catalog entry. XML must include complete BPMN DI.',
    inputSchema: z.object({
      id: z.string().describe('New stable lowercase kebab-case id'),
      name: z.string().min(1).max(120),
      group: z.string().max(80).optional(),
      description: z.string().max(500).optional(),
      xml: z.string().describe('Complete BPMN 2.0 XML including BPMN DI')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, input => runTool('create_diagram', input.id, async () => {
    const result = await storage.create(input);
    return success(`Created ${result.diagram.name}. Open: ${result.diagram.url}`, result);
  }));

  server.registerTool('update_diagram', {
    title: 'Update a BPMN diagram',
    description: 'Validate and atomically update XML and/or metadata. Requires the exact revision returned by get_diagram.',
    inputSchema: z.object({
      id: z.string().describe('Existing diagram id'),
      expected_revision: z.string().describe('Exact revision returned by get_diagram'),
      name: z.string().min(1).max(120).optional(),
      group: z.string().max(80).optional(),
      description: z.string().max(500).optional(),
      xml: z.string().optional().describe('Complete replacement BPMN XML including BPMN DI')
    }).refine(value => value.xml !== undefined || value.name !== undefined || value.group !== undefined || value.description !== undefined, {
      message: 'At least one of xml, name, group, or description is required'
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, ({ id, expected_revision, ...changes }) => runTool('update_diagram', id, async () => {
    const result = await storage.update(id, { expectedRevision: expected_revision, ...changes });
    return success(`Updated ${result.diagram.name}. Open: ${result.diagram.url}`, result);
  }));

  server.registerTool('duplicate_diagram', {
    title: 'Duplicate a BPMN diagram',
    description: 'Atomically duplicate an existing diagram without changing BPMN element IDs. Requires the exact source revision.',
    inputSchema: z.object({
      source_id: z.string().describe('Existing source diagram id'),
      expected_revision: z.string().describe('Exact revision returned by get_diagram'),
      new_id: z.string().describe('New stable lowercase kebab-case id'),
      name: z.string().min(1).max(120),
      group: z.string().max(80).optional().describe('Defaults to the source group when omitted'),
      description: z.string().max(500).optional().describe('Defaults to the source description when omitted')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  }, ({ source_id, expected_revision, new_id, name, group, description }) => runTool('duplicate_diagram', source_id, async () => {
    const source = await storage.get(source_id);
    const result = await storage.duplicate(source_id, {
      id: new_id,
      name,
      group: group === undefined ? source.group : group,
      description: description === undefined ? source.description : description,
      expectedRevision: expected_revision
    });
    return success(`Duplicated ${source.name} as ${result.diagram.name}. Open: ${result.diagram.url}`, result);
  }));

  server.registerResource('bpmn-catalog', 'bpmn://catalog', {
    title: 'BPMN diagram catalog',
    description: 'Current diagram catalog and revisions',
    mimeType: 'application/json'
  }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ diagrams: await storage.list() }, null, 2) }]
  }));

  server.registerResource('bpmn-modeling-guide', 'bpmn://modeling-guide', {
    title: 'BPMN modeling guide',
    description: 'Repository-independent semantic and layout rules for models saved by this server',
    mimeType: 'text/plain'
  }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: MODELING_GUIDE }] }));

  server.registerResource('bpmn-diagram', new ResourceTemplate('bpmn://diagram/{id}', {
    list: async () => ({
      resources: (await storage.list()).map(diagram => ({
        uri: `bpmn://diagram/${diagram.id}`,
        name: diagram.name,
        description: diagram.description,
        mimeType: 'application/xml'
      }))
    }),
    complete: {
      id: async value => (await storage.list(value)).map(diagram => diagram.id)
    }
  }), {
    title: 'BPMN diagram',
    description: 'Complete BPMN XML and metadata for one diagram',
    mimeType: 'application/json'
  }, async (uri, variables) => {
    const diagram = await storage.get(String(variables.id));
    return {
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(diagram, null, 2) }]
    };
  });

  return server;
}

export function createBpmnMcpHandler(storage: DiagramStorage, config: AppConfig): McpHttpHandler {
  return createMcpHandler(() => buildServer(storage, config), {
    legacy: 'stateless',
    responseMode: 'auto',
    onerror: error => logError('mcp_handler_error', error)
  });
}
