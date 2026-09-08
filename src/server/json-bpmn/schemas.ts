import { z } from 'zod/v4';

const id = z.string().min(1).max(512);
const values = z.record(z.string(), z.unknown());
const entry = z.object({ type: id, properties: values, attributes: z.record(z.string(), z.string()).optional(), extensions: z.array(z.unknown()).optional() }).strict();
export const documentSchema = z.object({
  format: z.literal('bpmn-json'), version: z.literal(1), rootId: id,
  namespaces: z.record(z.string(), z.string()), elements: z.record(z.string(), entry)
}).strict().describe('Complete normalized document, never a paginated/fragment response. References use element IDs; anonymous typed children are inline.');

export const layoutSchema = z.object({ mode: z.enum(['preserve', 'auto', 'provided']), plane_id: id.optional(), scope_ids: z.array(id).min(1).max(50).optional() }).strict();
const point = z.object({ x: z.number(), y: z.number() }).strict();
export const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('update_properties'), element_id: id, set: values.optional(), unset: z.array(id).optional() }).strict(),
  z.object({ op: z.literal('add_element'), element_id: id, element: entry, parent_id: id, property: id, after_id: id.optional(), lane_id: id.optional() }).strict(),
  z.object({ op: z.literal('set_reference'), element_id: id, property: id, value: z.union([id, z.array(id), z.null()]) }).strict(),
  z.object({ op: z.literal('connect'), element_id: id, type: z.enum(['bpmn:SequenceFlow', 'bpmn:MessageFlow', 'bpmn:Association']), source_id: id, target_id: id, parent_id: id, properties: values.optional() }).strict(),
  z.object({ op: z.literal('reconnect_flow'), element_id: id, source_id: id.optional(), target_id: id.optional() }).strict(),
  z.object({ op: z.literal('insert_task_on_flow'), flow_id: id, task: z.object({ id, type: id, name: z.string(), properties: values.optional() }).strict(), new_flow_id: id, lane_id: id.optional() }).strict(),
  z.object({ op: z.literal('move_element'), element_id: id, parent_id: id.optional(), property: id.optional(), lane_id: id.nullable().optional(), after_id: id.optional() }).strict(),
  z.object({ op: z.literal('remove_element'), element_id: id, cascade: z.boolean().default(false).describe('Only related flows and DI; business children and boundary hosts must be handled explicitly.') }).strict(),
  z.object({ op: z.literal('reorder_children'), element_id: id, property: id, ids: z.array(id) }).strict(),
  z.object({ op: z.literal('replace_extensions'), element_id: id, extensions: z.array(z.unknown()) }).strict(),
  z.object({ op: z.literal('set_bounds'), element_id: id, plane_id: id.optional(), bounds: point.extend({ width: z.number().positive(), height: z.number().positive() }).strict() }).strict(),
  z.object({ op: z.literal('set_waypoints'), element_id: id, plane_id: id.optional(), waypoints: z.array(point).min(2).max(1000) }).strict()
]);

export const readSchema = z.object({
  id,
  scope: z.enum(['summary', 'semantic', 'full', 'fragment']),
  selector: z.object({ element_ids: z.array(id).min(1).max(100).optional(), container_id: id.optional(), types: z.array(id).min(1).max(50).optional(), query: z.string().min(1).max(200).optional(), neighbor_depth: z.number().int().min(0).max(2).optional(), include_di: z.boolean().optional() }).strict().optional(),
  cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(100).optional()
}).strict();
export const metadata = { name: z.string().min(1).max(120).optional(), folder_id: id.nullable().optional(), description: z.string().max(500).optional() };
export const mutationSchema = z.object({
  id, expected_revision: id, mode: z.enum(['operations', 'replace', 'metadata']),
  operations: z.array(operationSchema).min(1).max(200).optional(), document: documentSchema.optional(), layout: layoutSchema.optional(), ...metadata
}).strict();
export const createSchema = z.object({ id, ...metadata, name: z.string().min(1).max(120), document: documentSchema, layout: layoutSchema.optional() }).strict();
export const validateSchema = z.object({
  id: id.optional(), expected_revision: id.optional(), operations: z.array(operationSchema).min(1).max(200).optional(), document: documentSchema.optional(), layout: layoutSchema.optional()
}).strict();
