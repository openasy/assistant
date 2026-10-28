// The fixed set of tools the model may call (ADR 0073). Every one is a GET of one public API path of another OpenAsy
// product (ADR 0014), made with the asking person's own token for that product, so it reads what that person could
// open there and nothing more (ADR 0003). The model never chooses a method, a host or a path: it fills arguments,
// which are checked here against each tool's parameters before anything is sent. Time ranges are bounded, results
// are cut to a size, and every call has a link to the page in the product where the person sees the same data.

/** The products Assistant can read, by their OpenAsy id (OPENASY_PRODUCTS), with the name in their token prefix. */
export const SOURCES = [
  { id: "logs", name: "Logs", product: "logs" },
  { id: "metrics", name: "Metrics", product: "metrics" },
  { id: "traces", name: "Traces", product: "traces" },
  { id: "siem", name: "SIEM", product: "siem" },
  { id: "alerts", name: "Alerts", product: "alerts" },
  { id: "incidents", name: "Incidents", product: "incidents" },
  { id: "vulnerabilities", name: "Vulnerabilities", product: "vulns" },
] as const;

export type SourceId = (typeof SOURCES)[number]["id"];
export const isSource = (id: string): id is SourceId => SOURCES.some((s) => s.id === id);
export const sourceOf = (id: SourceId) => SOURCES.find((s) => s.id === id)!;

/** One parameter: flat values only, so checking them needs no general JSON Schema validator. */
type Param =
  | { type: "string"; description: string; maxLength?: number; pattern?: string; enum?: readonly string[]; format?: "date-time" }
  | { type: "integer"; description: string; minimum: number; maximum: number }
  | { type: "boolean"; description: string };

export type Args = Record<string, string | number | boolean>;

/** What a tool sends: always GET, to a path of the product's API. */
export interface Request {
  path: string;
  query: Record<string, string>;
}

/** What a tool gives back: data for the model, how many items, and how the source is named. */
export interface Shaped {
  data: unknown;
  count: number;
  title: string;
  detail: string;
}

export interface Tool {
  name: string;
  source: SourceId;
  description: string;
  params: Record<string, Param>;
  required?: string[];
  request: (args: Args, w: Window) => Request;
  shape: (body: unknown, args: Args, w: Window) => Shaped;
  /** The product page with the same query, from the product's address for people. */
  link: (args: Args, w: Window) => string;
}

/** A tool as the model sees it: a name, what it does, and its parameters as JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, Param>; required: string[]; additionalProperties: false };
}

// ---------------------------------------------------------------- Bounds

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The furthest back a tool reads, and the longest window it reads at once. */
export const MAX_AGE_MS = 30 * DAY;
export const MAX_SPAN_MS = 7 * DAY;
/** What one tool result may weigh in the model's context, as JSON. */
export const MAX_RESULT_BYTES = 12 * 1024;
/** The longest a string from a product is passed on. */
const MAX_TEXT = 400;

/** The time window of a call. `range` is the products' own name for a window that ends now, for the link. */
export interface Window {
  start: number;
  end: number;
  range: string;
}

const RANGES: Array<[string, number]> = [
  ["15m", 15 * 60_000],
  ["1h", HOUR],
  ["6h", 6 * HOUR],
  ["24h", DAY],
  ["7d", 7 * DAY],
  ["30d", 30 * DAY],
];

export class ToolArgsError extends Error {}

