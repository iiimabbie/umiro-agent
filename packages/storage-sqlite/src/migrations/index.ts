import type Database from "better-sqlite3";
import { INITIAL_SCHEMA } from "./001-initial.js";
import { DELIVERY_INTENTS_SCHEMA } from "./002-delivery-intents.js";
import { CONVERSATIONS_SCHEMA } from "./003-conversations.js";
import { DELEGATIONS_SCHEMA } from "./004-delegations.js";
import { CONVERSATION_BINDINGS_SCHEMA } from "./005-conversation-bindings.js";

const LATEST_VERSION = 5;

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
  if (current.version < 2) {
    database.transaction(() => {
      database.exec(DELIVERY_INTENTS_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(2, new Date().toISOString());
    })();
  }
  if (current.version < 3) {
    database.transaction(() => {
      database.exec(CONVERSATIONS_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(3, new Date().toISOString());
    })();
  }
  if (current.version < 4) {
    database.transaction(() => {
      database.exec(DELEGATIONS_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(4, new Date().toISOString());
    })();
  }
  if (current.version < 5) {
    database.transaction(() => {
      database.exec(CONVERSATION_BINDINGS_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(5, new Date().toISOString());
    })();
  }
}
