import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createQueryPilotApp } from "../dist/app.js";

let tmpDir;
let server;
let meta;
let baseUrl;
let targetDbPath;
let restoreDbPath;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "querypilot-test-"));
  targetDbPath = path.join(tmpDir, "app_target.db");
  restoreDbPath = path.join(tmpDir, "restored.db");

  const target = new DatabaseSync(targetDbPath);
  target.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE orgs (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE users (id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id), email TEXT NOT NULL UNIQUE);
    CREATE INDEX idx_users_org ON users(org_id);
    INSERT INTO orgs (id, name) VALUES (1, 'Acme Corp');
    INSERT INTO users (id, org_id, email) VALUES (10, 1, 'ada@acme.test'), (11, 1, '=HYPERLINK("evil")');
  `);
  target.close();
  new DatabaseSync(restoreDbPath).close();

  const created = createQueryPilotApp({
    dataDir: path.join(tmpDir, "meta"),
    jwtSecret: "test-querypilot-jwt-secret",
    masterKey: "test-querypilot-master-key-32bytes",
  });
  meta = created.meta;
  server = await new Promise((resolve) => {
    const s = created.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  meta.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("encrypted connections, schema/ER inspection, read-only guard, query/explain, export, backup/restore, migrations", async () => {
  const admin = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dba_admin", password: "strongpassword1" }),
  }).then((r) => r.json());
  const hdr = { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" };

  // Create read-write and read-only SQLite connection profiles
  const rwConn = await fetch(`${baseUrl}/api/connections`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ name: "TargetRW", engine: "sqlite", uri: targetDbPath, read_only: false }),
  }).then((r) => r.json());
  const roConn = await fetch(`${baseUrl}/api/connections`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ name: "TargetRO", engine: "sqlite", uri: targetDbPath, read_only: true }),
  }).then((r) => r.json());
  assert.equal(rwConn.engine, "sqlite");

  // Confirm raw URI is encrypted in metadata SQLite
  const rawStored = meta.db.prepare("SELECT encrypted_uri FROM connection_profiles WHERE id = ?").get(rwConn.id);
  assert.ok(!String(rawStored.encrypted_uri).includes(targetDbPath));

  // Schema, table, column, index, and FK relationship inspection
  const tbls = await fetch(`${baseUrl}/api/connections/${rwConn.id}/tables`, { headers: hdr }).then((r) => r.json());
  assert.ok(tbls.tables.some((t) => t.name === "users"));

  const details = await fetch(`${baseUrl}/api/connections/${rwConn.id}/tables/users`, { headers: hdr }).then((r) => r.json());
  assert.ok(details.columns.some((c) => c.name === "email"));
  assert.ok(details.indexes.some((ix) => ix.name === "idx_users_org"));
  assert.equal(details.foreignKeys[0].toTable, "orgs");

  const rels = await fetch(`${baseUrl}/api/connections/${rwConn.id}/relationships`, { headers: hdr }).then((r) => r.json());
  assert.equal(rels.relationships.length, 1);

  // Read-only connection blocks DROP TABLE
  const roDrop = await fetch(`${baseUrl}/api/connections/${roConn.id}/query`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ sql: "DROP TABLE users;" }),
  });
  assert.equal(roDrop.status, 403);

  // Execute SELECT and EXPLAIN plan
  const sel = await fetch(`${baseUrl}/api/connections/${rwConn.id}/query`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ sql: "SELECT id, email FROM users ORDER BY id" }),
  }).then((r) => r.json());
  assert.equal(sel.rowCount, 2);
  assert.ok(sel.durationMs >= 0);

  const exp = await fetch(`${baseUrl}/api/connections/${rwConn.id}/query`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ sql: "SELECT * FROM users WHERE org_id = 1", explain: true }),
  }).then((r) => r.json());
  assert.ok(exp.rowCount >= 1);

  // Formula-safe CSV export & SQL dump
  const csvTxt = await fetch(`${baseUrl}/api/connections/${rwConn.id}/export`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ format: "csv", table: "users" }),
  }).then((r) => r.text());
  assert.ok(csvTxt.includes("'=HYPERLINK("));

  // Backup and restore into clean restoreDbPath
  const backup = await fetch(`${baseUrl}/api/connections/${rwConn.id}/backup`, { method: "POST", headers: hdr }).then((r) => r.json());
  assert.ok(backup.backup_id.endsWith(".sql"));

  const rstConn = await fetch(`${baseUrl}/api/connections`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ name: "RestoreDB", engine: "sqlite", uri: restoreDbPath, read_only: false }),
  }).then((r) => r.json());

  const rstRes = await fetch(`${baseUrl}/api/connections/${rstConn.id}/restore`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ backup_id: backup.backup_id }),
  });
  assert.equal(rstRes.status, 200);

  const verifyRestored = await fetch(`${baseUrl}/api/connections/${rstConn.id}/query`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ sql: "SELECT COUNT(*) AS cnt FROM users" }),
  }).then((r) => r.json());
  assert.equal(verifyRestored.rows[0].cnt, 2);

  // Migrations
  const mig = await fetch(`${baseUrl}/api/connections/${rwConn.id}/migrations`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ version: "001_audit.sql", sql: "CREATE TABLE audit_events (id INTEGER PRIMARY KEY, msg TEXT);" }),
  });
  assert.equal(mig.status, 201);
  const migList = await fetch(`${baseUrl}/api/connections/${rwConn.id}/migrations`, { headers: hdr }).then((r) => r.json());
  assert.equal(migList.migrations[0].version, "001_audit.sql");

  // Saved queries & history
  await fetch(`${baseUrl}/api/saved-queries`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ connection_id: rwConn.id, name: "List Users", sql: "SELECT * FROM users" }),
  });
  const sq = await fetch(`${baseUrl}/api/saved-queries?connection_id=${rwConn.id}`, { headers: hdr }).then((r) => r.json());
  assert.equal(sq.saved_queries.length, 1);
  const hist = await fetch(`${baseUrl}/api/history?connection_id=${rwConn.id}`, { headers: hdr }).then((r) => r.json());
  assert.ok(hist.history.length >= 2);
});
