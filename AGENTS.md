# AGENTS.md — BPMN MCP Editor contract

This repository contains a self-hosted BPMN editor, REST API, and Streamable HTTP MCP server.

## Runtime source of truth

- Runtime catalog: `${DATA_DIR}/index.json`.
- Runtime BPMN models: `${DATA_DIR}/<id>.bpmn`.
- `id` is stable lowercase kebab-case and is never accepted as a filesystem path.
- `diagrams/shop.bpmn` and `diagrams/return.bpmn` are image seed assets only. They are copied on the first start of an empty volume and are not the live production data.
- Never add GitHub persistence, client-side tokens, an embedded LLM, or a database unless the user explicitly changes the product scope.

## Application boundaries

- `/` and `/api/*`: HTTP Basic Auth.
- `/mcp`: Bearer token, exact allowed browser Origin or no Origin for server clients.
- `/healthz`: public and contains status/version only.
- The web UI may create, update, duplicate, and delete diagrams.
- MCP may list, get, validate, create, and update diagrams. MCP must not expose deletion.
- All writes require BPMN validation. Updates and deletes require the current SHA-256 revision.
- Writes use a temporary file plus atomic rename; catalog mutations stay serialized.

## BPMN modeling rules

- Read the current diagram before updating it and use its exact revision.
- Preserve element IDs when the business meaning remains unchanged.
- Every saved diagram needs BPMN DI with a plane, shapes, edges, and at least two waypoints per flow edge.
- Use lanes for roles within one process and pools/participants for independent parties.
- Keep sequence flow within one process/pool; use message flow only between distinct participants.
- Prefer a readable left-to-right layout with minimal crossings.

## Development

- Server: Node.js 22, TypeScript, Express, MCP TypeScript SDK v2, `bpmn-moddle`.
- Client: Vite, vanilla JavaScript, `bpmn-js`.
- Package manager: pnpm 10.15.1.
- Production target: the multi-stage `Dockerfile` and a persistent volume at `/data/diagrams`.
- Before handing off changes, run `pnpm build` and `pnpm test`. For container changes, also build and health-check the image when Docker is available.
- Do not log secrets or complete BPMN XML.
