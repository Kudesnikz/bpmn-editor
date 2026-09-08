---
name: bpmn-json-modeler
description: Create, edit, inspect, compare and validate BPMN diagrams through the experimental bpmn_json MCP server using compact JSON fragments and revision-checked operations.
---

# BPMN JSON Modeler

Use the configured `bpmn_json` server. The editor and storage remain XML; do not maintain a second JSON file or switch to XML MCP without the user's agreement.

## Read only the context needed

- Before creating, inspect `list_folders` and `list_diagrams`. Folder IDs are stable; create missing folders with `create_folder` and the exact `catalogRevision` as `expected_catalog_revision`.
- For an existing model start with `get_diagram(scope="summary")` or `inspect_diagram`. Before editing, read a `fragment` selected by element IDs, container, types or query, normally without DI and with one hop of neighbors. Check the containing process, lanes and relevant conditions.
- Paginated reads share a revision. Follow `nextCursor` only with the same selection; restart reading on conflict. `selectionComplete` is not `documentComplete`. A fragment/page is not a replacement document.
- Request `describe_bpmn_types` only for unfamiliar types you actually need. The schema and modeling guide are resources; do not fetch the whole type system for every edit.

## Make precise changes

- Prefer `update_diagram(mode="operations")`. Preserve element IDs whose business meaning is unchanged. Pass the exact read revision in `expected_revision`.
- Use `insert_task_on_flow` to add a task between two nodes, `connect`/`reconnect_flow` for connections and `update_properties` for scalar properties. Let the server maintain incoming/outgoing references. Batch related changes; a failed operation prevents the entire write.
- Use `mode="metadata"` separately for diagram name, description or `folder_id`; `folder_id: null` moves it to the root. Use `update_folder` with the latest catalog revision to rename or move a folder.
- Full replacement is exceptional: obtain the complete document and explicitly select `auto` or `provided` layout. Never submit the document field from a fragment or incomplete page as a replacement.
- Preserve conditions, event definitions and opaque extension data. If the server reports unsupported/lossy conversion, report the limitation; do not simplify away unknown data to force a successful write.

## Preserve readable geometry and BPMN semantics

- Existing edits default to `preserve`: retain hand-arranged shapes and containers. Request DI only when geometry is relevant. `auto` is the default for creating a new diagram.
- On `RELAYOUT_REQUIRED`, explain the reported process/collaboration scope and obtain permission before widening the rearrangement. Alternatively provide explicit DI. Do not silently retry with global auto-layout.
- Use lanes for roles of one process, pools for independent participants. Sequence flow stays within its process/subprocess scope; message flow connects distinct participants in one collaboration. Boundary events attach to activities in the same scope.
- Dry-run complex JSON/operation changes through `validate_bpmn`; inspect warnings as well as errors. Validation does not reserve a revision.
- On a revision conflict, reread affected content and reconcile. Never blindly retry against the new revision. If another concurrent change prevents safe reconciliation, stop and ask the user.

After a successful write return `diagram.url` and a short change summary. Do not reread or repeat the full model just to confirm success. Diagram/folder deletion is unavailable through MCP. Removing a BPMN element within a diagram is a separate, explicitly requested edit; never cascade-delete unrelated business elements.
