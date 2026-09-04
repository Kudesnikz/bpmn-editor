import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import type {
  CatalogEntry,
  CatalogFile,
  CatalogSnapshot,
  DiagramCreateInput,
  DiagramInspectionRecord,
  DiagramRecord,
  DiagramSummary,
  DiagramUpdateInput,
  FolderCreateInput,
  FolderEntry,
  FolderList,
  FolderPathSegment,
  FolderUpdateInput,
  ValidationResult
} from './types.js';
import { inspectBpmn } from './inspection.js';
import { validateBpmn } from './validation.js';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FOLDER_ID_PATTERN = /^folder-[a-f0-9]+(?:-[a-f0-9]+)*$/;

interface LegacyCatalogEntry {
  id?: unknown;
  name?: unknown;
  group?: unknown;
  description?: unknown;
}

function folderId(): string {
  return `folder-${randomUUID()}`;
}

function normalizeOptional(value: unknown, max: number, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new AppError(400, 'INVALID_METADATA', `${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length > max) throw new AppError(400, 'INVALID_METADATA', `${field} is too long`);
  return normalized || undefined;
}

function normalizeFolderName(value: unknown): string {
  if (typeof value !== 'string') throw new AppError(400, 'INVALID_FOLDER_NAME', 'Folder name must be a string');
  const name = value.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new AppError(400, 'INVALID_FOLDER_NAME', 'Folder name must be 1-80 characters and cannot contain control characters');
  }
  return name;
}

function nameKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ru');
}

function normalizeEntry(input: DiagramCreateInput, folders: FolderEntry[]): CatalogEntry {
  const id = input.id.trim();
  if (!ID_PATTERN.test(id)) throw new AppError(400, 'INVALID_ID', 'id must use lowercase kebab-case');
  const name = input.name.trim();
  if (!name || name.length > 120) throw new AppError(400, 'INVALID_METADATA', 'name must be 1-120 characters');
  const normalizedFolderId = input.folderId ?? null;
  if (normalizedFolderId !== null && !folders.some(folder => folder.id === normalizedFolderId)) {
    throw new AppError(404, 'FOLDER_NOT_FOUND', `Folder ${normalizedFolderId} was not found`);
  }
  return {
    id,
    name,
    folderId: normalizedFolderId,
    description: normalizeOptional(input.description, 500, 'description'),
    path: `${id}.bpmn`
  };
}

function canonicalMetadata(entry: CatalogEntry): string {
  return JSON.stringify({
    id: entry.id,
    name: entry.name,
    folderId: entry.folderId,
    description: entry.description || '',
    path: entry.path
  });
}

function revisionFor(entry: CatalogEntry, xml: string): string {
  return createHash('sha256').update(canonicalMetadata(entry)).update('\n').update(xml).digest('hex');
}

function canonicalCatalog(catalog: CatalogFile): string {
  return JSON.stringify({
    schemaVersion: 2,
    folders: [...catalog.folders]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(folder => ({ id: folder.id, name: folder.name, parentId: folder.parentId })),
    diagrams: [...catalog.diagrams]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(diagram => ({
        id: diagram.id,
        name: diagram.name,
        folderId: diagram.folderId,
        description: diagram.description || '',
        path: diagram.path
      }))
  });
}

function catalogRevisionFor(catalog: CatalogFile): string {
  return createHash('sha256').update(canonicalCatalog(catalog)).digest('hex');
}

export function createBlankBpmn(id: string, name: string): string {
  const safe = id.replace(/-/g, '_');
  const escapedName = name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Definitions_${safe}" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_${safe}" name="${escapedName}" isExecutable="false">
    <bpmn:startEvent id="StartEvent_${safe}" name="Начало" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_${safe}">
    <bpmndi:BPMNPlane id="BPMNPlane_${safe}" bpmnElement="Process_${safe}">
      <bpmndi:BPMNShape id="StartEvent_${safe}_di" bpmnElement="StartEvent_${safe}">
        <dc:Bounds x="180" y="160" width="36" height="36" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
`;
}

export class DiagramStorage {
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly indexPath: string;

  constructor(
    private readonly dataDir: string,
    private readonly seedDir: string,
    private readonly publicBaseUrl: string,
    private readonly maxBpmnBytes: number
  ) {
    this.indexPath = path.join(dataDir, 'index.json');
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    let rawCatalog: unknown;
    try {
      rawCatalog = JSON.parse(await readFile(this.indexPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AppError(500, 'INVALID_CATALOG', `Unable to read diagram catalog: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (rawCatalog !== undefined) {
      if ((rawCatalog as { schemaVersion?: unknown }).schemaVersion === 2) {
        this.normalizeCatalog(rawCatalog);
      } else {
        await this.writeCatalog(this.migrateLegacyCatalog(rawCatalog));
      }
      return;
    }

    const salesFolder: FolderEntry = { id: folderId(), name: 'Продажи', parentId: null };
    const seedEntries: CatalogEntry[] = [
      {
        id: 'shop',
        name: 'Покупка в магазине',
        folderId: salesFolder.id,
        description: 'Выбор товара, касса, оплата и проверка на выходе',
        path: 'shop.bpmn'
      },
      {
        id: 'return',
        name: 'Возврат товара',
        folderId: salesFolder.id,
        description: 'Процесс возврата ранее купленного товара',
        path: 'return.bpmn'
      }
    ];
    for (const entry of seedEntries) {
      const source = path.join(this.seedDir, entry.path);
      try {
        await access(source);
      } catch {
        throw new Error(`Seed BPMN file is missing: ${source}`);
      }
      await copyFile(source, this.diagramPath(entry.id));
    }
    await this.writeCatalog({ schemaVersion: 2, folders: [salesFolder], diagrams: seedEntries });
  }

  async getCatalog(): Promise<CatalogSnapshot> {
    const catalog = await this.readCatalog();
    const diagrams = await Promise.all(catalog.diagrams.map(entry => this.summaryFor(entry, catalog.folders)));
    return { ...this.folderListFor(catalog), diagrams: diagrams.sort((a, b) => a.name.localeCompare(b.name, 'ru')) };
  }

  async list(query = '', selectedFolderId = '', includeDescendants = true): Promise<DiagramSummary[]> {
    const catalog = await this.readCatalog();
    if (selectedFolderId && !catalog.folders.some(folder => folder.id === selectedFolderId)) {
      throw new AppError(404, 'FOLDER_NOT_FOUND', `Folder ${selectedFolderId} was not found`);
    }
    const allowedFolders = selectedFolderId
      ? this.descendantIds(selectedFolderId, catalog.folders, includeDescendants)
      : undefined;
    const normalizedQuery = query.trim().toLocaleLowerCase('ru');
    const summaries = await Promise.all(catalog.diagrams.map(entry => this.summaryFor(entry, catalog.folders)));
    return summaries.filter(entry => {
      if (allowedFolders && (!entry.folderId || !allowedFolders.has(entry.folderId))) return false;
      if (!normalizedQuery) return true;
      return [entry.id, entry.name, entry.description, ...entry.folderPath.map(segment => segment.name)]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('ru')
        .includes(normalizedQuery);
    }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  async listFolders(): Promise<FolderList> {
    return this.folderListFor(await this.readCatalog());
  }

  async get(id: string): Promise<DiagramRecord> {
    this.assertId(id);
    const catalog = await this.readCatalog();
    const entry = catalog.diagrams.find(diagram => diagram.id === id);
    if (!entry) throw new AppError(404, 'DIAGRAM_NOT_FOUND', `Diagram ${id} was not found`);
    return this.recordFor(entry, catalog.folders);
  }

  async inspect(id: string): Promise<DiagramInspectionRecord> {
    const record = await this.get(id);
    const { xml, ...diagram } = record;
    return { diagram, ...await inspectBpmn(xml, this.maxBpmnBytes) };
  }

  async validate(xml: string): Promise<ValidationResult> {
    return validateBpmn(xml, this.maxBpmnBytes);
  }

  async create(input: DiagramCreateInput): Promise<{ diagram: DiagramRecord; validation: ValidationResult }> {
    return this.withLock(async () => {
      const catalog = await this.readCatalog();
      const entry = normalizeEntry(input, catalog.folders);
      if (catalog.diagrams.some(diagram => diagram.id === entry.id)) {
        throw new AppError(409, 'DIAGRAM_EXISTS', `Diagram ${entry.id} already exists`);
      }
      const xml = input.xml ?? createBlankBpmn(entry.id, entry.name);
      const validation = await this.validate(xml);
      this.assertValidForWrite(validation);
      await this.atomicWrite(this.diagramPath(entry.id), xml);
      try {
        await this.writeCatalog({ ...catalog, diagrams: [...catalog.diagrams, entry] });
      } catch (error) {
        await unlink(this.diagramPath(entry.id)).catch(() => undefined);
        throw error;
      }
      return { diagram: await this.recordFor(entry, catalog.folders), validation };
    });
  }

  async update(id: string, input: DiagramUpdateInput): Promise<{ diagram: DiagramRecord; validation: ValidationResult }> {
    return this.withLock(async () => {
      this.assertId(id);
      if (!input.expectedRevision) throw new AppError(400, 'REVISION_REQUIRED', 'expectedRevision is required');
      const catalog = await this.readCatalog();
      const index = catalog.diagrams.findIndex(diagram => diagram.id === id);
      if (index < 0) throw new AppError(404, 'DIAGRAM_NOT_FOUND', `Diagram ${id} was not found`);
      const currentEntry = catalog.diagrams[index]!;
      const current = await this.recordFor(currentEntry, catalog.folders);
      if (current.revision !== input.expectedRevision) {
        throw new AppError(409, 'REVISION_CONFLICT', 'Diagram was changed by another client', { currentRevision: current.revision });
      }
      const nextEntry = normalizeEntry({
        id,
        name: input.name ?? currentEntry.name,
        folderId: input.folderId === undefined ? currentEntry.folderId : input.folderId,
        description: input.description === undefined ? currentEntry.description : input.description
      }, catalog.folders);
      const xml = input.xml ?? current.xml;
      const validation = await this.validate(xml);
      this.assertValidForWrite(validation);
      const metadataChanged = canonicalMetadata(nextEntry) !== canonicalMetadata(currentEntry);
      const nextCatalog = { ...catalog, diagrams: [...catalog.diagrams] };
      nextCatalog.diagrams[index] = nextEntry;
      if (input.xml !== undefined) await this.atomicWrite(this.diagramPath(id), xml);
      try {
        if (metadataChanged) await this.writeCatalog(nextCatalog);
      } catch (error) {
        if (input.xml !== undefined) await this.atomicWrite(this.diagramPath(id), current.xml).catch(() => undefined);
        throw error;
      }
      return { diagram: await this.recordFor(nextEntry, catalog.folders), validation };
    });
  }

  async duplicate(sourceId: string, input: DiagramCreateInput & { expectedRevision: string }): Promise<{ diagram: DiagramRecord; validation: ValidationResult }> {
    return this.withLock(async () => {
      this.assertId(sourceId);
      const catalog = await this.readCatalog();
      const sourceEntry = catalog.diagrams.find(diagram => diagram.id === sourceId);
      if (!sourceEntry) throw new AppError(404, 'DIAGRAM_NOT_FOUND', `Diagram ${sourceId} was not found`);
      const source = await this.recordFor(sourceEntry, catalog.folders);
      if (source.revision !== input.expectedRevision) {
        throw new AppError(409, 'REVISION_CONFLICT', 'Diagram was changed by another client', { currentRevision: source.revision });
      }
      const entry = normalizeEntry({
        ...input,
        folderId: input.folderId === undefined ? sourceEntry.folderId : input.folderId,
        description: input.description === undefined ? sourceEntry.description : input.description
      }, catalog.folders);
      if (catalog.diagrams.some(diagram => diagram.id === entry.id)) {
        throw new AppError(409, 'DIAGRAM_EXISTS', `Diagram ${entry.id} already exists`);
      }
      const validation = await this.validate(source.xml);
      this.assertValidForWrite(validation);
      await this.atomicWrite(this.diagramPath(entry.id), source.xml);
      try {
        await this.writeCatalog({ ...catalog, diagrams: [...catalog.diagrams, entry] });
      } catch (error) {
        await unlink(this.diagramPath(entry.id)).catch(() => undefined);
        throw error;
      }
      return { diagram: await this.recordFor(entry, catalog.folders), validation };
    });
  }

  async delete(id: string, expectedRevision: string, confirmId: string): Promise<void> {
    return this.withLock(async () => {
      this.assertId(id);
      if (confirmId !== id) throw new AppError(400, 'DELETE_CONFIRMATION_MISMATCH', 'confirmId must exactly match the diagram id');
      const catalog = await this.readCatalog();
      const entry = catalog.diagrams.find(diagram => diagram.id === id);
      if (!entry) throw new AppError(404, 'DIAGRAM_NOT_FOUND', `Diagram ${id} was not found`);
      const current = await this.recordFor(entry, catalog.folders);
      if (current.revision !== expectedRevision) {
        throw new AppError(409, 'REVISION_CONFLICT', 'Diagram was changed by another client', { currentRevision: current.revision });
      }
      const nextCatalog = { ...catalog, diagrams: catalog.diagrams.filter(diagram => diagram.id !== id) };
      await this.writeCatalog(nextCatalog);
      try {
        await unlink(this.diagramPath(id));
      } catch (error) {
        await this.writeCatalog(catalog);
        throw error;
      }
    });
  }

  async createFolder(input: FolderCreateInput): Promise<{ folder: FolderEntry; catalog: FolderList }> {
    return this.withLock(async () => {
      const catalog = await this.readCatalog();
      this.assertCatalogRevision(catalog, input.expectedCatalogRevision);
      const parentId = input.parentId ?? null;
      this.assertParent(parentId, catalog.folders);
      const name = normalizeFolderName(input.name);
      this.assertUniqueFolderName(name, parentId, catalog.folders);
      const folder: FolderEntry = { id: folderId(), name, parentId };
      const nextCatalog = { ...catalog, folders: [...catalog.folders, folder] };
      await this.writeCatalog(nextCatalog);
      return { folder, catalog: this.folderListFor(nextCatalog) };
    });
  }

  async updateFolder(id: string, input: FolderUpdateInput): Promise<{ folder: FolderEntry; catalog: FolderList }> {
    return this.withLock(async () => {
      const catalog = await this.readCatalog();
      this.assertCatalogRevision(catalog, input.expectedCatalogRevision);
      const index = catalog.folders.findIndex(folder => folder.id === id);
      if (index < 0) throw new AppError(404, 'FOLDER_NOT_FOUND', `Folder ${id} was not found`);
      const current = catalog.folders[index]!;
      const nextParentId = input.parentId === undefined ? current.parentId : input.parentId;
      const nextName = input.name === undefined ? current.name : normalizeFolderName(input.name);
      this.assertParent(nextParentId, catalog.folders);
      if (nextParentId === id || this.descendantIds(id, catalog.folders, true).has(nextParentId || '')) {
        throw new AppError(409, 'FOLDER_CYCLE', 'A folder cannot be moved into itself or one of its descendants');
      }
      this.assertUniqueFolderName(nextName, nextParentId, catalog.folders, id);
      const folder: FolderEntry = { id, name: nextName, parentId: nextParentId };
      const nextCatalog = { ...catalog, folders: [...catalog.folders] };
      nextCatalog.folders[index] = folder;
      await this.writeCatalog(nextCatalog);
      return { folder, catalog: this.folderListFor(nextCatalog) };
    });
  }

  async deleteFolder(id: string, expectedCatalogRevision: string, confirmName: string): Promise<void> {
    return this.withLock(async () => {
      const catalog = await this.readCatalog();
      this.assertCatalogRevision(catalog, expectedCatalogRevision);
      const folder = catalog.folders.find(entry => entry.id === id);
      if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', `Folder ${id} was not found`);
      if (confirmName !== folder.name) throw new AppError(400, 'DELETE_CONFIRMATION_MISMATCH', 'confirmName must exactly match the folder name');
      if (catalog.folders.some(entry => entry.parentId === id) || catalog.diagrams.some(diagram => diagram.folderId === id)) {
        throw new AppError(409, 'FOLDER_NOT_EMPTY', 'Only an empty folder can be deleted');
      }
      await this.writeCatalog({ ...catalog, folders: catalog.folders.filter(entry => entry.id !== id) });
    });
  }

  private folderListFor(catalog: CatalogFile): FolderList {
    const directCounts = new Map<string, number>();
    let unfiledDiagramCount = 0;
    for (const diagram of catalog.diagrams) {
      if (diagram.folderId) directCounts.set(diagram.folderId, (directCounts.get(diagram.folderId) || 0) + 1);
      else unfiledDiagramCount += 1;
    }
    const folders = catalog.folders.map(folder => {
      const descendants = this.descendantIds(folder.id, catalog.folders, true);
      let totalDiagramCount = 0;
      for (const descendantId of descendants) totalDiagramCount += directCounts.get(descendantId) || 0;
      return {
        ...folder,
        path: this.folderPath(folder.id, catalog.folders),
        directDiagramCount: directCounts.get(folder.id) || 0,
        totalDiagramCount,
        childFolderCount: catalog.folders.filter(candidate => candidate.parentId === folder.id).length
      };
    }).sort((left, right) => {
      const leftPath = left.path.map(segment => segment.name).join('\u0000');
      const rightPath = right.path.map(segment => segment.name).join('\u0000');
      return leftPath.localeCompare(rightPath, 'ru');
    });
    return { catalogRevision: catalogRevisionFor(catalog), folders, unfiledDiagramCount };
  }

  private folderPath(id: string | null, folders: FolderEntry[]): FolderPathSegment[] {
    if (!id) return [];
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    const result: FolderPathSegment[] = [];
    let current: FolderEntry | undefined = byId.get(id);
    while (current) {
      result.push({ id: current.id, name: current.name });
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return result.reverse();
  }

  private descendantIds(id: string, folders: FolderEntry[], includeDescendants: boolean): Set<string> {
    const result = new Set<string>([id]);
    if (!includeDescendants) return result;
    const stack = [id];
    while (stack.length) {
      const parentId = stack.pop()!;
      for (const folder of folders) {
        if (folder.parentId === parentId && !result.has(folder.id)) {
          result.add(folder.id);
          stack.push(folder.id);
        }
      }
    }
    return result;
  }

  private async summaryFor(entry: CatalogEntry, folders: FolderEntry[]): Promise<DiagramSummary> {
    const xml = await this.readXml(entry);
    const fileStat = await stat(this.diagramPath(entry.id));
    return { ...entry, folderPath: this.folderPath(entry.folderId, folders), revision: revisionFor(entry, xml), updatedAt: fileStat.mtime.toISOString() };
  }

  private async recordFor(entry: CatalogEntry, folders: FolderEntry[]): Promise<DiagramRecord> {
    const xml = await this.readXml(entry);
    const fileStat = await stat(this.diagramPath(entry.id));
    return {
      ...entry,
      folderPath: this.folderPath(entry.folderId, folders),
      xml,
      revision: revisionFor(entry, xml),
      updatedAt: fileStat.mtime.toISOString(),
      url: `${this.publicBaseUrl}/?diagram=${encodeURIComponent(entry.id)}`
    };
  }

  private async readXml(entry: CatalogEntry): Promise<string> {
    try {
      return await readFile(this.diagramPath(entry.id), 'utf8');
    } catch {
      throw new AppError(500, 'STORAGE_INCONSISTENT', `BPMN file for ${entry.id} is missing`);
    }
  }

  private diagramPath(id: string): string {
    this.assertId(id);
    return path.join(this.dataDir, `${id}.bpmn`);
  }

  private assertId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new AppError(400, 'INVALID_ID', 'id must use lowercase kebab-case');
  }

  private assertValidForWrite(validation: ValidationResult): void {
    if (validation.valid) return;
    const tooLarge = validation.errors.some(error => error.code === 'XML_TOO_LARGE');
    throw new AppError(
      tooLarge ? 413 : 422,
      tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_BPMN',
      tooLarge ? 'BPMN XML is too large' : 'BPMN validation failed',
      validation
    );
  }

  private assertCatalogRevision(catalog: CatalogFile, expectedRevision: string): void {
    if (!expectedRevision) throw new AppError(400, 'CATALOG_REVISION_REQUIRED', 'expectedCatalogRevision is required');
    const currentRevision = catalogRevisionFor(catalog);
    if (currentRevision !== expectedRevision) {
      throw new AppError(409, 'CATALOG_REVISION_CONFLICT', 'Catalog was changed by another client', { currentRevision });
    }
  }

  private assertParent(parentId: string | null, folders: FolderEntry[]): void {
    if (parentId !== null && !folders.some(folder => folder.id === parentId)) {
      throw new AppError(404, 'FOLDER_NOT_FOUND', `Folder ${parentId} was not found`);
    }
  }

  private assertUniqueFolderName(name: string, parentId: string | null, folders: FolderEntry[], excludeId?: string): void {
    if (folders.some(folder => folder.id !== excludeId && folder.parentId === parentId && nameKey(folder.name) === nameKey(name))) {
      throw new AppError(409, 'FOLDER_ALREADY_EXISTS', `A folder named ${name} already exists here`);
    }
  }

  private migrateLegacyCatalog(raw: unknown): CatalogFile {
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { diagrams?: unknown }).diagrams)) {
      throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog must contain a diagrams array');
    }
    const folders: FolderEntry[] = [];
    const foldersByName = new Map<string, FolderEntry>();
    const diagrams = ((raw as { diagrams: LegacyCatalogEntry[] }).diagrams).map(rawEntry => {
      if (typeof rawEntry?.id !== 'string' || typeof rawEntry?.name !== 'string') {
        throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog contains invalid metadata');
      }
      let migratedFolderId: string | null = null;
      if (typeof rawEntry.group === 'string' && rawEntry.group.trim()) {
        const name = normalizeFolderName(rawEntry.group);
        const key = nameKey(name);
        let folder = foldersByName.get(key);
        if (!folder) {
          folder = { id: folderId(), name, parentId: null };
          foldersByName.set(key, folder);
          folders.push(folder);
        }
        migratedFolderId = folder.id;
      }
      return normalizeEntry({
        id: rawEntry.id,
        name: rawEntry.name,
        folderId: migratedFolderId,
        description: normalizeOptional(rawEntry.description, 500, 'description')
      }, folders);
    });
    const unique = new Set(diagrams.map(entry => entry.id));
    if (unique.size !== diagrams.length) throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog contains duplicate ids');
    return { schemaVersion: 2, folders, diagrams };
  }

  private normalizeCatalog(raw: unknown): CatalogFile {
    if (!raw || typeof raw !== 'object') throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog must be an object');
    const value = raw as { schemaVersion?: unknown; folders?: unknown; diagrams?: unknown };
    if (value.schemaVersion !== 2 || !Array.isArray(value.folders) || !Array.isArray(value.diagrams)) {
      throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog must use schemaVersion 2 with folders and diagrams arrays');
    }
    const folders: FolderEntry[] = value.folders.map(rawFolder => {
      const candidate = rawFolder as Partial<FolderEntry>;
      if (typeof candidate.id !== 'string' || !FOLDER_ID_PATTERN.test(candidate.id)) {
        throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog contains an invalid folder id');
      }
      if (candidate.parentId !== null && typeof candidate.parentId !== 'string') {
        throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog contains an invalid parent folder id');
      }
      return { id: candidate.id, name: normalizeFolderName(candidate.name), parentId: candidate.parentId };
    });
    const folderIds = new Set(folders.map(folder => folder.id));
    if (folderIds.size !== folders.length) throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog contains duplicate folder ids');
    for (const folder of folders) {
      if (folder.parentId && !folderIds.has(folder.parentId)) throw new AppError(500, 'INVALID_CATALOG', `Parent folder for ${folder.id} is missing`);
      this.assertUniqueFolderName(folder.name, folder.parentId, folders, folder.id);
      const seen = new Set<string>([folder.id]);
      let currentId = folder.parentId;
      while (currentId) {
        if (seen.has(currentId)) throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog contains a folder cycle');
        seen.add(currentId);
        currentId = folders.find(candidate => candidate.id === currentId)?.parentId ?? null;
      }
    }
    const diagrams = value.diagrams.map(rawEntry => {
      const candidate = rawEntry as Partial<CatalogEntry>;
      if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') {
        throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog contains invalid metadata');
      }
      if (candidate.folderId !== null && typeof candidate.folderId !== 'string') {
        throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog contains an invalid folder reference');
      }
      return normalizeEntry({
        id: candidate.id,
        name: candidate.name,
        folderId: candidate.folderId,
        description: candidate.description
      }, folders);
    });
    const diagramIds = new Set(diagrams.map(entry => entry.id));
    if (diagramIds.size !== diagrams.length) throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog contains duplicate ids');
    return { schemaVersion: 2, folders, diagrams };
  }

  private async readCatalog(): Promise<CatalogFile> {
    try {
      return this.normalizeCatalog(JSON.parse(await readFile(this.indexPath, 'utf8')));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(500, 'INVALID_CATALOG', `Unable to read diagram catalog: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async writeCatalog(catalog: CatalogFile): Promise<void> {
    await this.atomicWrite(this.indexPath, `${JSON.stringify(catalog, null, 2)}\n`);
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
