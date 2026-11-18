# Changelog

## [0.1.0] - 2026-11-18

### Added
- Multi-engine `DatabaseDriver` architecture supporting SQLite (`node:sqlite`), PostgreSQL (`pg`), and MySQL (`mysql2`).
- AES-256-GCM encrypted connection profiles, read-only SQL statement guard, and RBAC authentication (`admin`, `editor`, `viewer`).
- Schema explorer, column/index inspection, foreign-key ER relationship graph, paginated table data viewer, execution timing, and `EXPLAIN` query plans.
- Saved queries, query execution history, formula-safe CSV and SQL (`DDL + INSERT`) export, SQLite backup/restore, and versioned SQL migration runner.
