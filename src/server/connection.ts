function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildCodexConfig(mcpUrl: string, mcpApiKey: string): string {
  return [
    '[mcp_servers.bpmn]',
    `url = ${tomlString(mcpUrl)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${mcpApiKey}`)} }`,
    'default_tools_approval_mode = "writes"',
    'required = true'
  ].join('\n');
}

export const BPMN_SKILL_MARKDOWN = [
  '---',
  'name: bpmn-mcp-modeler',
  'description: Create, update, inspect, compare, and validate BPMN diagrams through the configured bpmn MCP server. Use for BPMN modeling work that must read or write diagrams in the BPMN MCP Editor.',
  '---',
  '',
  '# BPMN MCP Modeler',
  '',
  'Use the configured `bpmn` MCP server as the source of truth.',
  '',
  '- Before creating, call `list_groups` and `list_diagrams`. A new non-empty `group` value creates that group implicitly.',
  '- Before updating or duplicating, call `get_diagram` and use its exact revision. Use `inspect_diagram` when a compact structural view helps.',
  '- Preserve existing BPMN element IDs when their business meaning is unchanged.',
  '- Include complete BPMN DI. Prefer a readable left-to-right layout with minimal crossings.',
  '- Use lanes for roles in one process and pools for independent participants. Keep sequence flows inside one process; use message flows only between distinct participants.',
  '- For complex changes, call `validate_bpmn` before writing. Treat errors as blockers and review warnings.',
  '- On a revision conflict, reload the diagram and reconcile changes instead of overwriting blindly.',
  '- After create, update, or duplicate, return the editor URL.',
  '- Never attempt to delete a diagram through MCP.'
].join('\n');

export const BPMN_SKILL_CREATOR_PROMPT = [
  '$skill-creator',
  '',
  'Создай персональный instruction-only skill `bpmn-mcp-modeler` с автоматическим обнаружением.',
  'Skill должен применяться при создании, изменении, инспекции, сравнении и проверке BPMN-диаграмм через настроенный MCP-сервер `bpmn`.',
  'Не добавляй scripts, references, assets или README.',
  '',
  'Закрепи в skill следующие правила:',
  '1. Перед созданием читать `list_groups` и `list_diagrams`; новая непустая строка `group` создаёт группу автоматически.',
  '2. Перед обновлением или дублированием вызывать `get_diagram` и использовать точную revision; для компактного анализа применять `inspect_diagram`.',
  '3. Сохранять BPMN element ID, если бизнес-смысл элемента не изменился.',
  '4. Всегда включать полный BPMN DI и строить читаемую схему слева направо с минимумом пересечений.',
  '5. Использовать lanes для ролей одного процесса, pools для независимых участников, sequence flow только внутри процесса и message flow только между разными participants.',
  '6. Перед сложной записью вызывать `validate_bpmn`; ошибки блокируют запись, warnings нужно проверить.',
  '7. При конфликте revision перечитать диаграмму и согласовать изменения, не перезаписывая их вслепую.',
  '8. После создания, обновления или дублирования возвращать ссылку редактора.',
  '9. Никогда не пытаться удалять диаграммы через MCP.'
].join('\n');