/** The window from start and end, an hour up to now when left out, refused when it is too long, too old or ahead. */
export function windowOf(args: Args, now: number): Window {
  const at = (key: string) => {
    const v = args[key];
    if (v === undefined) return undefined;
    const t = Date.parse(String(v));
    if (!Number.isFinite(t)) throw new ToolArgsError(`${key} must be an RFC 3339 time, such as 2026-10-28T03:00:00Z.`);
    return t;
  };
  const end = at("end") ?? now;
  const start = at("start") ?? end - HOUR;
  if (end > now + 60_000) throw new ToolArgsError("end must not be in the future.");
  if (start >= end) throw new ToolArgsError("start must be before end.");
  if (start < now - MAX_AGE_MS) throw new ToolArgsError("start must be within the last 30 days.");
  if (end - start > MAX_SPAN_MS) throw new ToolArgsError("The window must be 7 days or shorter.");
  // The products' pages take a range that ends now: the shortest that still holds the start.
  // A window asked for as "the last 24 hours" starts a moment before the call is made: 2% slack keeps it at 24h.
  const range = RANGES.find(([, ms]) => ms * 1.02 >= now - start)?.[0] ?? "30d";
  return { start, end, range };
}

const iso = (t: number) => new Date(t).toISOString();

/** Checks the model's arguments against the tool's parameters; anything else, or of another type, is refused. */
export function checkArgs(tool: Tool, input: unknown): Args {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new ToolArgsError("Arguments must be a JSON object.");
  const args: Args = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const p = tool.params[key];
    if (!p) throw new ToolArgsError(`${key} is not a parameter of ${tool.name}.`);
    // Models often send an empty value for a parameter they do not need.
    if (value === null || value === "") continue;
    if (p.type === "string") {
      if (typeof value !== "string") throw new ToolArgsError(`${key} must be a string.`);
      if (value.length > (p.maxLength ?? 256)) throw new ToolArgsError(`${key} must be at most ${p.maxLength ?? 256} characters.`);
      if (p.enum && !p.enum.includes(value)) throw new ToolArgsError(`${key} must be one of ${p.enum.join(", ")}.`);
      if (p.pattern && !new RegExp(p.pattern).test(value)) throw new ToolArgsError(`${key} is not in the expected form.`);
      if (/[\u0000-\u001f\u007f]/.test(value) && key !== "query") throw new ToolArgsError(`${key} must not contain control characters.`);
      args[key] = value;
    } else if (p.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) throw new ToolArgsError(`${key} must be a whole number.`);
      if (value < p.minimum || value > p.maximum) throw new ToolArgsError(`${key} must be from ${p.minimum} to ${p.maximum}.`);
      args[key] = value;
    } else {
      if (typeof value !== "boolean") throw new ToolArgsError(`${key} must be true or false.`);
      args[key] = value;
    }
  }
  for (const key of tool.required ?? []) if (args[key] === undefined) throw new ToolArgsError(`${key} is required.`);
  return args;
}

export const specOf = (tool: Tool): ToolSpec => ({
  name: tool.name,
  description: tool.description,
  parameters: { type: "object", properties: tool.params, required: tool.required ?? [], additionalProperties: false },
});

// ---------------------------------------------------------------- Shaping

/** Text from a product, cut, without control characters but line breaks: it is data, never markup or instructions. */
export function text(value: unknown, max = MAX_TEXT): string | null {
  if (value === null || value === undefined) return null;
  const s = (typeof value === "string" ? value : JSON.stringify(value)).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const list = (body: unknown, key: string): Array<Record<string, unknown>> => {
  const v = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>) : [];
};
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Drops items from the end until the result fits MAX_RESULT_BYTES, and says how many were left out. */
export function fit<T>(items: T[], wrap: (kept: T[], omitted: number) => unknown): unknown {
  let kept = items.length;
  let out = wrap(items, 0);
  while (kept > 0 && Buffer.byteLength(JSON.stringify(out)) > MAX_RESULT_BYTES) {
    kept = Math.max(0, Math.floor(kept * 0.75));
    out = wrap(items.slice(0, kept), items.length - kept);
  }
  return out;
}

const link = (path: string, query: Record<string, string | number | boolean | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
};

const WINDOW = {
  start: { type: "string", format: "date-time", maxLength: 40, description: "RFC 3339. An hour before end when left out; within the last 30 days." },
  end: { type: "string", format: "date-time", maxLength: 40, description: "RFC 3339. Now when left out. The window is at most 7 days." },
} as const;

