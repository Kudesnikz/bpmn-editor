import BpmnModeler from 'bpmn-js/lib/Modeler';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';
import './styles.css';
import { setupPngExport } from './export.js';

const modeler = new BpmnModeler({ container: '#canvas' });
const $ = id => document.getElementById(id);
const elements = {
  status: $('status'), name: $('model-name'), description: $('model-description'), path: $('model-path'), revision: $('model-revision'),
  dirty: $('dirty-badge'), list: $('diagram-list'), count: $('diagram-count'), search: $('diagram-search'), sidebar: $('sidebar'),
  backdrop: $('sidebar-backdrop'), empty: $('empty-state'), save: $('save'), metadata: $('metadata'), duplicate: $('duplicate'),
  delete: $('delete'), copyLink: $('copy-link'), exportPng: $('export-png'), copyPng: $('copy-png'), undo: $('undo'), redo: $('redo')
};

let diagrams = [];
let folders = [];
let catalogRevision = '';
let currentDiagram = null;
let isLoading = false;
let isSaving = false;
let hasLocalChanges = false;
let serverConfig = null;
const expandedFolders = new Set(JSON.parse(localStorage.getItem('bpmn-expanded-folders') || '[]'));

function setStatus(message) { elements.status.textContent = message; }

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = body?.error?.code || 'HTTP_ERROR';
    error.details = body?.error?.details;
    throw error;
  }
  return body;
}

function isMobileLayout() { return window.matchMedia('(max-width: 900px)').matches; }
function openDialog(dialog) { typeof dialog.showModal === 'function' ? dialog.showModal() : dialog.setAttribute('open', ''); }
function closeDialog(dialog) { typeof dialog.close === 'function' ? dialog.close() : dialog.removeAttribute('open'); }

function setSidebarCollapsed(collapsed, { remember = true } = {}) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  elements.backdrop.hidden = collapsed || !isMobileLayout();
  if (remember && !isMobileLayout()) localStorage.setItem('bpmn-sidebar-collapsed', collapsed ? '1' : '0');
}

function initializeSidebar() {
  setSidebarCollapsed(isMobileLayout() || localStorage.getItem('bpmn-sidebar-collapsed') === '1', { remember: false });
}

function setDirty(value) {
  hasLocalChanges = value;
  elements.dirty.hidden = !value;
  document.title = `${value ? '• ' : ''}${currentDiagram?.name || 'BPMN MCP Editor'}`;
}

function setDiagramControls(enabled) {
  elements.save.disabled = !enabled || isLoading || isSaving;
  for (const element of [elements.metadata, elements.duplicate, elements.delete, elements.copyLink, elements.exportPng, elements.copyPng]) element.disabled = !enabled;
}

function updateHistoryButtons() {
  const stack = modeler.get('commandStack');
  elements.undo.disabled = !currentDiagram || !stack.canUndo();
  elements.redo.disabled = !currentDiagram || !stack.canRedo();
}

function setUrlDiagram(id) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('diagram', id); else url.searchParams.delete('diagram');
  window.history.replaceState({}, '', url);
  if (id) localStorage.setItem('bpmn-last-diagram', id);
}

function searchableText(diagram) {
  return [diagram.id, diagram.name, diagram.description, ...(diagram.folderPath || []).map(item => item.name)]
    .filter(Boolean).join(' ').toLocaleLowerCase('ru');
}

function rememberExpandedFolders() {
  localStorage.setItem('bpmn-expanded-folders', JSON.stringify([...expandedFolders]));
}

function renderDiagramItem(diagram) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `diagram-item${diagram.id === currentDiagram?.id ? ' active' : ''}`;
  button.dataset.diagramId = diagram.id;
  button.setAttribute('aria-current', diagram.id === currentDiagram?.id ? 'page' : 'false');
  const name = document.createElement('span');
  name.className = 'diagram-item-name';
  name.textContent = diagram.name;
  button.appendChild(name);
  if (diagram.description) {
    const description = document.createElement('span');
    description.className = 'diagram-item-description';
    description.textContent = diagram.description;
    button.appendChild(description);
  }
  button.addEventListener('click', () => void selectDiagram(diagram.id));
  return button;
}

