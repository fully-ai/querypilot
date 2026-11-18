import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { hashPassword, signToken, verifyPassword, verifyToken, type JwtUser } from "./crypto.js";
import { createDriver, type DatabaseDriver, type EngineType } from "./drivers/index.js";
import { MetaDatabase } from "./metaDb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const VALID_ENGINES = new Set<EngineType>(["sqlite", "postgres", "mysql"]);

export interface AuthedRequest extends Request {
  user?: JwtUser;
}

function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const esc = (v: unknown): string => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(esc).join(",");
  const lines = rows.map((r) => columns.map((c) => esc(r[c])).join(","));
  return [header, ...lines].join("\n") + "\n";
}

export function createQueryPilotApp(opts: {
  dataDir?: string;
  jwtSecret?: string;
  masterKey?: string;
} = {}) {
  const dataDir = path.resolve(opts.dataDir ?? process.env.QUERYPILOT_DATA_DIR ?? "./data");
  const jwtSecret = opts.jwtSecret ?? process.env.QUERYPILOT_JWT_SECRET ?? crypto.randomBytes(32).toString("hex");
  const masterKey = opts.masterKey ?? process.env.QUERYPILOT_MASTER_KEY ?? crypto.randomBytes(32).toString("hex");
  const meta = new MetaDatabase(dataDir, masterKey);
  const backupsDir = path.join(dataDir, "backups");
  fs.mkdirSync(backupsDir, { recursive: true });

  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "2mb" }));

  const requireAuth = (minRole: JwtUser["role"] = "viewer") => {
    const rank = { viewer: 1, editor: 2, admin: 3 };
    return (req: AuthedRequest, res: Response, next: NextFunction) => {
      const hdr = req.headers.authorization ?? "";
      if (!hdr.startsWith("Bearer ")) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      try {
        const user = verifyToken(hdr.slice(7), jwtSecret);
        if (rank[user.role] < rank[minRole]) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }
        req.user = user;
        next();
      } catch {
        res.status(401).json({ error: "Invalid token" });
      }
    };
  };

  async function withTargetDriver<T>(connId: string, fn: (drv: DatabaseDriver, readOnly: boolean) => Promise<T>): Promise<T> {
    const resolved = meta.resolveConnection(connId);
    if (!resolved) {
      const err = new Error("Connection not found");
      (err as Error & { status?: number }).status = 404;
      throw err;
    }
    const drv = createDriver(resolved.engine, resolved.uri);
    try {
      return await fn(drv, resolved.readOnly);
    } finally {
      await drv.close();
    }
  }

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/auth/register", (req, res) => {
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username) || password.length < 8) {
      res.status(400).json({ error: "Username (3-32 chars) and password (>= 8 chars) required" });
      return;
    }
    if (meta.getUserByUsername(username)) {
      res.status(409).json({ error: "Username exists" });
      return;
    }
    const user = meta.createUser(username, hashPassword(password));
    res.status(201).json({ token: signToken(user, jwtSecret), user });
  });

  app.post("/api/auth/login", (req, res) => {
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    const u = meta.getUserByUsername(username);
    if (!u || !verifyPassword(password, u.password_hash)) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const user: JwtUser = { id: u.id, username: u.username, role: u.role };
    res.json({ token: signToken(user, jwtSecret), user });
  });

  app.get("/api/users", requireAuth("admin"), (_req, res) => {
    res.json({ users: meta.listUsers() });
  });

  app.patch("/api/users/:id/role", requireAuth("admin"), (req, res) => {
    const role = String(req.body?.role ?? "") as JwtUser["role"];
    if (!["viewer", "editor", "admin"].includes(role)) {
      res.status(400).json({ error: "Invalid role" });
      return;
    }
    if (!meta.updateUserRole(String(req.params.id), role)) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ status: "updated", role });
  });

  app.get("/api/connections", requireAuth("viewer"), (_req, res) => {
    res.json({ connections: meta.listPublicConnections() });
  });

  app.post("/api/connections", requireAuth("admin"), async (req: AuthedRequest, res) => {
    const name = String(req.body?.name ?? "").trim();
    const engine = String(req.body?.engine ?? "sqlite") as EngineType;
    const uri = String(req.body?.uri ?? "").trim();
    const readOnly = Boolean(req.body?.read_only);
    if (!name || !VALID_ENGINES.has(engine) || !uri) {
      res.status(400).json({ error: "name, engine (sqlite|postgres|mysql), and uri are required" });
      return;
    }
    try {
      const drv = createDriver(engine, uri);
      try {
        await drv.testConnection();
      } finally {
        await drv.close();
      }
      const created = meta.createConnection({ name, engine, uri, readOnly, createdBy: req.user!.id });
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/connections/:id", requireAuth("admin"), (req, res) => {
    if (!meta.deleteConnection(String(req.params.id))) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    res.json({ status: "deleted" });
  });

  app.post("/api/connections/:id/test", requireAuth("viewer"), async (req, res) => {
    try {
      const info = await withTargetDriver(String(req.params.id), (drv) => drv.testConnection());
      res.json(info);
    } catch (err) {
      res.status((err as { status?: number }).status ?? 400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/connections/:id/schemas", requireAuth("viewer"), async (req, res) => {
    try {
      const schemas = await withTargetDriver(String(req.params.id), (drv) => drv.listSchemas());
      res.json({ schemas });
    } catch (err) {
      res.status((err as { status?: number }).status ?? 400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/connections/:id/tables", requireAuth("viewer"), async (req, res) => {
    const schema = typeof req.query.schema === "string" ? req.query.schema : undefined;
    try {
      const tables = await withTargetDriver(String(req.params.id), (drv) => drv.listTables(schema));
      res.json({ tables });
    } catch (err) {
      res.status((err as { status?: number }).status ?? 400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/connections/:id/tables/:table", requireAuth("viewer"), async (req, res) => {
    const schema = typeof req.query.schema === "string" ? req.query.schema : "main";
    try {
      const details = await withTargetDriver(String(req.params.id), (drv) =>
        drv.inspectTable(schema, String(req.params.table))
      );
      res.json(details);
    } catch (err) {
      res.status((err as { status?: number }).status ?? 400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/connections/:id/tables/:table/data", requireAuth("viewer"), async (req, res) => {
    const schema = typeof req.query.schema === "string" ? req.query.schema : "main";
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    try {
      const data = await withTargetDriver(String(req.params.id), (drv) =>
        drv.browseTable(schema, String(req.params.table), limit, offset)
      );
      res.json(data);
    } catch (err) {
      res.status((err as { status?: number }).status ?? 400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/connections/:id/relationships", requireAuth("viewer"), async (req, res) => {
    const schema = typeof req.query.schema === "string" ? req.query.schema : undefined;
    try {
      const edges = await withTargetDriver(String(req.params.id), (drv) => drv.getRelationships(schema));
      res.json({ relationships: edges });
    } catch (err) {
      res.status((err as { status?: number }).status ?? 400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/connections/:id/query", requireAuth("viewer"), async (req: AuthedRequest, res) => {
    const connId = String(req.params.id);
    const sqlText = String(req.body?.sql ?? "").trim();
    const explain = Boolean(req.body?.explain);
    if (!sqlText) {
      res.status(400).json({ error: "SQL query required" });
      return;
    }
    try {
      const result = await withTargetDriver(connId, async (drv, connReadOnly) => {
        if (explain) return drv.explainQuery(sqlText);
        const enforceReadOnly = connReadOnly || req.user!.role === "viewer";
        return drv.executeQuery(sqlText, enforceReadOnly);
      });
      meta.recordHistory({
        connectionId: connId,
        userId: req.user!.id,
        sqlText,
        durationMs: result.durationMs,
        rowCount: result.rowCount,
        status: "ok",
      });
      res.json(result);
    } catch (err) {
      const msg = (err as Error).message;
      meta.recordHistory({
        connectionId: connId,
        userId: req.user!.id,
        sqlText,
        durationMs: 0,
        rowCount: 0,
        status: "error",
        errorMessage: msg,
      });
      const status = msg.includes("read-only") ? 403 : ((err as { status?: number }).status ?? 400);
      res.status(status).json({ error: msg });
    }
  });

  app.post("/api/connections/:id/export", requireAuth("viewer"), async (req: AuthedRequest, res) => {
    const connId = String(req.params.id);
    const format = String(req.body?.format ?? "csv").toLowerCase();
    const schema = req.body?.schema ? String(req.body.schema) : undefined;
    const table = req.body?.table ? String(req.body.table) : undefined;
    const sqlText = req.body?.sql ? String(req.body.sql) : "";
    try {
      if (format === "sql") {
        const dump = await withTargetDriver(connId, (drv) => drv.exportSql(schema, table));
        res.setHeader("Content-Type", "application/sql; charset=utf-8");
        res.send(dump);
        return;
      }
      if (!sqlText && !table) {
        res.status(400).json({ error: "Provide sql or table for CSV export" });
        return;
      }
      const result = await withTargetDriver(connId, (drv) =>
        sqlText ? drv.executeQuery(sqlText, true) : drv.browseTable(schema ?? "main", table!, 500, 0)
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.send(toCsv(result.columns, result.rows));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/connections/:id/backup", requireAuth("editor"), async (req, res) => {
    const connId = String(req.params.id);
    const resolved = meta.resolveConnection(connId);
    if (!resolved) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    try {
      const sqlDump = await withTargetDriver(connId, (drv) => drv.exportSql());
      const backupId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.sql`;
      const outPath = path.join(backupsDir, backupId);
      fs.writeFileSync(outPath, sqlDump, "utf8");
      res.status(201).json({ backup_id: backupId, size_bytes: Buffer.byteLength(sqlDump, "utf8") });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/connections/:id/restore", requireAuth("admin"), async (req, res) => {
    const connId = String(req.params.id);
    const backupId = String(req.body?.backup_id ?? "").trim();
    let sqlDump = typeof req.body?.sql === "string" ? req.body.sql : "";
    if (backupId) {
      if (!/^[a-zA-Z0-9._-]+\.sql$/.test(backupId)) {
        res.status(400).json({ error: "Invalid backup_id" });
        return;
      }
      const p = path.resolve(backupsDir, backupId);
      if (!p.startsWith(path.resolve(backupsDir)) || !fs.existsSync(p)) {
        res.status(404).json({ error: "Backup file not found" });
        return;
      }
      sqlDump = fs.readFileSync(p, "utf8");
    }
    if (!sqlDump.trim()) {
      res.status(400).json({ error: "backup_id or sql dump required" });
      return;
    }
    try {
      const resolved = meta.resolveConnection(connId);
      if (!resolved) {
        res.status(404).json({ error: "Connection not found" });
        return;
      }
      if (resolved.readOnly) {
        res.status(403).json({ error: "Cannot restore into a read-only connection" });
        return;
      }
      const r = await withTargetDriver(connId, (drv) => drv.executeQuery(sqlDump, false));
      res.json({ status: "restored", durationMs: r.durationMs });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/connections/:id/migrations", requireAuth("viewer"), async (req, res) => {
    try {
      const migrations = await withTargetDriver(String(req.params.id), (drv) => drv.listAppliedMigrations());
      res.json({ migrations });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/connections/:id/migrations", requireAuth("editor"), async (req, res) => {
    const version = String(req.body?.version ?? "").trim();
    const sqlText = String(req.body?.sql ?? "").trim();
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(version) || !sqlText) {
      res.status(400).json({ error: "Valid migration version and sql required" });
      return;
    }
    try {
      const resolved = meta.resolveConnection(String(req.params.id));
      if (!resolved) {
        res.status(404).json({ error: "Connection not found" });
        return;
      }
      if (resolved.readOnly) {
        res.status(403).json({ error: "Cannot run migrations on a read-only connection" });
        return;
      }
      await withTargetDriver(String(req.params.id), (drv) => drv.applyMigration(version, sqlText));
      res.status(201).json({ version, status: "applied" });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/api/saved-queries", requireAuth("viewer"), (req, res) => {
    const cid = typeof req.query.connection_id === "string" ? req.query.connection_id : undefined;
    res.json({ saved_queries: meta.listSavedQueries(cid) });
  });

  app.post("/api/saved-queries", requireAuth("editor"), (req: AuthedRequest, res) => {
    const connectionId = String(req.body?.connection_id ?? "").trim();
    const name = String(req.body?.name ?? "").trim();
    const sqlText = String(req.body?.sql ?? "").trim();
    if (!connectionId || !name || !sqlText) {
      res.status(400).json({ error: "connection_id, name, and sql required" });
      return;
    }
    res.status(201).json(meta.saveQuery(connectionId, name, sqlText, req.user!.id));
  });

  app.delete("/api/saved-queries/:id", requireAuth("editor"), (req, res) => {
    if (!meta.deleteSavedQuery(String(req.params.id))) {
      res.status(404).json({ error: "Saved query not found" });
      return;
    }
    res.json({ status: "deleted" });
  });

  app.get("/api/history", requireAuth("viewer"), (req, res) => {
    const cid = typeof req.query.connection_id === "string" ? req.query.connection_id : undefined;
    res.json({ history: meta.listHistory(cid) });
  });

  app.use(express.static(PUBLIC_DIR));
  return { app, meta };
}
