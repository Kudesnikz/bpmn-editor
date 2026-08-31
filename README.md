# BPMN MCP Editor

Небольшой self-hosted BPMN 2.0 редактор с удалённым MCP. Веб-интерфейс и REST API защищены HTTP Basic Auth, MCP — отдельным Bearer-ключом. Диаграммы хранятся как `.bpmn`-файлы в Docker volume, без базы данных и зависимости от GitHub.

## Возможности

- каталог, поиск и группировка диаграмм;
- ручное редактирование на `bpmn-js`, undo/redo, zoom и PNG-экспорт;
- создание, свойства, дублирование и безопасное удаление;
- атомарные записи и optimistic locking по SHA-256 `revision`;
- строгая проверка BPMN XML и BPMN DI через `bpmn-moddle`;
- Streamable HTTP MCP на едином endpoint `/mcp`;
- MCP tools: `list_diagrams`, `get_diagram`, `validate_bpmn`, `create_diagram`, `update_diagram`;
- MCP resources: `bpmn://catalog`, `bpmn://diagram/{id}`, `bpmn://modeling-guide`;
- один production-контейнер на Node.js 22, запуск от непривилегированного пользователя.

## Быстрый запуск

1. Скопируйте пример настроек:

   ```bash
   cp .env.example .env
   ```

2. Задайте в `.env` реальный HTTPS-адрес, имя, длинный пароль и случайный MCP-ключ.

3. Запустите:

   ```bash
   docker compose up -d --build
   ```

Контейнер слушает порт `3000`; compose публикует его только на `127.0.0.1:${HOST_PORT}`. TLS и публичный HTTPS должен завершать внешний Caddy, Nginx или Traefik.

## Переменные окружения

| Переменная | Обязательно | Значение |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | да | Публичный URL без конечного `/` |
| `WEB_USERNAME` | да | Basic Auth login |
| `WEB_PASSWORD` | да | Basic Auth password |
| `MCP_API_KEY` | да | Bearer-ключ для `/mcp` |
| `PORT` | нет | Порт внутри контейнера, по умолчанию `3000` |
| `DATA_DIR` | нет | Каталог volume, по умолчанию `/data/diagrams` |
| `MCP_RATE_LIMIT_PER_MINUTE` | нет | Лимит MCP-запросов, по умолчанию `60` |
| `MAX_BPMN_BYTES` | нет | Максимальный XML, по умолчанию `2097152` |

При пустом `WEB_PASSWORD` или `MCP_API_KEY` сервер не запускается. Замена секретов выполняется через `.env` и перезапуск контейнера.

## Данные и backup

Volume `bpmn_diagrams` монтируется в `/data/diagrams`:

```text
/data/diagrams/
├── index.json
├── shop.bpmn
└── return.bpmn
```

Два примера копируются только если `index.json` ещё не существует. Приложение не ведёт историю и не создаёт резервные копии: настройте внешний backup volume.

## Подключение Codex

Задайте тот же MCP-ключ в окружении клиента:

```bash
export BPMN_MCP_API_KEY="..."
```

И добавьте в Codex `config.toml`:

```toml
[mcp_servers.bpmn]
url = "https://bpmn.example.ru/mcp"
bearer_token_env_var = "BPMN_MCP_API_KEY"
default_tools_approval_mode = "writes"
required = true
```

После работы нейросети нажмите «Обновить» в редакторе. Фонового polling нет.

## Локальная разработка

Требуется Node.js 22 и pnpm 10.15.1.

```bash
pnpm install
PUBLIC_BASE_URL=http://127.0.0.1:3000 \
WEB_USERNAME=admin \
WEB_PASSWORD=dev-password \
MCP_API_KEY=dev-mcp-key \
pnpm dev
```

Проверки:

```bash
pnpm build
pnpm test
```

Не коммитьте `.env`, секреты и содержимое runtime-volume.
