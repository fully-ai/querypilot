export type EngineType = "sqlite" | "postgres" | "mysql";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface ForeignKeyEdge {
  constraintName: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface TableDetails {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyEdge[];
}

export interface QueryExecutionResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  changes: number;
  durationMs: number;
}

export interface AppliedMigration {
  version: string;
  applied_at: string;
}

export interface DatabaseDriver {
  readonly engine: EngineType;
  testConnection(): Promise<{ ok: boolean; version: string }>;
  listSchemas(): Promise<string[]>;
  listTables(schema?: string): Promise<Array<{ schema: string; name: string; type: string }>>;
  inspectTable(schema: string, table: string): Promise<TableDetails>;
  getRelationships(schema?: string): Promise<ForeignKeyEdge[]>;
  browseTable(schema: string, table: string, limit: number, offset: number): Promise<QueryExecutionResult>;
  executeQuery(sql: string, readOnly: boolean): Promise<QueryExecutionResult>;
  explainQuery(sql: string): Promise<QueryExecutionResult>;
  exportSql(schema?: string, table?: string): Promise<string>;
  listAppliedMigrations(): Promise<AppliedMigration[]>;
  applyMigration(version: string, sql: string): Promise<void>;
  close(): Promise<void>;
}
