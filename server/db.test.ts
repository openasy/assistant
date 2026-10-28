import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";

describe("openDb", () => {
  it("uses WAL and migrates once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "assistant-")), "nested", "assistant.db");
    const first = openDb(path);
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    first.close();
    const second = openDb(path);
    expect(second.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
    second.close();
  });

  it("keeps no message of a conversation that does not exist", () => {
    const db = openDb(":memory:");
    expect(() =>
      db.prepare("INSERT INTO messages (conversation_id, seq, role, text, status, created_at) VALUES ('missing', 1, 'user', 'q', 'question', 't')").run(),
    ).toThrow(/FOREIGN KEY/);
  });
});
