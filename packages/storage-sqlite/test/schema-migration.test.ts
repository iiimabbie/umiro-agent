import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import { CURRENT_SCHEMA, initializeSchema } from "../src/schema.js";

test("existing turns tables gain the bot author flag during schema initialization", () => {
  const database = new Database(":memory:");
  try {
    database.exec(CURRENT_SCHEMA.replace("  author_is_bot INTEGER NOT NULL DEFAULT 0 CHECK (author_is_bot IN (0,1)),\n", ""));
    initializeSchema(database);
    const columns = database.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string; dflt_value: string | null }>;
    assert.equal(columns.find(column => column.name === "author_is_bot")?.dflt_value, "0");
  } finally { database.close(); }
});
