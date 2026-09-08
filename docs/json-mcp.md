# Experimental BPMN JSON MCP v1

`/mcp-json` is opt-in (`ENABLE_JSON_MCP=true`). It uses the same Bearer key, exact allowed Origin and shared rate limiter as `/mcp`. Turning it off leaves the editor, stored XML and existing XML MCP unchanged. Use copies when evaluating experimental changes. No migration or JSON sidecar files are created.

## Document format

This is an application-specific versioned projection of BPMN, not a universal JSON BPMN standard:

```json
{
  "format": "bpmn-json",
  "version": 1,
  "rootId": "Definitions_1",
  "namespaces": { "bpmn": "http://www.omg.org/spec/BPMN/20100524/MODEL" },
  "elements": {
    "Definitions_1": {
      "type": "bpmn:Definitions",
      "properties": { "targetNamespace": "urn:example", "rootElements": ["Process_1"] }
    },
    "Process_1": { "type": "bpmn:Process", "properties": { "flowElements": ["Start_1"] } },
    "Start_1": { "type": "bpmn:StartEvent", "properties": { "name": "Начало" } }
  }
}
```

This semantic-only example needs auto layout to become a stored diagram. An ID-bearing element appears exactly once in `elements`. Typed references contain IDs. Typed containment either contains an ID or an anonymous `{type, properties}` object. Containment order is retained; unknown properties/types and broken references fail. Catalog metadata (`id`, `name`, `folder_id`, `description`) is outside the document.

`describe_bpmn_types` describes requested metamodel properties, including whether each is a scalar, reference or containment and whether it has multiple values. The complete-document schema is available at `bpmn-json://schema`; individual type descriptors at `bpmn-json://type/{qname}`. Other resources: `bpmn-json://catalog`, `bpmn-json://modeling-guide`.

The codec checks round-trip preservation independently of moddle's graph. Text/CDATA content and namespace-aware extension trees are retained, including mixed content. Extension business semantics are not interpreted. Unknown constructs that cannot survive conversion cause a refusal, never a best-effort lossy write. Whitespace formatting, comments, attribute order and equivalent namespace prefixes are not a byte-preservation contract. Definitions currently need an ID; models outside the normalized format's supported ID/structure limits are rejected by JSON tools, not rewritten automatically.

## Read contract

`get_diagram` requires `id` and `scope`:

- `summary`: statistics and metadata/revision, without model contents.
- `semantic`: normalized model without DI.
- `full`: includes DI.
- `fragment`: selected element IDs, container, types and/or name/ID query; filters combine. `neighbor_depth` is 0–2 (default 1). `include_di` defaults to false.

```json
{
  "id": "shop",
  "scope": "fragment",
  "selector": { "element_ids": ["Task_Pay"], "neighbor_depth": 1 }
}
```

Responses contain `revision`, `diagram` metadata, `scope`, `omittedSections`, `selectionComplete` and `documentComplete`. Non-summary pages additionally contain `document`, shallow parent context, external reference IDs, offsets and possibly `nextCursor`. `complete` is an alias of `selectionComplete`, not proof of a full document. A fragment remains a fragment even if its selection is complete. A full response is individually complete only when it contains the entire document in one page. Reconstructing a larger document requires every page at the same revision.

Page size is at most 100 indexed elements and 256 KiB including context. Cursor, filters and revision must match; a revision change requires restarting pagination. An individually oversized element or context returns `RESPONSE_TOO_LARGE` instead of silent truncation.

`inspect_diagram` returns process/collaboration structure, lanes, nodes, flows, DI statistics and bounded validation without full XML/DI. If the inspection exceeds the response limit, request a selected fragment instead.

## Write contract

`create_diagram`: diagram metadata plus a complete `document`; layout defaults to `auto`.

`update_diagram`: `id`, exact `expected_revision` and exactly one mode:

- `operations`: a batch of 1–200 operations. No document or catalog metadata.
- `replace`: complete document and explicit `layout.mode=auto|provided`. No operations or catalog metadata.
- `metadata`: name, description and/or folder_id. No document, operations or layout; XML bytes remain unchanged.

```json
{
  "id": "shop",
  "expected_revision": "REVISION_FROM_READ",
  "mode": "operations",
  "operations": [
    { "op": "update_properties", "element_id": "Task_Pay", "set": { "name": "Оплатить картой" } }
  ]
}
```

Operation names:

