# QueryPilot Architecture

QueryPilot exposes a unified `DatabaseDriver` interface across heterogeneous SQL engines while storing all platform metadata in an encrypted SQLite metadata database (`querypilot_meta.db`).

## Core Layers

1. **Driver Abstraction (`src/drivers/`)**: `SqliteDriver` (`node:sqlite`), `PostgresDriver` (`pg`), and `MySqlDriver` (`mysql2`) share schema/table/column/index/FK inspection, query execution timing, `EXPLAIN` plans, SQL dump export, and `qp_migrations` transactional migrations.
2. **Crypto & Read-Only Guard (`src/crypto.ts`)**: Encrypts database connection strings at rest using AES-256-GCM, hashes user passwords via `scrypt`, signs 24h JWT sessions, and blocks mutating keywords when `read_only = true` or user role is `viewer`.
3. **API & Workbench UI (`src/app.ts`, `public/index.html`)**: Provides REST endpoints plus an interactive browser workbench featuring schema/table navigation, SVG foreign-key ER diagrams, query history, saved queries, CSV/SQL export, and backup/restore.