function renderRootSection(rootDiagrams, query) {
  if (!rootDiagrams.length && query) return;
  const section = document.createElement('section');
  section.className = 'folder-node root-folder';
  const title = document.createElement('div');
  title.className = 'folder-row';
  const label = document.createElement('span');
  label.className = 'folder-name';
  label.textContent = 'Без папки';
  const count = document.createElement('span');
  count.className = 'folder-count';
  count.textContent = String(rootDiagrams.length);
  title.append(label, count);
  section.appendChild(title);
  const content = document.createElement('div');
  content.className = 'folder-contents';
  for (const diagram of rootDiagrams) content.appendChild(renderDiagramItem(diagram));
  section.appendChild(content);
  elements.list.appendChild(section);
}

function renderFolderNode(folder, parentContainer, directDiagrams, childFolders, query) {
  const node = document.createElement('section');
  node.className = 'folder-node';
  node.dataset.folderId = folder.id;
  const row = document.createElement('div');
  row.className = 'folder-row';
  const expanded = Boolean(query) || expandedFolders.has(folder.id);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'folder-toggle';
  toggle.textContent = expanded ? '▾' : '▸';
  toggle.setAttribute('aria-label', expanded ? 'Свернуть папку' : 'Развернуть папку');
  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = folder.name;
  name.title = folder.path.map(item => item.name).join(' / ');
  const count = document.createElement('span');
  count.className = 'folder-count';
  count.textContent = String(folder.totalDiagramCount);
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'folder-action';
  add.textContent = '+';
  add.title = 'Создать дочернюю папку';
  add.setAttribute('aria-label', `Создать папку внутри ${folder.name}`);
  const menu = document.createElement('button');
  menu.type = 'button';
  menu.className = 'folder-action';
  menu.textContent = '⋯';
  menu.title = 'Действия с папкой';
  menu.setAttribute('aria-label', `Действия с папкой ${folder.name}`);
  row.append(toggle, name, count, add, menu);
  node.appendChild(row);
  const content = document.createElement('div');
  content.className = 'folder-contents';
  content.hidden = !expanded;
  for (const diagram of directDiagrams) content.appendChild(renderDiagramItem(diagram));
  node.appendChild(content);
  parentContainer.appendChild(node);
  toggle.addEventListener('click', () => {
    if (expandedFolders.has(folder.id)) expandedFolders.delete(folder.id); else expandedFolders.add(folder.id);
    rememberExpandedFolders();
    renderCatalog();
  });
  add.addEventListener('click', () => openFolderDialog('create', folder.id));
  menu.addEventListener('click', () => openFolderDialog('edit', folder.id));
  return { content, children: childFolders };
}

