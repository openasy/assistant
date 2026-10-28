import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `-- The language model, one for the install. There is none until an admin sets it (ADR 0015); its API key is sealed
   -- with the install's key (ADR 0021) and never sent back.
   CREATE TABLE model (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
     base_url TEXT NOT NULL,
     model TEXT NOT NULL,
     api_key TEXT,
     max_tokens INTEGER NOT NULL,
     updated_by TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   -- What admins set: how long conversations are kept.
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   -- A product the tools may read, where its API is and where people open it. Nothing is read until an admin
   -- allows it.
   CREATE TABLE sources (
     id TEXT PRIMARY KEY,
     allowed INTEGER NOT NULL DEFAULT 0,
     api_url TEXT,
     web_url TEXT,
     updated_by TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   -- A person's own API token for a product, sealed (ADR 0021). Tools read that product with it and nothing else, so
   -- they see what this person may see there (ADR 0003). owner is user:<id> for a person, token:<id> for an API token.
   CREATE TABLE connections (
     owner TEXT NOT NULL,
     source TEXT NOT NULL,
     token TEXT NOT NULL,
     connected_at TEXT NOT NULL,
     last_used_at TEXT,
     PRIMARY KEY (owner, source)
   );
   -- A person's conversations, only ever shown to them; deleted after the retention admins set.
   CREATE TABLE conversations (
     id TEXT PRIMARY KEY,
     owner TEXT NOT NULL,
     title TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX conversations_owner ON conversations (owner, updated_at);
   -- A question, or its answer with the tool calls it made and the sources it cites.
   CREATE TABLE messages (
     conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
     text TEXT NOT NULL,
     sources TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL CHECK (status IN ('question', 'answered', 'failed')),
     error TEXT,
     model TEXT,
     ms INTEGER,
     created_at TEXT NOT NULL,
     PRIMARY KEY (conversation_id, seq)
   )`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