- `update_properties`: `element_id`, optional `set`/`unset`; use dedicated operations for indexed containment and references.
- `add_element`: `element_id`, `element`, `parent_id`, containment `property`; optional `lane_id`/`after_id` hints.
- `set_reference`: `element_id`, `property`, `value` (ID, ID array or null to unset).
- `connect`: `element_id`, flow `type`, `source_id`, `target_id`, `parent_id`, optional properties.
- `reconnect_flow`: `element_id`, new source_id and/or target_id.
- `insert_task_on_flow`: `flow_id`, `task: {id,type,name,properties?}`, `new_flow_id`, optional lane_id. Original flow ID and condition are preserved; server maintains incoming/outgoing.
- `move_element`: element_id, optional parent_id/property and lane_id/after_id. Explicit null lane_id removes lane membership.
- `remove_element`: element_id and optional cascade. Cascade is limited to related flow/DI objects and reference cleanup, not arbitrary business nodes. Handle subprocess contents and attached boundary events explicitly first.
- `reorder_children`: element_id, containment property, all current child IDs exactly once.
- `replace_extensions`: element_id and namespace-aware XML-tree extensions.
- `set_bounds` / `set_waypoints`: element_id and geometry; plane_id is required when representation is ambiguous.

A batch applies to the full server snapshot even if the client only read a fragment. A failed operation prevents the entire write. The error identifies its operation index where applicable. Successful writes return metadata, new revision, changed/removed IDs, affected layout scopes, bounded validation and editor URL, not a full XML/JSON echo.

`validate_bpmn` accepts either a complete document or operations plus id/expected_revision. It uses the same preparation path without a write. Conversion, operation and layout failures are MCP tool errors; ordinary BPMN validation results contain `valid`, bounded errors/warnings and total counts. Validation does not reserve a revision.

`duplicate_diagram` checks the source revision, copies original XML unchanged and inherits omitted folder/description. Folder tools match the existing stable-ID/catalog-revision workflow. There are no diagram/folder deletion tools.

## Geometry and concurrency

- `preserve` is the default for edits: no movement of existing shapes/containers; new nodes use free space and affected flows are rerouted. If impossible, `RELAYOUT_REQUIRED` identifies the affected scope.
- `auto` explicitly regenerates DI for whole independent processes or collaborations. Only DI is merged from the layout engine, never its semantic model. `scope_ids`, if specified for operations, must cover every affected layout root. Complete documents require whole-model auto layout.
- `provided` uses supplied DI. It must still pass validation; plane_id selects among multiple representations where necessary.

Heavy preparation runs outside the storage mutex in a worker. The XML/revision snapshot is read consistently; at commit the current revision is checked again under the same mutex as REST and XML MCP writes. `REVISION_CONFLICT` means reread and reconcile. Do not replace expected_revision with the new value and retry blindly.

Limits: configured XML size (default 2 MiB), 4 MiB model JSON, 5000 indexed elements, 128 structural nesting levels, 200 operations, one worker with four queued jobs, 15-second total queue/computation deadline, 256 MiB old-generation worker heap. Queue overload/timeouts do not write files. These limits are independent of folder-tree depth. The process must not run multiple replicas against one volume: the mutex is in-process.

Writes use temporary files plus rename. This does not promise crash-atomicity across both catalog and diagram files; retain external volume backups. No internal version history is introduced.

## Verification and rollout

Run `pnpm build`, `pnpm test`, then build/health-check the production Docker image. Test browser rendering, copying connection materials and PNG, then check JSON edits on copies. Existing diagrams must not be batch-normalized on startup. Preserve the runtime volume through every deployment and rollback.

Measure token costs for complete equivalent scenarios, including reads, writes, tool schemas and retries. Full JSON can be as large as XML; the expected benefit comes from scoped reads and small operations, not a guaranteed compression ratio.

### Reproducible artifact benchmark (2026-09-08)

Run `pnpm benchmark:json`. It starts both MCP endpoints against disposable data and measures actual serialized tool requests/results with `js-tiktoken@1.0.21`, encoding `o200k_base`. XML and JSON use the same final semantic changes and geometry. Fixture setup is excluded. These are artifact token counts, **not actual billed model usage**: user prompts, hidden reasoning, provider framing/caching and the optional skill are excluded. All measured scenarios succeeded without retries. Discovery includes tool schemas and server instructions once (XML: 1,781 tokens; JSON: 6,037).

| Scenario | XML exchange | JSON exchange | XML + discovery | JSON + discovery |
| --- | ---: | ---: | ---: | ---: |
| Rename a task in shop | 8,922 | 888 | 10,703 | 6,925 |
| Insert task on a flow in shop | 9,659 | 1,047 | 11,440 | 7,084 |
| Change gateway condition, including validation | 4,988 | 1,081 | 6,769 | 7,118 |
| Create small process, including catalog reads/validation | 3,889 | 1,270 | 5,670 | 7,307 |
| Read subprocess context | 1,592 | 452 | 3,373 | 6,489 |

The existing XML endpoint's `inspect_diagram` costs only 481 exchange tokens (2,262 with discovery) for the small subprocess fixture, so JSON is not automatically the cheapest analysis path. Fragment/operation exchanges are substantially smaller here, but initial schema overhead can outweigh savings for small one-off tasks. Repeated editing and larger models are the intended use case. Exact counts may vary slightly with timestamps/revisions; do not extrapolate these fixtures to a universal percentage.
