import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { AssistantError, type Assistant, type Owner, type ProblemCode } from "./assistant.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";

export interface AppOptions {
  db: DatabaseSync;
  assistant: Assistant;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(assistant: Assistant, version: string) {
  return renderMetrics(version, assistant.gauges());
}

/** Serves only /metrics, for a port that is not exposed with the rest (ASSISTANT_METRICS_PORT). */
export function createMetricsHandler(assistant: Assistant, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(assistant, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'`,
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-configured": "Not configured",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

/** A JSON object body of at most limit bytes: a question fits in 16 KiB. */
async function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new AssistantError(400, "invalid-json", `The body must be JSON, at most ${Math.round(limit / 1024)} KiB.`);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new AssistantError(400, "invalid-json", "The body must be a JSON object.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  body: () => Promise<Record<string, unknown>>;
  /** Who made the request: whose conversations and tokens these are, and who the audit log names. */
  owner: () => Owner;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  handle: (ctx: Ctx) => unknown;
}

/** Changes to the model, the sources and people's tokens go to the audit log (ADR 0013). */
const audit = (action: string, by: Owner, fields: Record<string, unknown> = {}) => log("info", "audit", { action, by: by.name, owner: by.id, ...fields });

export function createApp({ db, assistant, version, auth, adminToken, webDir, docsDir, openapi, serveMetrics = true, products = [] }: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "assistant", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },

    // The language model. Everyone may see where their questions go; only admins choose it (ADR 0015).
    { method: "GET", path: "/api/v1/model", auth: "viewer", handle: () => assistant.model() },
    {
      method: "PUT",
      path: "/api/v1/model",
      auth: "admin",
      handle: async ({ body, owner }) => {
        const m = assistant.setModel(await body(), owner());
        audit("model-set", owner(), { provider: m.configured && m.provider, baseUrl: m.configured && m.baseUrl, model: m.configured && m.model });
        return m;
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/model",
      auth: "admin",
      handle: ({ res, owner }) => {
        assistant.deleteModel();
        audit("model-removed", owner());
        noContent(res);
      },
    },
    {
      method: "POST",
      path: "/api/v1/model/check",
      auth: "admin",
      handle: async ({ owner }) => {
        const r = await assistant.checkModel();
        audit("model-checked", owner(), { ok: r.ok });
        return r;
      },
    },
    { method: "GET", path: "/api/v1/settings", auth: "viewer", handle: () => assistant.settings() },
    {
      method: "PUT",
      path: "/api/v1/settings",
      auth: "admin",
      handle: async ({ body, owner }) => {
        const s = assistant.setSettings(await body());
        audit("settings-changed", owner(), s);
        return s;
      },
    },

    // The products the tools read. Admins allow them and say where they are; each person connects their own token.
    { method: "GET", path: "/api/v1/sources", auth: "viewer", handle: ({ owner }) => assistant.sources(owner().id) },
    {
      method: "PUT",
      path: "/api/v1/sources/:id",
      auth: "admin",
      handle: async ({ params, body, owner }) => {
        const { source, dropped } = assistant.setSource(params[0]!, await body(), owner());
        audit("source-changed", owner(), { source: source.id, allowed: source.allowed, apiUrl: source.apiUrl, tokensDropped: dropped });
        return source;
      },
    },
    {
      method: "PUT",
      path: "/api/v1/sources/:id/connection",
      auth: "viewer",
      handle: async ({ params, body, owner }) => {
        const s = await assistant.connect(owner(), params[0]!, await body());
        audit("source-connected", owner(), { source: s.id });
        return s;
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/sources/:id/connection",
      auth: "viewer",
      handle: ({ res, params, owner }) => {
        assistant.disconnect(owner(), params[0]!);
        audit("source-disconnected", owner(), { source: params[0] });
        noContent(res);
      },
    },

    // A person's own conversations. Nobody else's are listed or opened, admins' included: they hold what that
    // person's tokens could read (ADR 0073).
    { method: "GET", path: "/api/v1/conversations", auth: "viewer", handle: ({ owner }) => assistant.conversations(owner().id) },
    {
      method: "POST",
      path: "/api/v1/conversations",
      auth: "viewer",
      handle: async ({ res, body, owner }) => json(res, 201, (await assistant.ask(owner(), await body())).conversation),
    },
    { method: "GET", path: "/api/v1/conversations/:id", auth: "viewer", handle: ({ params, owner }) => assistant.conversation(owner().id, params[0]!) },
    {
      method: "DELETE",
      path: "/api/v1/conversations/:id",
      auth: "viewer",
      handle: ({ res, params, owner }) => {
        assistant.deleteConversation(owner().id, params[0]!);
        audit("conversation-deleted", owner(), { conversation: params[0] });
        noContent(res);
      },
    },
    {
      method: "POST",
      path: "/api/v1/conversations/:id/messages",
      auth: "viewer",
      handle: async ({ params, body, owner }) => (await assistant.ask(owner(), await body(), params[0]!)).conversation,
    },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, "([^/]+)")}$`) }));

  /** Returns who is calling, or null for a route anyone may call. A person and an API token each have their own data. */
  function authorize(req: IncomingMessage, access: Access): Owner | null {
    if (access === "none") return null;
    if (tokenMatches(req.headers.authorization, adminToken)) return { id: "admin-token", name: "admin token" };
    const p = auth.authorize(req, access);
    return p.kind === "session" ? { id: `user:${p.user.id}`, name: p.user.name } : { id: `token:${p.tokenId}`, name: `API token ${p.name}` };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      // Ready as long as its own SQLite file answers; a model or a product that does not is shown, not a reason to restart.
      try {
        db.prepare("SELECT 1").get();
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "database unavailable" });
      }
      return "/readyz";
    }

    if (path === "/metrics") {
      // Not even the web UI's fallback answers here when metrics have their own port.
      if (serveMetrics) send(res, 200, metricsText(assistant, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, body: () => readJson(req), owner: () => who ?? { id: "anonymous", name: "anonymous" } });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof AssistantError)) throw err;
        problem(res, err.status, err.code, err.message);
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (routeName !== "/healthz" && routeName !== "/metrics") {
      log("info", "request", { method: req.method, path: url(req), status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}

/** The path without the query string. */
const url = (req: IncomingMessage) => (req.url ?? "/").split("?")[0];
