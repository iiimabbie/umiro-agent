import type Database from "better-sqlite3";
import { INITIAL_SCHEMA } from "./001-initial.js";

const LATEST_VERSION = 1;

export function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const current = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };
  if (current.version > LATEST_VERSION) {
    throw new Error(`database schema version ${current.version} is newer than supported ${LATEST_VERSION}`);
  }
  if (current.version < 1) {
    database.transaction(() => {
      database.exec(INITIAL_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(1, new Date().toISOString());
    })();
  }
}
