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
