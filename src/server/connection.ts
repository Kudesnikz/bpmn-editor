import { readFileSync } from 'node:fs';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildCodexConfig(mcpUrl: string, mcpApiKey: string, server: 'bpmn' | 'bpmn_json' = 'bpmn'): string {
  return [
    `[mcp_servers.${server}]`,
    `url = ${tomlString(mcpUrl)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${mcpApiKey}`)} }`,
    'default_tools_approval_mode = "writes"',
    'required = true'
  ].join('\n');
}

export const JSON_SKILL_MARKDOWN = readFileSync(new URL('../../skills/bpmn-json-modeler/SKILL.md', import.meta.url), 'utf8');
export const JSON_SKILL_CREATOR_PROMPT = `$skill-creator

Создай персональный instruction-only skill bpmn-json-modeler с автоматическим обнаружением для экспериментального MCP-сервера bpmn_json.
Используй приведённый SKILL.md: он задаёт экономное чтение фрагментов, точечные операции, ревизии и сохранение ручного layout.
Не добавляй scripts, references, assets или README. Не устанавливай и не изменяй MCP-подключения, токены или сервер; настройка подключения выполняется отдельно.

${JSON_SKILL_MARKDOWN}`;

export const CONNECTION_TOOLS = [
  ['list_diagrams', 'Каталог, поиск и ревизии'],
  ['list_folders', 'Дерево папок, ID и ревизия каталога'],
  ['get_diagram', 'XML, метаданные и ревизия'],
  ['inspect_diagram', 'Структура и качество без XML'],
  ['validate_bpmn', 'Проверка без сохранения'],
  ['create_diagram', 'Создание полной модели'],
  ['update_diagram', 'Изменение по актуальной ревизии'],
  ['duplicate_diagram', 'Безопасное создание копии'],
  ['create_folder', 'Создание корневой или вложенной папки'],
  ['update_folder', 'Переименование и перенос папки']
].map(([name, description]) => ({ name, description }));

export const JSON_CONNECTION_TOOLS = CONNECTION_TOOLS.map(tool => ({ ...tool, description: tool.name === 'get_diagram' ? 'JSON: обзор, семантика, фрагмент или полная модель' : tool.name === 'update_diagram' ? 'Атомарный пакет операций, полная замена или метаданные' : tool.name === 'validate_bpmn' ? 'Проверка JSON или операций без записи' : tool.description })).concat([{ name: 'describe_bpmn_types', description: 'Свойства и ссылки нужных BPMN-типов' }]);

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
  '- Before creating, call `list_folders` and `list_diagrams`. If the required folder is missing, create it explicitly with `create_folder` and the exact catalog revision.',
  '- Use stable folder IDs from `list_folders`; place or move diagrams with `folder_id`. Use `update_folder` to rename or move folders.',
  '- Before updating or duplicating, call `get_diagram` and use its exact revision. Use `inspect_diagram` when a compact structural view helps.',
  '- Preserve existing BPMN element IDs when their business meaning is unchanged.',
  '- Include complete BPMN DI. Prefer a readable left-to-right layout with minimal crossings.',
  '- Use lanes for roles in one process and pools for independent participants. Keep sequence flows inside one process; use message flows only between distinct participants.',
  '- For complex changes, call `validate_bpmn` before writing. Treat errors as blockers and review warnings.',
  '- On a revision conflict, reload the diagram and reconcile changes instead of overwriting blindly.',
  '- After create, update, or duplicate, return the editor URL.',
  '- Never attempt to delete a diagram or folder through MCP.'
].join('\n');

export const BPMN_SKILL_CREATOR_PROMPT = [
  '$skill-creator',
  '',
  'Создай персональный instruction-only skill `bpmn-mcp-modeler` с автоматическим обнаружением.',
  'Skill должен применяться при создании, изменении, инспекции, сравнении и проверке BPMN-диаграмм через настроенный MCP-сервер `bpmn`.',
  'Не добавляй scripts, references, assets или README.',
  '',
  'Закрепи в skill следующие правила:',
  '1. Перед созданием читать `list_folders` и `list_diagrams`; отсутствующую папку создавать явно через `create_folder` с точной `catalogRevision`.',
  '2. Использовать стабильные ID папок из `list_folders`; размещать диаграммы через `folder_id`, а папки переименовывать и переносить через `update_folder`.',
  '3. Перед обновлением или дублированием вызывать `get_diagram` и использовать точную revision; для компактного анализа применять `inspect_diagram`.',
  '4. Сохранять BPMN element ID, если бизнес-смысл элемента не изменился.',
  '5. Всегда включать полный BPMN DI и строить читаемую схему слева направо с минимумом пересечений.',
  '6. Использовать lanes для ролей одного процесса, pools для независимых участников, sequence flow только внутри процесса и message flow только между разными participants.',
  '7. Перед сложной записью вызывать `validate_bpmn`; ошибки блокируют запись, warnings нужно проверить.',
  '8. При конфликте revision перечитать диаграмму или каталог и согласовать изменения, не перезаписывая их вслепую.',
  '9. После создания, обновления или дублирования возвращать ссылку редактора.',
  '10. Никогда не пытаться удалять диаграммы или папки через MCP.'
].join('\n');
