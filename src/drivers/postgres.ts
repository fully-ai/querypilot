import pg from "pg";
import { assertValidIdentifier, isReadOnlySqlSafe } from "../crypto.js";
import type {
  AppliedMigration,
  DatabaseDriver,
  ForeignKeyEdge,
  QueryExecutionResult,
  TableDetails,
} from "./types.js";

function qPg(name: string): string {
  return `"${assertValidIdentifier(name)}"`;
}

export class PostgresDriver implements DatabaseDriver {
  public readonly engine = "postgres" as const;
  private readonly pool: pg.Pool;

  constructor(connectionUri: string) {
    this.pool = new pg.Pool({ connectionString: connectionUri, max: 5, connectionTimeoutMillis: 5000 });
  }

  async testConnection(): Promise<{ ok: boolean; version: string }> {
    const res = await this.pool.query("SELECT version() AS v");
    return { ok: true, version: String(res.rows[0]?.v ?? "PostgreSQL") };
  }

  async listSchemas(): Promise<string[]> {
    const res = await this.pool.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name != 'information_schema' ORDER BY schema_name"
    );
    return res.rows.map((r) => String(r.schema_name));
  }

  async listTables(schema = "public"): Promise<Array<{ schema: string; name: string; type: string }>> {
    const res = await this.pool.query(
      "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [schema]
    );
    return res.rows.map((r) => ({
      schema: String(r.table_schema),
      name: String(r.table_name),
      type: String(r.table_type).toLowerCase().includes("view") ? "view" : "table",
    }));
  }

  async inspectTable(schema = "public", table: string): Promise<TableDetails> {
    const colRes = await this.pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schema, table]
    );
    const pkRes = await this.pool.query(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, table]
    );
    const pkSet = new Set(pkRes.rows.map((r) => String(r.column_name)));
    const idxRes = await this.pool.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2",
      [schema, table]
    );
    const rels = (await this.getRelationships(schema)).filter((e) => e.fromTable === table);
    return {
      schema,
      table,
      columns: colRes.rows.map((c) => ({
        name: String(c.column_name),
        type: String(c.data_type),
        nullable: c.is_nullable === "YES",
        primaryKey: pkSet.has(String(c.column_name)),
        defaultValue: c.column_default ? String(c.column_default) : null,
      })),
      indexes: idxRes.rows.map((ix) => ({
        name: String(ix.indexname),
        unique: String(ix.indexdef).includes("UNIQUE"),
        columns: [],
      })),
      foreignKeys: rels,
    };
  }

  async getRelationships(schema = "public"): Promise<ForeignKeyEdge[]> {
    const res = await this.pool.query(
      `SELECT tc.constraint_name, tc.table_name AS from_table, kcu.column_name AS from_col,
              ccu.table_name AS to_table, ccu.column_name AS to_col
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
      [schema]
    );
    return res.rows.map((r) => ({
      constraintName: String(r.constraint_name),
      fromTable: String(r.from_table),
      fromColumn: String(r.from_col),
      toTable: String(r.to_table),
      toColumn: String(r.to_col),
    }));
  }

  async browseTable(schema = "public", table: string, limit: number, offset: number): Promise<QueryExecutionResult> {
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    return this.executeQuery(`SELECT * FROM ${qPg(schema)}.${qPg(table)} LIMIT ${safeLimit} OFFSET ${safeOffset}`, true);
  }

  async executeQuery(sql: string, readOnly: boolean): Promise<QueryExecutionResult> {
    if (readOnly) {
      const check = isReadOnlySqlSafe(sql);
      if (!check.safe) throw new Error(check.reason || "Blocked in read-only mode");
    }
    const start = performance.now();
    const res = await this.pool.query(sql);
    const cols = res.fields?.map((f) => f.name) ?? [];
    return {
      columns: cols,
      rows: (res.rows as Array<Record<string, unknown>>) ?? [],
      rowCount: res.rows?.length ?? 0,
      changes: res.rowCount ?? 0,
      durationMs: Number((performance.now() - start).toFixed(3)),
    };
  }

  async explainQuery(sql: string): Promise<QueryExecutionResult> {
    const trimmed = sql.trim().replace(/;+\s*$/, "");
    const check = isReadOnlySqlSafe(trimmed);
    if (!check.safe) throw new Error(check.reason || "EXPLAIN only permits read-only statements");
    return this.executeQuery(`EXPLAIN (FORMAT TEXT) ${trimmed}`, false);
  }

  async exportSql(schema = "public", table?: string): Promise<string> {
    const tables = table ? [{ name: assertValidIdentifier(table) }] : await this.listTables(schema);
    const lines = [`-- QueryPilot PostgreSQL Export (schema ${schema})`];
    for (const t of tables) {
      const data = await this.executeQuery(`SELECT * FROM ${qPg(schema)}.${qPg(t.name)} LIMIT 5000`, true);
      for (const r of data.rows) {
        const cols = Object.keys(r).map(qPg).join(", ");
        const vals = Object.values(r)
          .map((v) => (v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`))
          .join(", ");
        lines.push(`INSERT INTO ${qPg(schema)}.${qPg(t.name)} (${cols}) VALUES (${vals});`);
      }
    }
    return lines.join("\n") + "\n";
  }

  async listAppliedMigrations(): Promise<AppliedMigration[]> {
    await this.pool.query(
      "CREATE TABLE IF NOT EXISTS qp_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    );
    const res = await this.pool.query("SELECT version, applied_at FROM qp_migrations ORDER BY version ASC");
    return res.rows as AppliedMigration[];
  }

  async applyMigration(version: string, sql: string): Promise<void> {
    await this.listAppliedMigrations();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO qp_migrations (version, applied_at) VALUES ($1, $2)", [
        version,
        new Date().toISOString(),
      ]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
