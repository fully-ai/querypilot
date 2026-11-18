import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertValidIdentifier, isReadOnlySqlSafe } from "../crypto.js";
import type {
  AppliedMigration,
  ColumnInfo,
  DatabaseDriver,
  ForeignKeyEdge,
  IndexInfo,
  QueryExecutionResult,
  TableDetails,
} from "./types.js";

function quoteIdent(name: string): string {
  return `"${assertValidIdentifier(name)}"`;
}

function sqlLiteral(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number" || typeof val === "bigint") return String(val);
  if (typeof val === "boolean") return val ? "1" : "0";
  if (val instanceof Uint8Array) return `X'${Buffer.from(val).toString("hex")}'`;
  return `'${String(val).replace(/'/g, "''")}'`;
}

export class SqliteDriver implements DatabaseDriver {
  public readonly engine = "sqlite" as const;
  private readonly db: DatabaseSync;
  public readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    if (filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  async testConnection(): Promise<{ ok: boolean; version: string }> {
    const row = this.db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
    return { ok: true, version: `SQLite ${row.v}` };
  }

  async listSchemas(): Promise<string[]> {
    return ["main"];
  }

  async listTables(): Promise<Array<{ schema: string; name: string; type: string }>> {
    const rows = this.db
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name ASC`
      )
      .all() as Array<{ name: string; type: string }>;
    return rows.map((r) => ({ schema: "main", name: r.name, type: r.type }));
  }

  async inspectTable(schema: string, table: string): Promise<TableDetails> {
    const qTable = quoteIdent(table);
    const colRows = this.db.prepare(`PRAGMA table_info(${qTable})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }>;
    const columns: ColumnInfo[] = colRows.map((c) => ({
      name: c.name,
      type: c.type || "TEXT",
      nullable: c.notnull === 0 && c.pk === 0,
      primaryKey: c.pk > 0,
      defaultValue: c.dflt_value,
    }));

    const idxRows = this.db.prepare(`PRAGMA index_list(${qTable})`).all() as Array<{
      name: string;
      unique: number;
    }>;
    const indexes: IndexInfo[] = idxRows.map((ix) => {
      const cols = this.db.prepare(`PRAGMA index_info("${ix.name.replace(/"/g, '""')}")`).all() as Array<{
        name: string;
      }>;
      return {
        name: ix.name,
        unique: ix.unique === 1,
        columns: cols.map((c) => c.name).filter(Boolean),
      };
    });

    const fkRows = this.db.prepare(`PRAGMA foreign_key_list(${qTable})`).all() as Array<{
      id: number;
      table: string;
      from: string;
      to: string;
    }>;
    const foreignKeys: ForeignKeyEdge[] = fkRows.map((fk, idx) => ({
      constraintName: `fk_${table}_${idx}`,
      fromTable: table,
      fromColumn: fk.from,
      toTable: fk.table,
      toColumn: fk.to,
    }));

    return { schema: schema || "main", table, columns, indexes, foreignKeys };
  }

  async getRelationships(): Promise<ForeignKeyEdge[]> {
    const tables = await this.listTables();
    const edges: ForeignKeyEdge[] = [];
    for (const t of tables) {
      if (t.type !== "table") continue;
      const details = await this.inspectTable("main", t.name);
      edges.push(...details.foreignKeys);
    }
    return edges;
  }

  async browseTable(schema: string, table: string, limit: number, offset: number): Promise<QueryExecutionResult> {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    return this.executeQuery(
      `SELECT * FROM ${quoteIdent(table)} LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      true
    );
  }

  async executeQuery(sql: string, readOnly: boolean): Promise<QueryExecutionResult> {
    if (readOnly) {
      const check = isReadOnlySqlSafe(sql);
      if (!check.safe) {
        throw new Error(check.reason || "Blocked in read-only mode");
      }
    }
    const start = performance.now();
    const trimmed = sql.trim().replace(/;+\s*$/, "");
    const upper = trimmed.toUpperCase();
    const returnsRows =
      upper.startsWith("SELECT") ||
      upper.startsWith("WITH") ||
      upper.startsWith("EXPLAIN") ||
      upper.startsWith("PRAGMA");

    if (returnsRows && !trimmed.includes(";")) {
      const stmt = this.db.prepare(trimmed);
      const rows = stmt.all() as Array<Record<string, unknown>>;
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return {
        columns,
        rows,
        rowCount: rows.length,
        changes: 0,
        durationMs: Number((performance.now() - start).toFixed(3)),
      };
    }

    this.db.exec(sql);
    const changesRow = this.db.prepare("SELECT changes() AS c").get() as { c: number };
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      changes: Number(changesRow.c ?? 0),
      durationMs: Number((performance.now() - start).toFixed(3)),
    };
  }

  async explainQuery(sql: string): Promise<QueryExecutionResult> {
    const trimmed = sql.trim().replace(/;+\s*$/, "");
    const check = isReadOnlySqlSafe(trimmed);
    if (!check.safe) {
      throw new Error(check.reason || "EXPLAIN only permits read-only statements");
    }
    return this.executeQuery(`EXPLAIN QUERY PLAN ${trimmed}`, false);
  }

  async exportSql(_schema?: string, table?: string): Promise<string> {
    const tables = table
      ? [{ name: assertValidIdentifier(table), type: "table" }]
      : (await this.listTables()).filter((t) => t.type === "table");
    const lines: string[] = ["-- QueryPilot SQLite SQL Export", "BEGIN TRANSACTION;"];
    for (const t of tables) {
      const ddlRow = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(t.name) as { sql: string } | undefined;
      if (!ddlRow?.sql) continue;
      lines.push(`DROP TABLE IF EXISTS ${quoteIdent(t.name)};`);
      lines.push(`${ddlRow.sql};`);
      const rows = this.db.prepare(`SELECT * FROM ${quoteIdent(t.name)}`).all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        const cols = Object.keys(r).map(quoteIdent).join(", ");
        const vals = Object.values(r).map(sqlLiteral).join(", ");
        lines.push(`INSERT INTO ${quoteIdent(t.name)} (${cols}) VALUES (${vals});`);
      }
    }
    lines.push("COMMIT;");
    return lines.join("\n") + "\n";
  }

  async listAppliedMigrations(): Promise<AppliedMigration[]> {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS qp_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);"
    );
    return this.db
      .prepare("SELECT version, applied_at FROM qp_migrations ORDER BY version ASC")
      .all() as unknown as AppliedMigration[];
  }

  async applyMigration(version: string, sql: string): Promise<void> {
    await this.listAppliedMigrations();
    const exists = this.db.prepare("SELECT 1 FROM qp_migrations WHERE version = ?").get(version);
    if (exists) {
      throw new Error(`Migration '${version}' already applied`);
    }
    this.db.exec("BEGIN;");
    try {
      this.db.exec(sql);
      this.db
        .prepare("INSERT INTO qp_migrations (version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
