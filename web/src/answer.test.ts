import { describe, expect, it } from "vitest";
import { blocks, segments } from "./answer.ts";

describe("an answer", () => {
  it("is paragraphs and lists, each with the calls it cites", () => {
    expect(blocks("CPU went to 97% [1].\nIt fell at 02:31 [1][2].\n\n- a cron entry [3]\n- a connection\n\nNo data was found for the rest.")).toEqual([
      {
        kind: "paragraph",
        items: [
          [
            { kind: "text", text: "CPU went to 97% " },
            { kind: "cite", n: 1 },
            { kind: "text", text: ". It fell at 02:31 " },
            { kind: "cite", n: 1 },
            { kind: "cite", n: 2 },
            { kind: "text", text: "." },
          ],
        ],
        cites: [1, 2],
      },
      {
        kind: "list",
        items: [
          [
            { kind: "text", text: "a cron entry " },
            { kind: "cite", n: 3 },
          ],
          [{ kind: "text", text: "a connection" }],
        ],
        cites: [3],
      },
      { kind: "paragraph", items: [[{ kind: "text", text: "No data was found for the rest." }]], cites: [] },
    ]);
  });

  it("keeps links and markup as text, and code as code", () => {
    expect(segments("see [here](http://evil.example) <img src=x> `up == 0`")).toEqual([
      { kind: "text", text: "see [here](http://evil.example) <img src=x> " },
      { kind: "code", text: "up == 0" },
    ]);
    expect(blocks("**Bold** claim")[0]!.items[0]).toEqual([{ kind: "text", text: "Bold claim" }]);
    expect(segments("CRON[812] ran [2]")).toEqual([
      { kind: "text", text: "CRON[812] ran " },
      { kind: "cite", n: 2 },
    ]);
  });
});
