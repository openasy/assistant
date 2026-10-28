// How an answer is shown: its text, split into paragraphs and lists, each with the calls it cites. The text is the
// model's and is shown as text only: no link, image or markup in it is ever made live. Links come from the calls,
// which the server built from the product's address and the tool's query (ADR 0073).

export type Segment = { kind: "text"; text: string } | { kind: "code"; text: string } | { kind: "cite"; n: number };

export interface Block {
  kind: "paragraph" | "list";
  /** A paragraph has one item; a list one per `- ` line. */
  items: Segment[][];
  /** The calls this block cites. A block that cites none is shown as such. */
  cites: number[];
}

/** Inline text: `code`, and [n] for a call the answer cites. */
export function segments(line: string): Segment[] {
  const out: Segment[] = [];
  // As on the server: a citation is not right after a letter or digit, so CRON[812] stays text.
  const re = /`([^`\n]+)`|(?<!\w)\[(\d{1,2})\]/g;
  let at = 0;
  for (const m of line.matchAll(re)) {
    if (m.index > at) out.push({ kind: "text", text: line.slice(at, m.index) });
    out.push(m[1] !== undefined ? { kind: "code", text: m[1] } : { kind: "cite", n: Number(m[2]) });
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push({ kind: "text", text: line.slice(at) });
  return out;
}

const citesOf = (items: Segment[][]) => [...new Set(items.flat().flatMap((s) => (s.kind === "cite" ? [s.n] : [])))];

export function blocks(text: string): Block[] {
  return text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk): Block => {
      const lines = chunk.split("\n").map((l) => l.trim());
      // Markdown emphasis is left out rather than shown as stars.
      const clean = (l: string) => l.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/^#{1,6}\s+/, "");
      if (lines.every((l) => /^[-*•]\s+/.test(l))) {
        const items = lines.map((l) => segments(clean(l.replace(/^[-*•]\s+/, ""))));
        return { kind: "list", items, cites: citesOf(items) };
      }
      const items = [segments(clean(lines.join(" ")))];
      return { kind: "paragraph", items, cites: citesOf(items) };
    });
}
