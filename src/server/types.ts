export interface CatalogEntry {
  id: string;
  name: string;
  group?: string;
  description?: string;
  path: string;
}

export interface CatalogFile {
  diagrams: CatalogEntry[];
}

export interface DiagramSummary extends CatalogEntry {
  revision: string;
  updatedAt: string;
}

export interface DiagramRecord extends DiagramSummary {
  xml: string;
  url: string;
}

export interface GroupSummary {
  name: string;
  diagramCount: number;
}

export interface GroupList {
  groups: GroupSummary[];
  ungroupedCount: number;
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
  group?: string;
  description?: string;
  xml?: string;
}

export interface DiagramUpdateInput {
  expectedRevision: string;
  name?: string;
  group?: string;
  description?: string;
  xml?: string;
}
