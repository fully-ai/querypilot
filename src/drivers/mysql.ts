import mysql from "mysql2/promise";
import { assertValidIdentifier, isReadOnlySqlSafe } from "../crypto.js";
import type {
  AppliedMigration,
  DatabaseDriver,
  ForeignKeyEdge,
  QueryExecutionResult,
  TableDetails,
} from "./types.js";

function qMy(name: string): string {
  return `\`${assertValidIdentifier(name)}\``;
}

export class MySqlDriver implements DatabaseDriver {
  public readonly engine = "mysql" as const;
  private readonly pool: mysql.Pool;

  constructor(connectionUri: string) {
    this.pool = mysql.createPool({ uri: connectionUri, connectionLimit: 5, connectTimeout: 5000 });
  }

  async testConnection(): Promise<{ ok: boolean; version: string }> {
    const [rows] = await this.pool.query("SELECT VERSION() AS v");
    const r = (rows as Array<{ v: string }>)[0];
    return { ok: true, version: `MySQL ${r?.v ?? ""}`.trim() };
  }

  async listSchemas(): Promise<string[]> {
    const [rows] = await this.pool.query("SHOW DATABASES");
    return (rows as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0]));
  }

  async listTables(schema?: string): Promise<Array<{ schema: string; name: string; type: string }>> {
    const sql = schema
      ? "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME"
      : "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME";
    const [rows] = await this.pool.query(sql, schema ? [schema] : []);
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      schema: String(r.TABLE_SCHEMA),
      name: String(r.TABLE_NAME),
      type: String(r.TABLE_TYPE).toLowerCase().includes("view") ? "view" : "table",
    }));
  }

  async inspectTable(schema: string, table: string): Promise<TableDetails> {
    const [cols] = await this.pool.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = COALESCE(NULLIF(?, ''), DATABASE()) AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [schema, table]
    );
    const rels = (await this.getRelationships(schema)).filter((e) => e.fromTable === table);
    return {
      schema,
      table,
      columns: (cols as Array<Record<string, unknown>>).map((c) => ({
        name: String(c.COLUMN_NAME),
        type: String(c.COLUMN_TYPE),
        nullable: c.IS_NULLABLE === "YES",
        primaryKey: c.COLUMN_KEY === "PRI",
        defaultValue: c.COLUMN_DEFAULT !== null ? String(c.COLUMN_DEFAULT) : null,
      })),
      indexes: [],
      foreignKeys: rels,
    };
  }

  async getRelationships(schema = ""): Promise<ForeignKeyEdge[]> {
    const [rows] = await this.pool.query(
      `SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = COALESCE(NULLIF(?, ''), DATABASE()) AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [schema]
    );
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      constraintName: String(r.CONSTRAINT_NAME),
      fromTable: String(r.TABLE_NAME),
      fromColumn: String(r.COLUMN_NAME),
      toTable: String(r.REFERENCED_TABLE_NAME),
      toColumn: String(r.REFERENCED_COLUMN_NAME),
    }));
  }

  async browseTable(schema: string, table: string, limit: number, offset: number): Promise<QueryExecutionResult> {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    const qual = schema ? `${qMy(schema)}.${qMy(table)}` : qMy(table);
    return this.executeQuery(`SELECT * FROM ${qual} LIMIT ${safeLimit} OFFSET ${safeOffset}`, true);
  }

  async executeQuery(sql: string, readOnly: boolean): Promise<QueryExecutionResult> {
    if (readOnly) {
      const check = isReadOnlySqlSafe(sql);
      if (!check.safe) throw new Error(check.reason || "Blocked in read-only mode");
    }
    const start = performance.now();
    const [res, fields] = await this.pool.query(sql);
    const rows = Array.isArray(res) ? (res as Array<Record<string, unknown>>) : [];
    const columns = Array.isArray(fields) ? fields.map((f) => f.name) : [];
    const affected = !Array.isArray(res) && res && "affectedRows" in res ? Number(res.affectedRows) : 0;
    return {
      columns,
      rows,
      rowCount: rows.length,
      changes: affected,
      durationMs: Number((performance.now() - start).toFixed(3)),
    };
  }

  async explainQuery(sql: string): Promise<QueryExecutionResult> {
    const trimmed = sql.trim().replace(/;+\s*$/, "");
    const check = isReadOnlySqlSafe(trimmed);
    if (!check.safe) throw new Error(check.reason || "EXPLAIN only permits read-only statements");
    return this.executeQuery(`EXPLAIN ${trimmed}`, false);
  }

  async exportSql(schema = "", table?: string): Promise<string> {
    const tables = table ? [{ name: assertValidIdentifier(table) }] : await this.listTables(schema || undefined);
    const lines = ["-- QueryPilot MySQL SQL Export"];
    for (const t of tables) {
      const qual = schema ? `${qMy(schema)}.${qMy(t.name)}` : qMy(t.name);
      const data = await this.executeQuery(`SELECT * FROM ${qual} LIMIT 5000`, true);
      for (const r of data.rows) {
        const cols = Object.keys(r).map(qMy).join(", ");
        const vals = Object.values(r)
          .map((v) => (v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`))
          .join(", ");
        lines.push(`INSERT INTO ${qual} (${cols}) VALUES (${vals});`);
      }
    }
    return lines.join("\n") + "\n";
  }

  async listAppliedMigrations(): Promise<AppliedMigration[]> {
    await this.pool.query(
      "CREATE TABLE IF NOT EXISTS qp_migrations (version VARCHAR(255) PRIMARY KEY, applied_at VARCHAR(64) NOT NULL)"
    );
    const [rows] = await this.pool.query("SELECT version, applied_at FROM qp_migrations ORDER BY version ASC");
    return rows as AppliedMigration[];
  }

  async applyMigration(version: string, sql: string): Promise<void> {
    await this.listAppliedMigrations();
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(sql);
      await conn.query("INSERT INTO qp_migrations (version, applied_at) VALUES (?, ?)", [
        version,
        new Date().toISOString(),
      ]);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
