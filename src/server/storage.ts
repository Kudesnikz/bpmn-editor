import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import type {
  CatalogEntry,
  CatalogFile,
  DiagramCreateInput,
  DiagramRecord,
  DiagramSummary,
  DiagramUpdateInput,
  ValidationResult
} from './types.js';
import { validateBpmn } from './validation.js';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEED_ENTRIES: CatalogEntry[] = [
  {
    id: 'shop',
    name: 'Покупка в магазине',
    group: 'Продажи',
    description: 'Выбор товара, касса, оплата и проверка на выходе',
    path: 'shop.bpmn'
  },
  {
    id: 'return',
    name: 'Возврат товара',
    group: 'Продажи',
    description: 'Процесс возврата ранее купленного товара',
    path: 'return.bpmn'
  }
];

function normalizeOptional(value: string | undefined, max: number, field: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length > max) throw new AppError(400, 'INVALID_METADATA', `${field} is too long`);
  return normalized || undefined;
}

function normalizeEntry(input: DiagramCreateInput): CatalogEntry {
  const id = input.id.trim();
  if (!ID_PATTERN.test(id)) {
    throw new AppError(400, 'INVALID_ID', 'id must use lowercase kebab-case');
  }
  const name = input.name.trim();
  if (!name || name.length > 120) throw new AppError(400, 'INVALID_METADATA', 'name must be 1-120 characters');
  return {
    id,
    name,
    group: normalizeOptional(input.group, 80, 'group'),
    description: normalizeOptional(input.description, 500, 'description'),
    path: `${id}.bpmn`
  };
}

function canonicalMetadata(entry: CatalogEntry): string {
  return JSON.stringify({
    id: entry.id,
    name: entry.name,
    group: entry.group || '',
    description: entry.description || '',
    path: entry.path
  });
}

