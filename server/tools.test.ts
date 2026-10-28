import { describe, expect, it } from "vitest";
import { checkArgs, fit, MAX_RESULT_BYTES, specOf, text, ToolArgsError, toolNamed, TOOLS, windowOf } from "./tools.ts";

const NOW = Date.parse("2026-10-28T09:00:00Z");
const tool = (name: string) => toolNamed(name)!;

describe("the time window", () => {
  it("is the last hour when left out, and names the shortest range that holds it for the link", () => {
    expect(windowOf({}, NOW)).toEqual({ start: NOW - 3_600_000, end: NOW, range: "1h" });
    expect(windowOf({ start: "2026-10-27T03:00:00Z", end: "2026-10-27T04:00:00Z" }, NOW).range).toBe("7d");
    expect(windowOf({ start: "2026-10-28T08:50:00Z" }, NOW).range).toBe("15m");
  });

  it("is never longer than 7 days, older than 30, ahead of now or backwards", () => {
    const refused = (args: Record<string, string>) => () => windowOf(args, NOW);
    expect(refused({ start: "2026-10-01T00:00:00Z", end: "2026-10-27T00:00:00Z" })).toThrow("7 days or shorter");
    expect(refused({ start: "2026-09-01T00:00:00Z", end: "2026-09-02T00:00:00Z" })).toThrow("last 30 days");
    expect(refused({ end: "2026-10-29T00:00:00Z" })).toThrow("future");
    expect(refused({ start: "2026-10-28T08:00:00Z", end: "2026-10-28T07:00:00Z" })).toThrow("before end");
    expect(refused({ start: "yesterday" })).toThrow("RFC 3339");
  });
});

describe("arguments", () => {
  it("are only the tool's parameters, of their types and within their bounds", () => {
    expect(checkArgs(tool("logs_search"), { query: "level:error", limit: 10, start: "" })).toEqual({ query: "level:error", limit: 10 });
    const refused = (name: string, input: unknown) => () => checkArgs(tool(name), input);
    expect(refused("logs_search", { limit: 5 })).toThrow("query is required.");
    expect(refused("logs_search", { query: "*", url: "http://evil" })).toThrow("url is not a parameter of logs_search.");
    expect(refused("logs_search", { query: 1 })).toThrow("query must be a string.");
    expect(refused("logs_search", { query: "x".repeat(1001) })).toThrow("at most 1000");
    expect(refused("logs_search", { query: "*", limit: 2.5 })).toThrow("whole number");
    expect(refused("siem_signals", { status: "deleted" })).toThrow("must be one of open, new");
    expect(refused("siem_signals", { host: "web-2\r\nX-Header: 1" })).toThrow("control characters");
    expect(refused("traces_search", { errors: "yes" })).toThrow("true or false");
    expect(refused("incidents_get", { key: "../../auth/tokens" })).toThrow("expected form");
    expect(refused("logs_search", ["*"])).toThrow(ToolArgsError);
  });

  it("are described to the model as JSON Schema that allows nothing else", () => {
    const s = specOf(tool("metrics_query"));
    expect(s.parameters).toMatchObject({ type: "object", required: ["query"], additionalProperties: false });
    expect(Object.keys(s.parameters.properties)).toEqual(["query", "start", "end"]);
  });
});

describe("each tool", () => {
  const w = windowOf({}, NOW);

  it("reads one fixed path of its product, with the arguments in the query string", () => {
    expect(TOOLS.map((t) => `${t.source} ${t.request({ query: "q", key: "INC-12" }, w).path}`)).toEqual([
      "logs /api/v1/search",
      "metrics /prometheus/api/v1/query_range",
      "traces /api/v1/traces",
      "siem /api/v1/signals",
      "alerts /api/v1/groups",
      "incidents /api/v1/incidents",
      "incidents /api/v1/incidents/INC-12",
      "vulnerabilities /api/v1/vulnerabilities",
    ]);
    expect(tool("metrics_query").request({ query: "up" }, w).query).toEqual({
      query: "up",
      start: String((NOW - 3_600_000) / 1000),
      end: String(NOW / 1000),
      step: "60",
    });
  });

  it("links to the product's page with the same query", () => {
    expect(tool("metrics_query").link({ query: 'up{job="node"} == 0' }, w)).toBe("/explore?q=up%7Bjob%3D%22node%22%7D+%3D%3D+0&range=1h");
    expect(tool("incidents_get").link({ key: "INC-12" }, w)).toBe("/incidents/INC-12");
    expect(tool("vulnerabilities_findings").link({ severity: "critical", kev: true }, w)).toBe("/findings?severity=critical");
  });

  it("sums up a metric's series, with a few of its points", () => {
    const values = Array.from({ length: 60 }, (_, i) => [NOW / 1000 - 3600 + i * 60, String(i === 30 ? 0.97 : 0.2)]);
    const out = tool("metrics_query").shape({ status: "success", data: { result: [{ metric: { instance: "web-2" }, values }] } }, { query: "x" }, w);
    const series = (out.data as { series: Array<Record<string, unknown>> }).series[0]!;
    expect(series).toMatchObject({ labels: { instance: "web-2" }, first: 0.2, last: 0.2, min: 0.2, max: 0.97, maxAt: "2026-10-28T08:30:00.000Z" });
    expect((series.points as unknown[]).length).toBe(12);
    expect(out.count).toBe(1);
  });

  it("passes on only the fields the answer needs from each item", () => {
    const out = tool("vulnerabilities_findings").shape(
      {
        vulnerabilities: [
          {
            vulnerability: "CVE-2026-1",
            aliases: [],
            package: { name: "openssl", versions: ["3.0.1"] },
            severity: "critical",
            cvss: 9.8,
            knownExploited: true,
            fix: { state: "fixed", version: "3.0.2" },
            hosts: 3,
            images: 0,
            description: "long text",
          },
        ],
      },
      {},
      w,
    );
    expect(out.data).toEqual({
      vulnerabilities: [
        {
          vulnerability: "CVE-2026-1",
          package: "openssl",
          versions: ["3.0.1"],
          severity: "critical",
          cvss: 9.8,
          knownExploited: true,
          fix: "fixed in 3.0.2",
          hosts: 3,
          images: 0,
        },
      ],
    });
  });
});

describe("results", () => {
  it("are cut to a size, and say how much was left out", () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ msg: `${i} ${"x".repeat(390)}` }));
    const out = fit(lines, (kept, omitted) => ({ lines: kept, omitted })) as { lines: unknown[]; omitted: number };
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(out.lines.length + out.omitted).toBe(100);
    expect(out.omitted).toBeGreaterThan(0);
  });

  it("keep text as text: cut, and without control characters but line breaks", () => {
    expect(text("a\u0000b\u001b[31mc\nd")).toBe("a b [31mc\nd");
    expect(text("x".repeat(500))).toHaveLength(401);
    expect(text(null)).toBeNull();
  });
});
