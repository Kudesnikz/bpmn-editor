export interface FolderEntry {
  id: string;
  name: string;
  parentId: string | null;
}

export interface FolderPathSegment {
  id: string;
  name: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  folderId: string | null;
  description?: string;
  path: string;
}

export interface CatalogFile {
  schemaVersion: 2;
  folders: FolderEntry[];
  diagrams: CatalogEntry[];
}

export interface DiagramSummary extends CatalogEntry {
  folderPath: FolderPathSegment[];
  revision: string;
  updatedAt: string;
}

export interface DiagramRecord extends DiagramSummary {
  xml: string;
  url: string;
}

export interface FolderSummary extends FolderEntry {
  path: FolderPathSegment[];
  directDiagramCount: number;
  totalDiagramCount: number;
  childFolderCount: number;
}

export interface FolderList {
  catalogRevision: string;
  folders: FolderSummary[];
  unfiledDiagramCount: number;
}

export interface CatalogSnapshot extends FolderList {
  diagrams: DiagramSummary[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  elementId?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface InspectedElement {
  id: string;
  type: string;
  name?: string;
}

export interface InspectedFlow extends InspectedElement {
  sourceId?: string;
  targetId?: string;
}

export interface InspectedLane extends InspectedElement {
  flowNodeIds: string[];
}

export interface InspectedProcess extends InspectedElement {
  isExecutable: boolean;
  lanes: InspectedLane[];
  elements: InspectedElement[];
  sequenceFlows: InspectedFlow[];
}

export interface InspectedCollaboration extends InspectedElement {
  participants: Array<InspectedElement & { processId?: string }>;
  messageFlows: InspectedFlow[];
}

export interface DiagramInspection {
  statistics: {
    processes: number;
    collaborations: number;
    participants: number;
    lanes: number;
    events: number;
    tasks: number;
    gateways: number;
    subprocesses: number;
    sequenceFlows: number;
    messageFlows: number;
  };
  di: {
    diagramCount: number;
    planeCount: number;
    shapeCount: number;
    edgeCount: number;
    complete: boolean;
  };
  processes: InspectedProcess[];
  collaborations: InspectedCollaboration[];
  validation: ValidationResult;
}

export interface DiagramInspectionRecord extends DiagramInspection {
  diagram: Omit<DiagramRecord, 'xml'>;
}

export interface DiagramCreateInput {
  id: string;
  name: string;
  folderId?: string | null;
  description?: string;
  xml?: string;
}

export interface DiagramUpdateInput {
  expectedRevision: string;
  name?: string;
  folderId?: string | null;
  description?: string;
  xml?: string;
}

export interface FolderCreateInput {
  name: string;
  parentId?: string | null;
  expectedCatalogRevision: string;
}

export interface FolderUpdateInput {
  name?: string;
  parentId?: string | null;
  expectedCatalogRevision: string;
}