const SEVERITIES = "^(critical|high|medium|low)(,(critical|high|medium|low)){0,3}$";

// ---------------------------------------------------------------- The tools

export const TOOLS: Tool[] = [
  {
    name: "logs_search",
    source: "logs",
    description:
      'Search log lines in OpenAsy Logs with LogsQL, such as `host:web-2 level:error`, `service:checkout "timeout"` or `_msg:~"refused"`. Returns the newest matching lines.',
    params: {
      query: { type: "string", maxLength: 1000, description: "LogsQL. `*` matches every line." },
      ...WINDOW,
      limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many lines; 50 when left out." },
    },
    required: ["query"],
    request: (a, w) => ({ path: "/api/v1/search", query: { query: String(a.query), start: iso(w.start), end: iso(w.end), limit: String(a.limit ?? 50) } }),
    shape: (body, a, w) => {
      const lines = list(body, "lines").map((l) => ({
        time: text(l.time, 40),
        level: text(l.level, 20),
        host: text(l.host, 120),
        service: text(l.service, 120),
        msg: text(l.msg),
      }));
      const truncated = Boolean((body as { truncated?: unknown } | null)?.truncated);
      return {
        data: fit(lines, (kept, omitted) => ({ lines: kept, ...(omitted && { omitted }), ...(truncated && { moreMatched: true }) })),
        count: lines.length,
        title: `LogsQL: ${text(a.query, 120)}`,
        detail: `${plural(lines.length, "line")}${truncated ? " (more matched)" : ""} · ${iso(w.start).slice(0, 16)} to ${iso(w.end).slice(0, 16)} UTC`,
      };
    },
    link: (a, w) => link("/explorer", { q: String(a.query), range: w.range }),
  },
  {
    name: "metrics_query",
    source: "metrics",
    description:
      'Run a PromQL range query in OpenAsy Metrics, such as `rate(node_cpu_seconds_total{mode!="idle"}[5m])` or `up == 0`. Returns each series with its labels, its first, last, lowest and highest value, and a few points.',
    params: {
      query: { type: "string", maxLength: 1000, description: "PromQL." },
      ...WINDOW,
    },
    required: ["query"],
    request: (a, w) => {
      // About 60 points over the window, never closer than 15 seconds.
      const step = Math.max(15, Math.ceil((w.end - w.start) / 60_000));
      return {
        path: "/prometheus/api/v1/query_range",
        query: { query: String(a.query), start: String(w.start / 1000), end: String(w.end / 1000), step: String(step) },
      };
    },
    shape: (body, a, w) => {
      const data = (body as { data?: { result?: unknown } } | null)?.data;
      const result = Array.isArray(data?.result) ? (data.result as Array<{ metric?: Record<string, unknown>; values?: unknown[] }>) : [];
      const series = result.map((r) => {
        const points = (Array.isArray(r.values) ? r.values : [])
          .map((p) => (Array.isArray(p) ? ([Number(p[0]), Number(p[1])] as const) : null))
          .filter((p): p is readonly [number, number] => p !== null && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        const values = points.map((p) => p[1]);
        const max = values.length ? Math.max(...values) : null;
        const every = Math.max(1, Math.ceil(points.length / 12));
        return {
          labels: Object.fromEntries(Object.entries(r.metric ?? {}).map(([k, v]) => [text(k, 80), text(v, 160)])),
          first: values[0] ?? null,
          last: values.at(-1) ?? null,
          min: values.length ? Math.min(...values) : null,
          max,
          maxAt: max === null ? null : iso(points[values.indexOf(max)]![0] * 1000),
          points: points.filter((_, i) => i % every === 0).map(([t, v]) => [iso(t * 1000), v]),
        };
      });
      return {
        data: fit(series, (kept, omitted) => ({
          series: kept.slice(0, 20),
          ...((omitted || kept.length > 20) && { omitted: omitted + Math.max(0, kept.length - 20) }),
        })),
        count: series.length,
        title: `PromQL: ${text(a.query, 120)}`,
        detail: `${plural(series.length, "series", "series")} · ${iso(w.start).slice(0, 16)} to ${iso(w.end).slice(0, 16)} UTC`,
      };
    },
    link: (a, w) => link("/explore", { q: String(a.query), range: w.range }),
  },
  {
    name: "traces_search",
    source: "traces",
    description: "Find traces in OpenAsy Traces by service, operation, failure or duration. Returns each trace's root, duration, span count and errors.",
    params: {
      service: { type: "string", maxLength: 200, description: "Only traces with a span of this service (service.name)." },
      operation: { type: "string", maxLength: 200, description: "A span with this name." },
      errors: { type: "boolean", description: "true: only traces with a span that failed." },
      minDurationMs: { type: "integer", minimum: 0, maximum: 3_600_000, description: "A span that took at least this long." },
      ...WINDOW,
      limit: { type: "integer", minimum: 1, maximum: 20, description: "At most this many traces; 20 when left out." },
    },
    request: (a, w) => ({
      path: "/api/v1/traces",
      query: {
        start: iso(w.start),
        end: iso(w.end),
        limit: String(a.limit ?? 20),
        ...(a.service !== undefined && { service: String(a.service) }),
        ...(a.operation !== undefined && { operation: String(a.operation) }),
        ...(a.errors !== undefined && { errors: String(a.errors) }),
        ...(a.minDurationMs !== undefined && { minDurationMs: String(a.minDurationMs) }),
      },
    }),
    shape: (body, a, w) => {
      const traces = list(body, "traces").map((t) => ({
        traceId: text(t.traceId, 64),
        start: text(t.start, 40),
        durationMs: num(t.durationMs),
        root: `${text(t.rootService, 120)} ${text(t.rootName, 200)}`,
        spans: num(t.spans),
        errors: num(t.errors),
      }));
      return {
        data: fit(traces, (kept, omitted) => ({ traces: kept, ...(omitted && { omitted }) })),
        count: traces.length,
        title: `Traces${a.service ? ` of ${text(a.service, 80)}` : ""}${a.operation ? ` ${text(a.operation, 80)}` : ""}${a.errors ? ", failed" : ""}`,
        detail: `${plural(traces.length, "trace")} · ${iso(w.start).slice(0, 16)} to ${iso(w.end).slice(0, 16)} UTC`,
      };
    },
    link: (a, w) =>
      link("/traces", { service: a.service as string, operation: a.operation as string, errors: a.errors === true ? "true" : undefined, range: w.range }),
  },
  {
    name: "siem_signals",
    source: "siem",
    description: "List signals in OpenAsy SIEM: detections raised by its rules on hosts, most severe and most recent first.",
    params: {
      status: { type: "string", enum: ["open", "new", "investigating", "closed", "false-positive"], description: "open (default) is new and investigating." },
      severity: { type: "string", maxLength: 40, pattern: SEVERITIES, description: "Comma-separated: critical, high, medium, low." },
      host: { type: "string", maxLength: 253, description: "Exact host name." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "At most this many signals; 25 when left out." },
    },
    request: (a) => ({
      path: "/api/v1/signals",
      query: {
        limit: String(a.limit ?? 25),
        ...(a.status !== undefined && { status: String(a.status) }),
        ...(a.severity !== undefined && { severity: String(a.severity) }),
        ...(a.host !== undefined && { host: String(a.host) }),
      },
    }),
    shape: (body, a) => {
      const signals = list(body, "signals").map((s) => ({
        id: text(s.id, 64),
        rule: text((s.rule as { title?: unknown } | undefined)?.title, 200),
        severity: text(s.severity, 20),
        host: text(s.host, 253),
        status: text(s.status, 20),
        count: num(s.count),
        firstSeen: text(s.firstSeen, 40),
        lastSeen: text(s.lastSeen, 40),
      }));
      return {
        data: fit(signals, (kept, omitted) => ({ signals: kept, ...(omitted && { omitted }) })),
        count: signals.length,
        title: `Signals${a.host ? ` on ${text(a.host, 80)}` : ""}${a.severity ? `, ${text(a.severity, 40)}` : ""}`,
        detail: `${plural(signals.length, "signal")} · ${a.status ?? "open"}`,
      };
    },
    link: (a) => link("/signals", { host: a.host as string, status: a.status as string }),
  },
  {
    name: "alerts_groups",
    source: "alerts",
    description: "List alert groups in OpenAsy Alerts: alerts from Prometheus rules and products, grouped, with who is on call and who acknowledged.",
    params: { state: { type: "string", enum: ["firing", "silenced", "resolved"], description: "Only groups in this state." } },
    request: (a) => ({ path: "/api/v1/groups", query: a.state !== undefined ? { state: String(a.state) } : ({} as Record<string, string>) }),
    shape: (body, a) => {
      const groups = list(body, "groups").map((g) => ({
        key: text(g.key, 200),
        labels: Object.fromEntries(Object.entries((g.labels as Record<string, unknown>) ?? {}).map(([k, v]) => [text(k, 80), text(v, 160)])),
        state: text(g.state, 20),
        firing: num(g.firing),
        firstAt: text(g.firstAt, 40),
        acknowledgedBy: text((g.acknowledged as { by?: unknown } | null)?.by, 120),
        onCall: text((g.onCall as { name?: unknown } | null)?.name, 120),
      }));
      return {
        data: fit(groups, (kept, omitted) => ({ groups: kept, ...(omitted && { omitted }) })),
        count: groups.length,
        title: `Alert groups${a.state ? `, ${a.state}` : ""}`,
        detail: plural(groups.length, "group"),
      };
    },
    link: (a) => link("/groups", { state: a.state as string }),
  },
  {
    name: "incidents_list",
    source: "incidents",
    description: "List incidents in OpenAsy Incidents: active first, the most serious first. Search the title, summary, commander or key with q.",
    params: {
      status: { type: "string", enum: ["active", "open", "investigating", "mitigated", "resolved"], description: "active is everything not resolved." },
      severity: { type: "string", maxLength: 40, pattern: SEVERITIES, description: "Comma-separated: critical, high, medium, low." },
      q: { type: "string", maxLength: 128, description: "Text in the title, summary, commander or key." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "At most this many incidents; 25 when left out." },
    },
    request: (a) => ({
      path: "/api/v1/incidents",
      query: {
        limit: String(a.limit ?? 25),
        ...(a.status !== undefined && { status: String(a.status) }),
        ...(a.severity !== undefined && { severity: String(a.severity) }),
        ...(a.q !== undefined && { q: String(a.q) }),
      },
    }),
    shape: (body, a) => {
      const incidents = list(body, "incidents").map((i) => ({
        key: text(i.key, 40),
        title: text(i.title, 200),
        severity: text(i.severity, 20),
        status: text(i.status, 20),
        commander: text(i.commander, 120),
        summary: text(i.summary, 300),
        createdAt: text(i.createdAt, 40),
        resolvedAt: text(i.resolvedAt, 40),
      }));
      return {
        data: fit(incidents, (kept, omitted) => ({ incidents: kept, ...(omitted && { omitted }) })),
        count: incidents.length,
        title: `Incidents${a.q ? ` matching ${text(a.q, 60)}` : ""}${a.status ? `, ${a.status}` : ""}`,
        detail: plural(incidents.length, "incident"),
      };
    },
    link: (a) => link("/incidents", { q: a.q as string, status: a.status as string }),
  },
  {
    name: "incidents_get",
    source: "incidents",
    description: "Read one incident in OpenAsy Incidents by its key, such as INC-12: its summary, status, commander and timeline.",
    params: { key: { type: "string", maxLength: 64, pattern: "^[A-Za-z0-9_-]{1,64}$", description: "The incident's key, such as INC-12." } },
    required: ["key"],
    request: (a) => ({ path: `/api/v1/incidents/${encodeURIComponent(String(a.key))}`, query: {} }),
    shape: (body, a) => {
      const i = (body ?? {}) as Record<string, unknown>;
      const timeline = list(i, "timeline").map((e) => ({ at: text(e.at, 40), kind: text(e.kind, 30), author: text(e.author, 120), text: text(e.text) }));
      const head = {
        key: text(i.key, 40),
        title: text(i.title, 200),
        severity: text(i.severity, 20),
        status: text(i.status, 20),
        commander: text(i.commander, 120),
        summary: text(i.summary, 1000),
        products: Array.isArray(i.products) ? i.products.map((p) => text(p, 40)) : [],
        createdAt: text(i.createdAt, 40),
        resolvedAt: text(i.resolvedAt, 40),
      };
      return {
        data: fit(timeline, (kept, omitted) => ({ ...head, timeline: kept, ...(omitted && { timelineOmitted: omitted }) })),
        count: 1,
        title: `${text(i.key ?? a.key, 40)} ${text(i.title, 120) ?? ""}`.trim(),
        detail: `${text(i.severity, 20)} · ${text(i.status, 20)} · ${plural(timeline.length, "timeline entry", "timeline entries")}`,
      };
    },
    link: (a) => `/incidents/${encodeURIComponent(String(a.key))}`,
  },
  {
    name: "vulnerabilities_findings",
    source: "vulnerabilities",
    description: "List open vulnerabilities in OpenAsy Vulnerabilities, riskiest first, with the package, fix and how many hosts and images have it.",
    params: {
      severity: { type: "string", maxLength: 40, pattern: SEVERITIES, description: "Comma-separated: critical, high, medium, low." },
      kev: { type: "boolean", description: "true: only those in the CISA catalogue of known exploited vulnerabilities." },
      fixable: { type: "boolean", description: "true: only those with a fixed version." },
      q: { type: "string", maxLength: 128, description: "A vulnerability id, alias or package name." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "At most this many; 25 when left out." },
    },
    request: (a) => ({
      path: "/api/v1/vulnerabilities",
      query: {
        limit: String(a.limit ?? 25),
        ...(a.severity !== undefined && { severity: String(a.severity) }),
        ...(a.kev !== undefined && { kev: String(a.kev) }),
        ...(a.fixable !== undefined && { fixable: String(a.fixable) }),
        ...(a.q !== undefined && { q: String(a.q) }),
      },
    }),
    shape: (body, a) => {
      const found = list(body, "vulnerabilities").map((v) => {
        const pkg = (v.package ?? {}) as Record<string, unknown>;
        const fix = (v.fix ?? {}) as Record<string, unknown>;
        return {
          vulnerability: text(v.vulnerability, 64),
          package: text(pkg.name, 200),
          versions: Array.isArray(pkg.versions) ? pkg.versions.slice(0, 5).map((x) => text(x, 60)) : [],
          severity: text(v.severity, 20),
          cvss: num(v.cvss),
          knownExploited: v.knownExploited === true,
          fix: fix.version ? `${text(fix.state, 20)} in ${text(fix.version, 60)}` : text(fix.state, 20),
          hosts: num(v.hosts),
          images: num(v.images),
        };
      });
      return {
        data: fit(found, (kept, omitted) => ({ vulnerabilities: kept, ...(omitted && { omitted }) })),
        count: found.length,
        title: `Vulnerabilities${a.q ? ` matching ${text(a.q, 60)}` : ""}${a.severity ? `, ${text(a.severity, 40)}` : ""}${a.kev ? ", known exploited" : ""}`,
        detail: plural(found.length, "vulnerability", "vulnerabilities"),
      };
    },
    link: (a) => link("/findings", { q: a.q as string, severity: a.severity as string }),
  },
];

export const toolNamed = (name: string) => TOOLS.find((t) => t.name === name);