function renderCatalog() {
  const query = elements.search.value.trim().toLocaleLowerCase('ru');
  const filtered = query ? diagrams.filter(diagram => searchableText(diagram).includes(query)) : diagrams;
  elements.count.textContent = query ? `${filtered.length} / ${diagrams.length}` : String(diagrams.length);
  elements.list.replaceChildren();

  const byFolder = new Map();
  for (const diagram of filtered) {
    const key = diagram.folderId || '';
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key).push(diagram);
  }
  for (const list of byFolder.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  const visibleFolders = new Set();
  if (query) {
    for (const diagram of filtered) for (const segment of diagram.folderPath || []) visibleFolders.add(segment.id);
    for (const folder of folders) {
      if (folder.path.map(item => item.name).join(' ').toLocaleLowerCase('ru').includes(query)) {
        for (const segment of folder.path) visibleFolders.add(segment.id);
      }
    }
  } else for (const folder of folders) visibleFolders.add(folder.id);

  renderRootSection(byFolder.get('') || [], query);
  const childrenByParent = new Map();
  for (const folder of folders) {
    if (!visibleFolders.has(folder.id)) continue;
    const key = folder.parentId || '';
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(folder);
  }
  for (const list of childrenByParent.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  const roots = childrenByParent.get('') || [];
  const stack = [...roots].reverse().map(folder => ({ folder, parent: elements.list }));
  while (stack.length) {
    const { folder, parent } = stack.pop();
    const children = childrenByParent.get(folder.id) || [];
    const rendered = renderFolderNode(folder, parent, byFolder.get(folder.id) || [], children, query);
    for (let index = rendered.children.length - 1; index >= 0; index -= 1) {
      stack.push({ folder: rendered.children[index], parent: rendered.content });
    }
  }

  if (!filtered.length && (!query || !visibleFolders.size)) {
    const empty = document.createElement('div');
    empty.className = 'catalog-empty';
    empty.textContent = diagrams.length ? 'Ничего не найдено' : 'Диаграмм пока нет';
    elements.list.appendChild(empty);
  }
}

function renderDiagramMeta() {
  elements.name.textContent = currentDiagram?.name || 'Нет открытой диаграммы';
  elements.description.textContent = currentDiagram?.description || '';
  const folderPath = currentDiagram?.folderPath?.map(item => item.name).join(' / ');
  elements.path.textContent = currentDiagram ? `${folderPath ? `${folderPath} / ` : ''}${currentDiagram.path}` : '';
  elements.revision.textContent = currentDiagram ? `rev ${currentDiagram.revision.slice(0, 8)}` : '';
  elements.empty.hidden = Boolean(currentDiagram);
  $('canvas').hidden = !currentDiagram;
  setDiagramControls(Boolean(currentDiagram));
  renderCatalog();
}

async function loadCatalog() {
  const response = await apiFetch('/api/catalog');
  diagrams = response.diagrams || [];
  folders = response.folders || [];
  catalogRevision = response.catalogRevision;
  const refreshedCurrent = currentDiagram && diagrams.find(diagram => diagram.id === currentDiagram.id);
  if (refreshedCurrent?.revision === currentDiagram.revision) {
    currentDiagram = { ...currentDiagram, ...refreshedCurrent };
    renderDiagramMeta();
  } else renderCatalog();
}

async function loadDiagram(id, { updateUrl = true } = {}) {
  if (!id) {
    currentDiagram = null;
    setDirty(false);
    renderDiagramMeta();
    setStatus('Создайте диаграмму или подключите ИИ через MCP.');
    return;
  }
  isLoading = true;
  setDiagramControls(false);
  setStatus('Загрузка актуальной версии из volume…');
  try {
    const { diagram } = await apiFetch(`/api/diagrams/${encodeURIComponent(id)}`);
    currentDiagram = diagram;
    const result = await modeler.importXML(diagram.xml);
    if (result.warnings?.length) console.warn('BPMN import warnings:', result.warnings);
    modeler.get('canvas').zoom('fit-viewport');
    setDirty(false);
    updateHistoryButtons();
    renderDiagramMeta();
    if (updateUrl) setUrlDiagram(id);
    setStatus(`«${diagram.name}» загружена · ревизия ${diagram.revision.slice(0, 8)}`);
  } catch (error) {
    setStatus(`Не удалось загрузить диаграмму: ${error.message}`);
    throw error;
  } finally {
    isLoading = false;
    setDiagramControls(Boolean(currentDiagram));
  }
}

async function selectDiagram(id) {
  if (!id || id === currentDiagram?.id) {
    if (isMobileLayout()) setSidebarCollapsed(true, { remember: false });
    return;
  }
  if (hasLocalChanges && !window.confirm('Есть несохранённые изменения. Переключить диаграмму и потерять их?')) return;
  await loadDiagram(id);
  if (isMobileLayout()) setSidebarCollapsed(true, { remember: false });
}

async function saveCurrentDiagram() {
  if (!currentDiagram || isSaving || isLoading) return;
  isSaving = true;
  setDiagramControls(false);
  setStatus(`Проверка и сохранение «${currentDiagram.name}»…`);
  try {
    const { xml } = await modeler.saveXML({ format: true });
    const result = await apiFetch(`/api/diagrams/${encodeURIComponent(currentDiagram.id)}`, {
      method: 'PUT', body: JSON.stringify({ expectedRevision: currentDiagram.revision, xml })
    });
    currentDiagram = result.diagram;
    const index = diagrams.findIndex(diagram => diagram.id === currentDiagram.id);
    if (index >= 0) diagrams[index] = currentDiagram;
    setDirty(false);
    renderDiagramMeta();
    const warnings = result.validation.warnings?.length || 0;
    setStatus(`Сохранено · ревизия ${currentDiagram.revision.slice(0, 8)}${warnings ? ` · предупреждений: ${warnings}` : ''}`);
  } catch (error) {
    if (error.code === 'REVISION_CONFLICT') {
      const reload = window.confirm('Диаграмма уже изменилась на сервере. Локальные изменения не записаны. Загрузить актуальную версию?');
      if (reload) await refreshCurrent({ discardConfirmed: true });
      else setStatus('Конфликт ревизий: сохранение отменено, локальные изменения оставлены в редакторе.');
    } else if (error.code === 'INVALID_BPMN') {
      setStatus(`BPMN не сохранён: проверка нашла ошибок — ${error.details?.errors?.length || 0}.`);
      window.alert((error.details?.errors || []).slice(0, 8).map(item => `• ${item.message}`).join('\n') || error.message);
    } else setStatus(`Не удалось сохранить: ${error.message}`);
  } finally {
    isSaving = false;
    setDiagramControls(Boolean(currentDiagram));
  }
}

function populateFolderSelect(select, selectedId = null, excludedIds = new Set()) {
  select.replaceChildren();
  const root = document.createElement('option');
  root.value = '';
  root.textContent = 'Без папки / корень';
  select.appendChild(root);
  for (const folder of folders) {
    if (excludedIds.has(folder.id)) continue;
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = `${'— '.repeat(Math.max(0, folder.path.length - 1))}${folder.name}`;
    select.appendChild(option);
  }
  select.value = selectedId || '';
}

function openDiagramDialog(mode) {
  const idField = $('diagram-id');
  $('diagram-mode').value = mode;
  idField.readOnly = mode === 'edit';
  document.querySelector('.field-id').classList.toggle('field-readonly', mode === 'edit');
  if (mode === 'create') {
    $('diagram-dialog-kicker').textContent = 'Новая диаграмма';
    $('diagram-dialog-title').textContent = 'Создать BPMN';
    $('diagram-dialog-description').textContent = 'Сервер подготовит валидный процесс со стартовым событием и BPMN DI.';
    $('diagram-submit').textContent = 'Создать';
    $('diagram-form-hint').textContent = 'ID станет частью прямой ссылки и не меняется после создания.';
    idField.value = ''; $('diagram-name').value = ''; $('diagram-description').value = '';
    populateFolderSelect($('diagram-folder'));
  } else if (mode === 'edit') {
    $('diagram-dialog-kicker').textContent = 'Метаданные';
    $('diagram-dialog-title').textContent = 'Свойства диаграммы';
    $('diagram-dialog-description').textContent = 'Измените название, папку или описание. Стабильный ID останется прежним.';
    $('diagram-submit').textContent = 'Сохранить свойства';
    $('diagram-form-hint').textContent = 'Изменение свойств также создаёт новую ревизию.';
    idField.value = currentDiagram.id; $('diagram-name').value = currentDiagram.name; $('diagram-description').value = currentDiagram.description || '';
    populateFolderSelect($('diagram-folder'), currentDiagram.folderId);
  } else {
    $('diagram-dialog-kicker').textContent = 'Дублирование';
    $('diagram-dialog-title').textContent = 'Создать копию';
    $('diagram-dialog-description').textContent = 'BPMN XML копируется в новый независимый файл.';
    $('diagram-submit').textContent = 'Создать копию';
    $('diagram-form-hint').textContent = 'Внутренние BPMN element ID можно оставить прежними: файлы независимы.';
    idField.value = `${currentDiagram.id}-copy`; $('diagram-name').value = `${currentDiagram.name} — копия`; $('diagram-description').value = currentDiagram.description || '';
    populateFolderSelect($('diagram-folder'), currentDiagram.folderId);
  }
  openDialog($('diagram-dialog'));
  setTimeout(() => (mode === 'edit' ? $('diagram-name') : idField).focus(), 0);
}

async function submitDiagramForm(event) {
  event.preventDefault();
  const mode = $('diagram-mode').value;
  const payload = {
    id: $('diagram-id').value.trim(),
    name: $('diagram-name').value.trim(),
    folderId: $('diagram-folder').value || null,
    description: $('diagram-description').value.trim()
  };
  const button = $('diagram-submit');
  button.disabled = true;
  try {
    let result;
    if (mode === 'edit') {
      result = await apiFetch(`/api/diagrams/${encodeURIComponent(currentDiagram.id)}`, {
        method: 'PUT', body: JSON.stringify({ expectedRevision: currentDiagram.revision, name: payload.name, folderId: payload.folderId, description: payload.description })
      });
    } else if (mode === 'duplicate') {
      result = await apiFetch(`/api/diagrams/${encodeURIComponent(currentDiagram.id)}/duplicate`, {
        method: 'POST', body: JSON.stringify({ ...payload, expectedRevision: currentDiagram.revision })
      });
    } else result = await apiFetch('/api/diagrams', { method: 'POST', body: JSON.stringify(payload) });
    closeDialog($('diagram-dialog'));
    await loadCatalog();
    await loadDiagram(result.diagram.id);
    setStatus(mode === 'edit' ? 'Свойства сохранены.' : `«${result.diagram.name}» создана.`);
  } catch (error) {
    setStatus(`Операция не выполнена: ${error.message}`);
    if (error.code === 'REVISION_CONFLICT') {
      closeDialog($('diagram-dialog'));
      if (window.confirm('Диаграмма уже изменилась на сервере. Загрузить актуальную версию?')) await refreshCurrent({ discardConfirmed: true });
    } else window.alert(error.message);
  } finally { button.disabled = false; }
}

function folderAndDescendantIds(folderId) {
  const ids = new Set([folderId]);
  const stack = [folderId];
  while (stack.length) {
    const parentId = stack.pop();
    for (const folder of folders) if (folder.parentId === parentId && !ids.has(folder.id)) { ids.add(folder.id); stack.push(folder.id); }
  }
  return ids;
}

function openFolderDialog(mode, folderId = null) {
  const folder = folders.find(item => item.id === folderId);
  $('folder-mode').value = mode;
  $('folder-id').value = folder?.id || '';
  $('folder-name').value = mode === 'edit' ? folder.name : '';
  $('folder-dialog-kicker').textContent = mode === 'edit' ? 'Управление папкой' : folder ? 'Дочерняя папка' : 'Корневая папка';
  $('folder-dialog-title').textContent = mode === 'edit' ? folder.name : 'Создать папку';
  $('folder-submit').textContent = mode === 'edit' ? 'Сохранить' : 'Создать';
  $('folder-dialog-description').textContent = mode === 'edit'
    ? 'Переименуйте папку или выберите нового родителя.'
    : 'Папка появится в каталоге сразу, даже если пока пуста.';
  const selectedParent = mode === 'edit' ? folder.parentId : folderId;
  populateFolderSelect($('folder-parent'), selectedParent, mode === 'edit' ? folderAndDescendantIds(folder.id) : new Set());
  $('folder-delete-area').hidden = mode !== 'edit';
  if (mode === 'edit') {
    const canDelete = folder.directDiagramCount === 0 && folder.childFolderCount === 0;
    $('folder-delete').disabled = !canDelete;
    $('folder-delete-hint').textContent = canDelete ? 'Удаление потребует точного имени папки.' : 'Сначала переместите диаграммы и удалите дочерние папки.';
  }
  openDialog($('folder-dialog'));
  setTimeout(() => $('folder-name').focus(), 0);
}

async function submitFolderForm(event) {
  event.preventDefault();
  const mode = $('folder-mode').value;
  const id = $('folder-id').value;
  const payload = {
    name: $('folder-name').value.trim(),
    parentId: $('folder-parent').value || null,
    expectedCatalogRevision: catalogRevision
  };
  const button = $('folder-submit');
  button.disabled = true;
  try {
    if (mode === 'edit') await apiFetch(`/api/folders/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await apiFetch('/api/folders', { method: 'POST', body: JSON.stringify(payload) });
    closeDialog($('folder-dialog'));
    if (mode !== 'edit') expandedFolders.add(payload.parentId || '');
    await loadCatalog();
    setStatus(mode === 'edit' ? 'Папка обновлена.' : 'Папка создана.');
  } catch (error) {
    if (error.code === 'CATALOG_REVISION_CONFLICT') {
      closeDialog($('folder-dialog'));
      await loadCatalog();
      setStatus('Каталог изменился другим клиентом. Актуальная версия загружена; повторите действие.');
    } else { setStatus(`Не удалось изменить папку: ${error.message}`); window.alert(error.message); }
  } finally { button.disabled = false; }
}

async function deleteFolderFromDialog() {
  const id = $('folder-id').value;
  const folder = folders.find(item => item.id === id);
  if (!folder) return;
  const confirmName = window.prompt(`Введите точное имя папки «${folder.name}». Удаление через приложение необратимо:`);
  if (confirmName === null) return;
  try {
    await apiFetch(`/api/folders/${encodeURIComponent(id)}`, {
      method: 'DELETE', body: JSON.stringify({ expectedCatalogRevision: catalogRevision, confirmName })
    });
    closeDialog($('folder-dialog'));
    expandedFolders.delete(id);
    rememberExpandedFolders();
    await loadCatalog();
    setStatus(`Папка «${folder.name}» удалена.`);
  } catch (error) {
    if (error.code === 'CATALOG_REVISION_CONFLICT') {
      closeDialog($('folder-dialog'));
      await loadCatalog();
      setStatus('Каталог изменился другим клиентом. Актуальная версия загружена.');
    } else { setStatus(`Не удалось удалить папку: ${error.message}`); window.alert(error.message); }
  }
}

function openDeleteDialog() {
  if (!currentDiagram) return;
  $('delete-target-id').textContent = currentDiagram.id;
  $('delete-confirm-id').value = '';
  $('delete-submit').disabled = true;
  openDialog($('delete-dialog'));
  setTimeout(() => $('delete-confirm-id').focus(), 0);
}

async function deleteCurrentDiagram(event) {
  event.preventDefault();
  if (!currentDiagram) return;
  const deleting = currentDiagram;
  const button = $('delete-submit');
  button.disabled = true;
  try {
    await apiFetch(`/api/diagrams/${encodeURIComponent(deleting.id)}`, {
      method: 'DELETE', body: JSON.stringify({ expectedRevision: deleting.revision, confirmId: $('delete-confirm-id').value })
    });
    closeDialog($('delete-dialog'));
    currentDiagram = null;
    setDirty(false);
    await loadCatalog();
    const next = diagrams[0];
    if (next) await loadDiagram(next.id);
    else { setUrlDiagram(null); renderDiagramMeta(); setStatus('Диаграмма удалена. Каталог пуст.'); }
  } catch (error) {
    setStatus(`Не удалось удалить: ${error.message}`);
    if (error.code === 'REVISION_CONFLICT' && window.confirm('Диаграмма уже изменилась на сервере. Загрузить актуальную версию?')) {
      closeDialog($('delete-dialog'));
      await refreshCurrent({ discardConfirmed: true });
    } else window.alert(error.message);
  } finally { button.disabled = $('delete-confirm-id').value !== currentDiagram?.id; }
}

async function refreshCurrent({ discardConfirmed = false } = {}) {
  if (hasLocalChanges && !discardConfirmed && !window.confirm('Загрузить актуальную версию и потерять несохранённые изменения?')) return;
  setStatus('Обновление каталога и диаграммы…');
  try {
    const currentId = currentDiagram?.id;
    await loadCatalog();
    const next = diagrams.find(diagram => diagram.id === currentId) || diagrams[0];
    if (next) await loadDiagram(next.id, { updateUrl: next.id !== currentId });
    else { currentDiagram = null; setUrlDiagram(null); renderDiagramMeta(); setStatus('Каталог обновлён. Диаграмм нет.'); }
  } catch (error) { setStatus(`Не удалось обновить: ${error.message}`); }
}

async function copyText(value, successMessage) {
  try { await navigator.clipboard.writeText(value); setStatus(successMessage); }
  catch { window.prompt('Скопируйте текст:', value); }
}

function openMcpDialog() {
  if (serverConfig) {
    $('mcp-url').textContent = serverConfig.mcpUrl;
    $('mcp-codex-config').textContent = serverConfig.codexConfig;
    $('mcp-skill-prompt').textContent = serverConfig.skillCreatorPrompt;
    $('mcp-skill-markdown').textContent = serverConfig.skillMarkdown;
  }
  openDialog($('mcp-dialog'));
}

function zoomBy(factor) {
  if (!currentDiagram) return;
  const canvas = modeler.get('canvas');
  canvas.zoom(Math.max(0.2, Math.min(4, canvas.zoom() * factor)));
}

function wireEvents() {
  $('sidebar-toggle').addEventListener('click', () => setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed')));
  $('sidebar-close').addEventListener('click', () => setSidebarCollapsed(true, { remember: false }));
  elements.backdrop.addEventListener('click', () => setSidebarCollapsed(true, { remember: false }));
  elements.search.addEventListener('input', renderCatalog);
  elements.search.addEventListener('keydown', event => {
    if (event.key === 'Escape') { elements.search.value = ''; renderCatalog(); elements.search.blur(); }
  });
  for (const id of ['create', 'sidebar-create', 'empty-create']) $(id).addEventListener('click', () => {
    if (hasLocalChanges && !window.confirm('Есть несохранённые изменения. Создать новую диаграмму и потерять их?')) return;
    openDiagramDialog('create');
  });
  $('sidebar-folder-create').addEventListener('click', () => openFolderDialog('create'));
  $('metadata').addEventListener('click', () => hasLocalChanges ? window.alert('Сначала сохраните или отмените локальные изменения.') : openDiagramDialog('edit'));
  $('duplicate').addEventListener('click', () => hasLocalChanges ? window.alert('Сначала сохраните или отмените локальные изменения.') : openDiagramDialog('duplicate'));
  $('delete').addEventListener('click', () => hasLocalChanges ? window.alert('Сначала сохраните или отмените локальные изменения.') : openDeleteDialog());
  $('diagram-form').addEventListener('submit', event => void submitDiagramForm(event));
  $('folder-form').addEventListener('submit', event => void submitFolderForm(event));
  $('folder-delete').addEventListener('click', () => void deleteFolderFromDialog());
  $('delete-form').addEventListener('submit', event => void deleteCurrentDiagram(event));
  $('delete-confirm-id').addEventListener('input', () => { $('delete-submit').disabled = $('delete-confirm-id').value !== currentDiagram?.id; });
  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => closeDialog($(button.dataset.closeDialog))));
  for (const id of ['mcp-connect', 'empty-mcp']) $(id).addEventListener('click', openMcpDialog);
  $('copy-mcp-url').addEventListener('click', () => void copyText(serverConfig?.mcpUrl || '', 'MCP URL скопирован.'));
  $('copy-codex-config').addEventListener('click', () => void copyText($('mcp-codex-config').textContent, 'Codex-конфигурация скопирована.'));
  $('copy-skill-prompt').addEventListener('click', () => void copyText($('mcp-skill-prompt').textContent, 'Промпт для Skill Creator скопирован.'));
  $('copy-skill-markdown').addEventListener('click', () => void copyText($('mcp-skill-markdown').textContent, 'SKILL.md скопирован.'));
  elements.save.addEventListener('click', () => void saveCurrentDiagram());
  $('reload').addEventListener('click', () => void refreshCurrent());
  elements.copyLink.addEventListener('click', () => {
    if (!currentDiagram) return;
    setUrlDiagram(currentDiagram.id);
    void copyText(window.location.href, 'Прямая ссылка скопирована.');
  });
  $('fit').addEventListener('click', () => currentDiagram && modeler.get('canvas').zoom('fit-viewport'));
  $('zoom-in').addEventListener('click', () => zoomBy(1.2));
  $('zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
  elements.undo.addEventListener('click', () => modeler.get('commandStack').undo());
  elements.redo.addEventListener('click', () => modeler.get('commandStack').redo());
  modeler.on('commandStack.changed', () => {
    updateHistoryButtons();
    if (isLoading || !currentDiagram) return;
    setDirty(true);
    setStatus(`«${currentDiagram.name}»: есть несохранённые изменения.`);
  });
  document.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === 'k') { event.preventDefault(); setSidebarCollapsed(false, { remember: false }); elements.search.focus(); elements.search.select(); }
    if ((event.metaKey || event.ctrlKey) && key === 's') { event.preventDefault(); void saveCurrentDiagram(); }
  });
  window.addEventListener('beforeunload', event => { if (hasLocalChanges) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('resize', () => { elements.backdrop.hidden = !isMobileLayout() || document.body.classList.contains('sidebar-collapsed'); });
}

async function initialize() {
  initializeSidebar();
  wireEvents();
  setupPngExport({ modeler, getCurrentDiagram: () => currentDiagram, setStatus });
  updateHistoryButtons();
  setDiagramControls(false);
  try {
    [serverConfig] = await Promise.all([apiFetch('/api/config'), loadCatalog()]);
    const requestedId = new URL(window.location.href).searchParams.get('diagram') || localStorage.getItem('bpmn-last-diagram');
    const initial = diagrams.find(diagram => diagram.id === requestedId) || diagrams[0];
    if (initial) {
      const urlDiagram = new URL(window.location.href).searchParams.get('diagram');
      await loadDiagram(initial.id, { updateUrl: urlDiagram !== initial.id });
    } else await loadDiagram(null);
  } catch (error) {
    setStatus(`Не удалось запустить редактор: ${error.message}`);
    elements.list.innerHTML = '<div class="catalog-empty">Сервер недоступен</div>';
  }
}

void initialize();