function revisionFor(entry: CatalogEntry, xml: string): string {
  return createHash('sha256').update(canonicalMetadata(entry)).update('\n').update(xml).digest('hex');
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
    try {
      await access(this.indexPath);
      await this.readCatalog();
      return;
    } catch (error) {
      if (error instanceof AppError) throw error;
    }

    for (const entry of SEED_ENTRIES) {
      const source = path.join(this.seedDir, entry.path);
      try {
        await access(source);
      } catch {
        throw new Error(`Seed BPMN file is missing: ${source}`);
      }
      await copyFile(source, this.diagramPath(entry.id));
    }
    await this.writeCatalog({ diagrams: SEED_ENTRIES });
  }

  async list(query = '', group = ''): Promise<DiagramSummary[]> {
    const catalog = await this.readCatalog();
    const normalizedQuery = query.trim().toLocaleLowerCase('ru');
    const normalizedGroup = group.trim().toLocaleLowerCase('ru');
    const summaries = await Promise.all(catalog.diagrams.map(entry => this.summaryFor(entry)));
    return summaries.filter(entry => {
      if (normalizedGroup && (entry.group || '').toLocaleLowerCase('ru') !== normalizedGroup) return false;
      if (!normalizedQuery) return true;
      return [entry.id, entry.name, entry.group, entry.description]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('ru')
        .includes(normalizedQuery);
    });
  }

  async get(id: string): Promise<DiagramRecord> {
    this.assertId(id);
    const catalog = await this.readCatalog();
    const entry = catalog.diagrams.find(diagram => diagram.id === id);
    if (!entry) throw new AppError(404, 'DIAGRAM_NOT_FOUND', `Diagram ${id} was not found`);
    return this.recordFor(entry);
  }

  async validate(xml: string): Promise<ValidationResult> {
    return validateBpmn(xml, this.maxBpmnBytes);
  }

  async create(input: DiagramCreateInput): Promise<{ diagram: DiagramRecord; validation: ValidationResult }> {
    return this.withLock(async () => {
      const entry = normalizeEntry(input);
      const catalog = await this.readCatalog();
      if (catalog.diagrams.some(diagram => diagram.id === entry.id)) {
        throw new AppError(409, 'DIAGRAM_EXISTS', `Diagram ${entry.id} already exists`);
      }
      const xml = input.xml ?? createBlankBpmn(entry.id, entry.name);
      const validation = await this.validate(xml);
      this.assertValidForWrite(validation);

      await this.atomicWrite(this.diagramPath(entry.id), xml);
      try {
        await this.writeCatalog({ diagrams: [...catalog.diagrams, entry] });
      } catch (error) {
        await unlink(this.diagramPath(entry.id)).catch(() => undefined);
        throw error;
      }
      return { diagram: await this.recordFor(entry), validation };
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
      const current = await this.recordFor(currentEntry);
      if (current.revision !== input.expectedRevision) {
        throw new AppError(409, 'REVISION_CONFLICT', 'Diagram was changed by another client', {
          currentRevision: current.revision
        });
      }

      const nextEntry = normalizeEntry({
        id,
        name: input.name ?? currentEntry.name,
        group: input.group === undefined ? currentEntry.group : input.group,
        description: input.description === undefined ? currentEntry.description : input.description
      });
      const xml = input.xml ?? current.xml;
      const validation = await this.validate(xml);
      this.assertValidForWrite(validation);

      const metadataChanged = canonicalMetadata(nextEntry) !== canonicalMetadata(currentEntry);
      const nextCatalog = [...catalog.diagrams];
      nextCatalog[index] = nextEntry;
      const xmlChanged = input.xml !== undefined || metadataChanged;
      if (xmlChanged) await this.atomicWrite(this.diagramPath(id), xml);
      try {
        if (metadataChanged) await this.writeCatalog({ diagrams: nextCatalog });
      } catch (error) {
        if (xmlChanged) await this.atomicWrite(this.diagramPath(id), current.xml).catch(() => undefined);
        throw error;
      }
      return { diagram: await this.recordFor(nextEntry), validation };
    });
  }

  async duplicate(sourceId: string, input: DiagramCreateInput & { expectedRevision: string }): Promise<{ diagram: DiagramRecord; validation: ValidationResult }> {
    return this.withLock(async () => {
      this.assertId(sourceId);
      const catalog = await this.readCatalog();
      const sourceEntry = catalog.diagrams.find(diagram => diagram.id === sourceId);
      if (!sourceEntry) throw new AppError(404, 'DIAGRAM_NOT_FOUND', `Diagram ${sourceId} was not found`);
      const source = await this.recordFor(sourceEntry);
      if (source.revision !== input.expectedRevision) {
        throw new AppError(409, 'REVISION_CONFLICT', 'Diagram was changed by another client', {
          currentRevision: source.revision
        });
      }

      const entry = normalizeEntry(input);
      if (catalog.diagrams.some(diagram => diagram.id === entry.id)) {
        throw new AppError(409, 'DIAGRAM_EXISTS', `Diagram ${entry.id} already exists`);
      }
      const validation = await this.validate(source.xml);
      this.assertValidForWrite(validation);

      await this.atomicWrite(this.diagramPath(entry.id), source.xml);
      try {
        await this.writeCatalog({ diagrams: [...catalog.diagrams, entry] });
      } catch (error) {
        await unlink(this.diagramPath(entry.id)).catch(() => undefined);
        throw error;
      }
      return { diagram: await this.recordFor(entry), validation };
    });
  }

  async delete(id: string, expectedRevision: string, confirmId: string): Promise<void> {
    return this.withLock(async () => {
      this.assertId(id);
      if (confirmId !== id) throw new AppError(400, 'DELETE_CONFIRMATION_MISMATCH', 'confirmId must exactly match the diagram id');
      const catalog = await this.readCatalog();
      const entry = catalog.diagrams.find(diagram => diagram.id === id);
      if (!entry) throw new AppError(404, 'DIAGRAM_NOT_FOUND', `Diagram ${id} was not found`);
      const current = await this.recordFor(entry);
      if (current.revision !== expectedRevision) {
        throw new AppError(409, 'REVISION_CONFLICT', 'Diagram was changed by another client', {
          currentRevision: current.revision
        });
      }

      const nextCatalog = { diagrams: catalog.diagrams.filter(diagram => diagram.id !== id) };
      await this.writeCatalog(nextCatalog);
      try {
        await unlink(this.diagramPath(id));
      } catch (error) {
        await this.writeCatalog(catalog);
        throw error;
      }
    });
  }

  private async summaryFor(entry: CatalogEntry): Promise<DiagramSummary> {
    const xml = await this.readXml(entry);
    const fileStat = await stat(this.diagramPath(entry.id));
    return { ...entry, revision: revisionFor(entry, xml), updatedAt: fileStat.mtime.toISOString() };
  }

  private async recordFor(entry: CatalogEntry): Promise<DiagramRecord> {
    const xml = await this.readXml(entry);
    const fileStat = await stat(this.diagramPath(entry.id));
    return {
      ...entry,
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

  private async readCatalog(): Promise<CatalogFile> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.indexPath, 'utf8'));
    } catch (error) {
      throw new AppError(500, 'INVALID_CATALOG', `Unable to read diagram catalog: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as CatalogFile).diagrams)) {
      throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog must contain a diagrams array');
    }
    const diagrams = (parsed as CatalogFile).diagrams.map(raw => {
      const entry = normalizeEntry({
        id: raw.id,
        name: raw.name,
        group: raw.group,
        description: raw.description
      });
      return entry;
    });
    const unique = new Set(diagrams.map(entry => entry.id));
    if (unique.size !== diagrams.length) throw new AppError(500, 'INVALID_CATALOG', 'Diagram catalog contains duplicate ids');
    return { diagrams };
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
