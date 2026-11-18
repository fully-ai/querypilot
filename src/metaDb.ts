import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decryptSecret, deriveMasterKey, encryptSecret, type JwtUser } from "./crypto.js";
import type { EngineType } from "./drivers/types.js";

export interface ConnectionProfile {
  id: string;
  name: string;
  engine: EngineType;
  encrypted_uri: string;
  read_only: number;
  created_by: string;
  created_at: string;
}

export class MetaDatabase {
  public readonly db: DatabaseSync;
  private readonly masterKey: Buffer;

  constructor(dataDir: string, masterSecret: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "querypilot_meta.db"));
    this.masterKey = deriveMasterKey(masterSecret);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connection_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        engine TEXT NOT NULL,
        encrypted_uri TEXT NOT NULL,
        read_only INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS saved_queries (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sql_text TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS query_history (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        sql_text TEXT NOT NULL,
        duration_ms REAL NOT NULL,
        row_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT NOT NULL DEFAULT '',
        executed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_qhist_conn ON query_history(connection_id, executed_at DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  createUser(username: string, passwordHash: string): JwtUser {
    const cnt = (this.db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
    const role: JwtUser["role"] = cnt === 0 ? "admin" : "editor";
    const id = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, username, passwordHash, role, new Date().toISOString());
    return { id, username, role };
  }

  getUserByUsername(username: string) {
    return this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
      | { id: string; username: string; password_hash: string; role: JwtUser["role"] }
      | undefined;
  }

  listUsers() {
    return this.db.prepare("SELECT id, username, role, created_at FROM users ORDER BY created_at ASC").all();
  }

  updateUserRole(id: string, role: JwtUser["role"]): boolean {
    return this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id).changes > 0;
  }

  createConnection(input: {
    name: string;
    engine: EngineType;
    uri: string;
    readOnly: boolean;
    createdBy: string;
  }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const encrypted = encryptSecret(input.uri, this.masterKey);
    this.db
      .prepare(
        `INSERT INTO connection_profiles (id, name, engine, encrypted_uri, read_only, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.name, input.engine, encrypted, input.readOnly ? 1 : 0, input.createdBy, now);
    return this.getPublicConnection(id)!;
  }

  listPublicConnections() {
    return this.db
      .prepare("SELECT id, name, engine, read_only, created_by, created_at FROM connection_profiles ORDER BY name ASC")
      .all();
  }

  getPublicConnection(id: string) {
    return this.db
      .prepare("SELECT id, name, engine, read_only, created_by, created_at FROM connection_profiles WHERE id = ?")
      .get(id) as
      | { id: string; name: string; engine: EngineType; read_only: number; created_by: string; created_at: string }
      | undefined;
  }

  resolveConnection(id: string): { id: string; name: string; engine: EngineType; uri: string; readOnly: boolean } | undefined {
    const row = this.db.prepare("SELECT * FROM connection_profiles WHERE id = ?").get(id) as
      | ConnectionProfile
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      engine: row.engine,
      uri: decryptSecret(row.encrypted_uri, this.masterKey),
      readOnly: row.read_only === 1,
    };
  }

  deleteConnection(id: string): boolean {
    return this.db.prepare("DELETE FROM connection_profiles WHERE id = ?").run(id).changes > 0;
  }

  saveQuery(connectionId: string, name: string, sqlText: string, createdBy: string) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO saved_queries (id, connection_id, name, sql_text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, connectionId, name, sqlText, createdBy, now);
    return this.db.prepare("SELECT * FROM saved_queries WHERE id = ?").get(id);
  }

  listSavedQueries(connectionId?: string) {
    if (connectionId) {
      return this.db
        .prepare("SELECT * FROM saved_queries WHERE connection_id = ? ORDER BY created_at DESC")
        .all(connectionId);
    }
    return this.db.prepare("SELECT * FROM saved_queries ORDER BY created_at DESC").all();
  }

  deleteSavedQuery(id: string): boolean {
    return this.db.prepare("DELETE FROM saved_queries WHERE id = ?").run(id).changes > 0;
  }

  recordHistory(input: {
    connectionId: string;
    userId: string;
    sqlText: string;
    durationMs: number;
    rowCount: number;
    status: "ok" | "error";
    errorMessage?: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO query_history (id, connection_id, user_id, sql_text, duration_ms, row_count, status, error_message, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        input.connectionId,
        input.userId,
        input.sqlText.slice(0, 4000),
        input.durationMs,
        input.rowCount,
        input.status,
        (input.errorMessage ?? "").slice(0, 500),
        new Date().toISOString()
      );
  }

  listHistory(connectionId?: string, limit = 50) {
    const safeLimit = Math.min(200, Math.max(1, limit));
    if (connectionId) {
      return this.db
        .prepare("SELECT * FROM query_history WHERE connection_id = ? ORDER BY executed_at DESC LIMIT ?")
        .all(connectionId, safeLimit);
    }
    return this.db.prepare("SELECT * FROM query_history ORDER BY executed_at DESC LIMIT ?").all(safeLimit);
  }
}
