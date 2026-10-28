import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI } from "../scripts/openapi.ts";
import type { Scripted } from "./fakes.ts";
import { ADMIN_TOKEN, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "assistant-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

let next: (r: { toolResults: unknown[] }) => Scripted = () => ({ text: "ready" });

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir, script: (r) => next(r) });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const auth = (token: string, body?: string, type = "application/json") => ({
  headers: { authorization: `Bearer ${token}`, "content-type": type },
  ...(body !== undefined && { body }),
});
const admin = (body?: unknown) => auth(ADMIN_TOKEN, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes", () => {
    expect(spec).toEqual(JSON.parse(JSON.stringify(OPENAPI)));
  });

  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // Assistant's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  let conversation = "";

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("model and settings", async () => {
    await call("GET", "/api/v1/model", admin());
    await call("POST", "/api/v1/model/check", { method: "POST", ...admin() });
    await call("POST", "/api/v1/conversations", { method: "POST", ...admin({ question: "Before a model?" }) });
    await call("PUT", "/api/v1/model", {
      method: "PUT",
      ...admin({ provider: "openai", baseUrl: `${app.model.url}/v1`, model: "llama3.1:8b", apiKey: "sk-1" }),
    });
    await call("GET", "/api/v1/model", admin());
    await call("PUT", "/api/v1/model", { method: "PUT", ...admin({ provider: "gemini", baseUrl: "x", model: "m" }) });
    await call("PUT", "/api/v1/model", { method: "PUT", ...admin("nope") });
    await call("PUT", "/api/v1/model", { method: "PUT" });
    await call("POST", "/api/v1/model/check", { method: "POST", ...admin() });
    await call("POST", "/api/v1/model/check", { method: "POST" });
    await call("DELETE", "/api/v1/model", { method: "DELETE", ...admin() });
    await call("DELETE", "/api/v1/model", { method: "DELETE" });
    await call("GET", "/api/v1/model", {});
    await call("GET", "/api/v1/settings", admin());
    await call("GET", "/api/v1/settings", {});
    await call("PUT", "/api/v1/settings", { method: "PUT", ...admin({ retentionDays: 60 }) });
    await call("PUT", "/api/v1/settings", { method: "PUT", ...admin({ retentionDays: 0 }) });
    await call("PUT", "/api/v1/settings", { method: "PUT", ...admin("nope") });
    await call("PUT", "/api/v1/settings", { method: "PUT" });
  });

  it("sources", async () => {
    await call("GET", "/api/v1/sources", admin());
    await call("GET", "/api/v1/sources", {});
    await call("POST", "/api/v1/conversations", { method: "POST", ...admin({ question: "Before a source?" }) });
    const one = "/api/v1/sources/{id}";
    await call("PUT", one, { method: "PUT", ...admin({ allowed: true, apiUrl: `${app.products.url}/logs` }) }, "/api/v1/sources/logs");
    await call("PUT", one, { method: "PUT", ...admin({ allowed: true }) }, "/api/v1/sources/logs");
    await call("PUT", one, { method: "PUT", ...admin("nope") }, "/api/v1/sources/logs");
    await call("PUT", one, { method: "PUT", ...admin({ allowed: false }) }, "/api/v1/sources/nope");
    await call("PUT", one, { method: "PUT" }, "/api/v1/sources/logs");
    const connection = "/api/v1/sources/{id}/connection";
    await call("PUT", connection, { method: "PUT", ...admin({ token: "oa_logs_victor0000000000000000" }) }, "/api/v1/sources/logs/connection");
    await call("PUT", connection, { method: "PUT", ...admin({ token: "oa_logs_owner0000000000000000000" }) }, "/api/v1/sources/logs/connection");
    await call("PUT", connection, { method: "PUT", ...admin({ token: "oa_siem_victor0000000000000000" }) }, "/api/v1/sources/siem/connection");
    await call("PUT", connection, { method: "PUT", ...admin("nope") }, "/api/v1/sources/logs/connection");
    await call("PUT", connection, { method: "PUT", ...admin({ token: "x" }) }, "/api/v1/sources/nope/connection");
    await call("PUT", connection, { method: "PUT" }, "/api/v1/sources/logs/connection");
    await call("DELETE", connection, { method: "DELETE", ...admin() }, "/api/v1/sources/siem/connection");
    await call("DELETE", connection, { method: "DELETE" }, "/api/v1/sources/logs/connection");
  });

  it("conversations", async () => {
    await call("PUT", "/api/v1/model", { method: "PUT", ...admin({ provider: "openai", baseUrl: `${app.model.url}/v1`, model: "llama3.1:8b" }) });
    next = (r) =>
      r.toolResults.length
        ? { text: "One line [1]." }
        : {
            calls: [
              { name: "logs_search", arguments: { query: "*" } },
              { name: "nope", arguments: {} },
            ],
          };
    const list = "/api/v1/conversations";
    conversation = ((await call("POST", list, { method: "POST", ...admin({ question: "What do the logs say?" }) })).body as { id: string }).id;
    await call("POST", list, { method: "POST", ...admin({ question: "" }) });
    await call("POST", list, { method: "POST", ...admin("nope") });
    await call("POST", list, { method: "POST" });
    await call("GET", list, admin());
    await call("GET", list, {});
    const one = "/api/v1/conversations/{id}";
    await call("GET", one, admin(), `/api/v1/conversations/${conversation}`);
    await call("GET", one, admin(), "/api/v1/conversations/missing");
    await call("GET", one, {}, `/api/v1/conversations/${conversation}`);
    const messages = "/api/v1/conversations/{id}/messages";
    next = () => ({ status: 500 });
    await call("POST", messages, { method: "POST", ...admin({ question: "And then?" }) }, `/api/v1/conversations/${conversation}/messages`);
    await call("POST", messages, { method: "POST", ...admin({ question: "x".repeat(4001) }) }, `/api/v1/conversations/${conversation}/messages`);
    await call("POST", messages, { method: "POST", ...admin("nope") }, `/api/v1/conversations/${conversation}/messages`);
    await call("POST", messages, { method: "POST", ...admin({ question: "And?" }) }, "/api/v1/conversations/missing/messages");
    await call("POST", messages, { method: "POST" }, `/api/v1/conversations/${conversation}/messages`);
    await call("DELETE", one, { method: "DELETE", ...admin() }, `/api/v1/conversations/${conversation}`);
    await call("DELETE", one, { method: "DELETE", ...admin() }, `/api/v1/conversations/${conversation}`);
    await call("DELETE", one, { method: "DELETE" }, `/api/v1/conversations/${conversation}`);
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
