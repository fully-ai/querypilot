import { MySqlDriver } from "./mysql.js";
import { PostgresDriver } from "./postgres.js";
import { SqliteDriver } from "./sqlite.js";
import type { DatabaseDriver, EngineType } from "./types.js";

export type {
  AppliedMigration,
  ColumnInfo,
  DatabaseDriver,
  EngineType,
  ForeignKeyEdge,
  IndexInfo,
  QueryExecutionResult,
  TableDetails,
} from "./types.js";

export function createDriver(engine: EngineType, targetUri: string): DatabaseDriver {
  switch (engine) {
    case "sqlite":
      return new SqliteDriver(targetUri);
    case "postgres":
      return new PostgresDriver(targetUri);
    case "mysql":
      return new MySqlDriver(targetUri);
    default:
      throw new Error(`Unsupported database engine: ${String(engine)}`);
  }
}
