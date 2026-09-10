import type Database from "better-sqlite3";
import { INITIAL_SCHEMA } from "./001-initial.js";
import { DELIVERY_INTENTS_SCHEMA } from "./002-delivery-intents.js";
import { CONVERSATIONS_SCHEMA } from "./003-conversations.js";
import { DELEGATIONS_SCHEMA } from "./004-delegations.js";
import { CONVERSATION_BINDINGS_SCHEMA } from "./005-conversation-bindings.js";
import { IDENTITIES_SCHEMA } from "./006-identities.js";
import { CONVERSATION_SEARCH_SCHEMA } from "./007-conversation-search.js";
import { TURN_IDENTITIES_SCHEMA } from "./008-turn-identities.js";
import { CONVERSATION_EMBEDDINGS_SCHEMA } from "./009-conversation-embeddings.js";
import { SCHEDULER_SCHEMA } from "./010-scheduler.js";
import { ARTIFACTS_SCHEMA } from "./011-artifacts.js";
import { DELIVERY_RETRY_SCHEMA } from "./012-delivery-retry.js";
import { APPROVALS_SCHEMA } from "./013-approvals.js";
import { OPERATION_ARTIFACTS_SCHEMA } from "./014-operation-artifacts.js";
import { CONVERSATION_COMPACTIONS_SCHEMA } from "./015-conversation-compactions.js";
import { PLUGIN_STATE_SCHEMA } from "./016-plugin-state.js";
import { CONVERSATION_PREFERENCES_SCHEMA } from "./017-conversation-preferences.js";
import { STEERED_INPUTS_SCHEMA } from "./018-steered-inputs.js";

const LATEST_VERSION = 18;

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
  if (current.version < 6) {
    database.transaction(() => {
      database.exec(IDENTITIES_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(6, new Date().toISOString());
    })();
  }
  if (current.version < 7) {
    database.transaction(() => {
      database.exec(CONVERSATION_SEARCH_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(7, new Date().toISOString());
    })();
  }
  if (current.version < 8) {
    database.transaction(() => {
      database.exec(TURN_IDENTITIES_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(8, new Date().toISOString());
    })();
  }
  if (current.version < 9) {
    database.transaction(() => {
      database.exec(CONVERSATION_EMBEDDINGS_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(9, new Date().toISOString());
    })();
  }
  if (current.version < 10) {
    database.transaction(() => {
      database.exec(SCHEDULER_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(10, new Date().toISOString());
    })();
  }
  if (current.version < 11) {
    database.transaction(() => {
      database.exec(ARTIFACTS_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(11, new Date().toISOString());
    })();
  }
  if (current.version < 12) {
    database.transaction(() => {
      database.exec(DELIVERY_RETRY_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(12, new Date().toISOString());
    })();
  }
  if (current.version < 13) {
    database.transaction(() => {
      database.exec(APPROVALS_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(13, new Date().toISOString());
    })();
  }
  if (current.version < 14) {
    database.transaction(() => {
      database.exec(OPERATION_ARTIFACTS_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(14, new Date().toISOString());
    })();
  }
  if (current.version < 15) {
    database.transaction(() => {
      database.exec(CONVERSATION_COMPACTIONS_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(15, new Date().toISOString());
    })();
  }
  if (current.version < 16) {
    database.transaction(() => {
      database.exec(PLUGIN_STATE_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(16, new Date().toISOString());
    })();
  }
  if (current.version < 17) {
    database.transaction(() => {
      database.exec(CONVERSATION_PREFERENCES_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(17, new Date().toISOString());
    })();
  }
  if (current.version < 18) {
    database.transaction(() => {
      database.exec(STEERED_INPUTS_SCHEMA);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(18, new Date().toISOString());
    })();
  }
}
