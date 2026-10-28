// Writes openapi.json (ADR 0014, 0024). Run `node scripts/openapi.ts` after changing the API; a test fails when the
// file is out of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const obj = (properties: Record<string, S>, required = Object.keys(properties)) => ({ type: "object", required, properties });

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const noContent = { description: "Done." };
const json = (schema: S) => ({ required: true, content: { "application/json": { schema } } });
const VIEWER = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const id = (what: string) => [{ name: "id", in: "path", required: true, description: `The ${what}'s id.`, schema: str }];
const SOURCE_ID = [
  {
    name: "id",
    in: "path",
    required: true,
    description: "The product, as OpenAsy names it.",
    schema: { type: "string", enum: ["logs", "metrics", "traces", "siem", "alerts", "incidents", "vulnerabilities"] },
  },
];

/** An operation that needs a role (ADR 0003), with the refusals every such operation can answer. */
function op(role: "viewer" | "editor" | "admin", o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: VIEWER,
    "x-openasy-role": role,
    description: [`Needs the ${role} role.`, o.description].filter(Boolean).join(" "),
    responses: { ...o.responses, "401": problem, "403": problem },
  };
}

const schemas: Record<string, S> = {
  Problem: obj(
    {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        enum: [
          "invalid-token",
          "invalid-json",
          "invalid-body",
          "conflict",
          "not-found",
          "not-configured",
          "internal-error",
          "unauthenticated",
          "invalid-credentials",
          "mfa-required",
          "mfa-setup-required",
          "forbidden",
          "cross-site",
          "rate-limited",
        ],
        description: "Stable; match on this.",
      },
      detail: str,
    },
    ["type", "title", "status", "code"],
  ),
  Status: obj({ status: str }),
  Version: obj({ product: { const: "assistant" }, version: str }),
  ProductLink: obj({
    id: { type: "string", description: "The product, as OpenAsy names it.", examples: ["logs"] },
    url: { type: "string", format: "uri", description: "The address people open it at.", examples: ["https://logs.example.com"] },
  }),
  ProductList: obj({ products: arr(ref("ProductLink")) }),
  Model: {
    oneOf: [
      { ...obj({ configured: { const: false } }), description: "No model is set up: questions are refused and nothing is sent anywhere (ADR 0015)." },
      obj({
        configured: { const: true },
        provider: {
          type: "string",
          enum: ["openai", "anthropic"],
          description: "openai is any server with OpenAI's chat completions and tool calling: Ollama, vLLM, llama.cpp.",
        },
        baseUrl: { type: "string", format: "uri", description: "Where questions and what the tools return are sent." },
        model: str,
        maxTokens: int,
        hasKey: { type: "boolean", description: "Whether an API key is kept, sealed. It is never returned (ADR 0021)." },
        destination: obj({
          host: str,
          network: {
            type: "string",
            enum: ["this-host", "private", "internet"],
            description: "Where the address is, as far as its name tells: on this host, on a private network, or on the internet.",
          },
        }),
        updatedBy: str,
        updatedAt: dt,
      }),
    ],
  },
  NewModel: obj(
    {
      provider: { type: "string", enum: ["openai", "anthropic"] },
      baseUrl: {
        type: "string",
        format: "uri",
        description: "openai: up to and with /v1, such as http://ollama:11434/v1. anthropic: https://api.anthropic.com.",
      },
      model: { type: "string", maxLength: 200, examples: ["llama3.1:8b"] },
      apiKey: {
        type: ["string", "null"],
        maxLength: 500,
        description: "Sealed with the install's key. Leave it out to keep the one kept, which is only kept while baseUrl and provider stay; null removes it.",
      },
      maxTokens: { type: "integer", minimum: 256, maximum: 32000, default: 2048, description: "The longest answer, in the model's tokens." },
    },
    ["provider", "baseUrl", "model"],
  ),
  ModelCheck: obj({ ok: bool, ms: int, reply: nul(str), error: nul(str) }),
  Settings: obj({ retentionDays: { type: "integer", minimum: 1, maximum: 400, description: "Conversations not added to for this long are deleted." } }),
  Source: obj({
    id: str,
    name: str,
    tools: { ...arr(str), description: "The read-only tools that read this product." },
    allowed: { type: "boolean", description: "Whether the tools may read it. Nothing is read until an admin allows it." },
    apiUrl: { ...nul(str), description: "Where Assistant reads its API; from OPENASY_PRODUCTS until an admin sets another." },
    webUrl: { ...nul(str), description: "Where people open it; citations link there." },
    connection: {
      ...nul(obj({ connectedAt: dt, lastUsedAt: nul(dt) })),
      description: "The caller's own token for it, which every tool call to it uses. The token is never returned.",
    },
  }),
  SourceList: obj({ sources: arr(ref("Source")) }),
  NewSource: obj(
    {
      allowed: bool,
      apiUrl: { type: ["string", "null"], format: "uri", description: "Needed to allow it. A new address drops every token connected for the old one." },
      webUrl: { type: ["string", "null"], format: "uri" },
    },
    ["allowed"],
  ),
  NewConnection: obj({
    token: {
      type: "string",
      description:
        "An API token of that product with the viewer or editor role, such as oa_logs_... It must be accepted there and must not be able to manage the product.",
    },
  }),
  Call: obj({
    n: { type: "integer", description: "The number the answer cites it by, as [n]." },
    tool: str,
    source: nul(str),
    args: { type: "object", description: "The arguments, as checked." },
    status: {
      type: "string",
      enum: ["ok", "empty", "not-connected", "invalid", "error"],
      description: "ok read something; empty read nothing; not-connected: the caller has no token for the product; invalid: refused before anything was sent.",
    },
    title: str,
    detail: str,
    href: { ...nul(str), description: "The product's page with the same query, where the caller sees the data." },
    count: int,
    ms: int,
    error: nul(str),
  }),
  Message: {
    type: "object",
    required: ["role", "text", "status", "error", "createdAt"],
    properties: {
      role: { type: "string", enum: ["user", "assistant"] },
      text: { type: "string", description: "An answer cites calls as [n]; citations of calls that read nothing are taken out." },
      status: { type: "string", enum: ["question", "answered", "failed"] },
      error: nul(str),
      createdAt: dt,
      model: nul(str),
      ms: nul(int),
      sources: { ...arr(ref("Call")), description: "Every tool call the answer made, in order." },
      cited: arr(int),
      grounded: { type: "boolean", description: "false when no call read anything: nothing in the answer comes from a source." },
    },
  },
  Conversation: obj({ id: str, title: str, createdAt: dt, updatedAt: dt, messages: arr(ref("Message")) }),
  ConversationSummary: obj({
    id: str,
    title: str,
    createdAt: dt,
    updatedAt: dt,
    questions: int,
    sources: { ...arr(str), description: "Products the last answer read." },
  }),
  ConversationList: obj({ retentionDays: int, conversations: arr(ref("ConversationSummary")) }),
  NewQuestion: obj({ question: { type: "string", minLength: 1, maxLength: 4000 } }),
};

const spec = {
  openapi: "3.1.1",
  info: {
    title: "OpenAsy Assistant API",
    version: "0.1.0",
    summary: "Questions across products in plain language, answered with read-only tools as the person asking, with every source cited.",
    description:
      "Every screen of Assistant uses this API, and so can your scripts (ADR 0014). Within `/api/v1` changes are additive only; anything removed is deprecated first (ADR 0024). Errors use Problem Details (RFC 9457).\n\nA question is answered by the language model an admin set, which may only call read-only tools; each tool reads one OpenAsy product with the caller's own API token for it, so an answer holds nothing the caller could not open in that product (ADR 0073). Conversations and tokens belong to whoever made them: a signed-in person, or an API token of Assistant. Each operation names the role it needs (`x-openasy-role`: viewer, editor, admin; ADR 0003).\n\nSign-in, members and API tokens are under `/api/v1/auth`, provided by [@openasy/auth](https://github.com/openasy/auth#routes).",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/", description: "This Assistant" }],
  tags: [
    { name: "Conversations", description: "Questions and their cited answers; each person's own." },
    { name: "Sources", description: "The products the tools read, and each person's token for them." },
    { name: "Model", description: "The language model questions are sent to, and how long conversations are kept." },
    { name: "Product", description: "Version and health of this Assistant." },
  ],
  paths: {
    "/api/v1/conversations": {
      get: op("viewer", {
        operationId: "listConversations",
        tags: ["Conversations"],
        summary: "The caller's conversations",
        description: "Newest first, at most 500. Nobody else's are listed, an admin's request included.",
        responses: { "200": ok(ref("ConversationList")) },
      }),
      post: op("viewer", {
        operationId: "ask",
        tags: ["Conversations"],
        summary: "Ask a question",
        description:
          "Starts a conversation and answers its first question. The answer may have failed (status failed, with the model's error); the question is kept either way. One question per caller at a time.",
        requestBody: json(ref("NewQuestion")),
        responses: {
          "201": ok(ref("Conversation"), "The conversation, with the answer."),
          "400": problem,
          "409": problem,
          "422": problem,
        },
      }),
    },
    "/api/v1/conversations/{id}": {
      get: op("viewer", {
        operationId: "getConversation",
        tags: ["Conversations"],
        summary: "A conversation",
        parameters: id("conversation"),
        responses: { "200": ok(ref("Conversation")), "404": problem },
      }),
      delete: op("viewer", {
        operationId: "deleteConversation",
        tags: ["Conversations"],
        summary: "Delete a conversation",
        parameters: id("conversation"),
        responses: { "204": noContent, "404": problem },
      }),
    },
    "/api/v1/conversations/{id}/messages": {
      post: op("viewer", {
        operationId: "askFollowUp",
        tags: ["Conversations"],
        summary: "Ask a follow-up",
        description: "The earlier questions and answers go with it, as text.",
        parameters: id("conversation"),
        requestBody: json(ref("NewQuestion")),
        responses: { "200": ok(ref("Conversation")), "400": problem, "404": problem, "409": problem, "422": problem },
      }),
    },
    "/api/v1/sources": {
      get: op("viewer", {
        operationId: "listSources",
        tags: ["Sources"],
        summary: "Products the tools can read",
        description: "Each with whether an admin allowed it, and whether the caller connected a token for it.",
        responses: { "200": ok(ref("SourceList")) },
      }),
    },
    "/api/v1/sources/{id}": {
      put: op("admin", {
        operationId: "setSource",
        tags: ["Sources"],
        summary: "Allow a product, and say where it is",
        parameters: SOURCE_ID,
        requestBody: json(ref("NewSource")),
        responses: { "200": ok(ref("Source")), "400": problem, "404": problem, "422": problem },
      }),
    },
    "/api/v1/sources/{id}/connection": {
      put: op("viewer", {
        operationId: "connectSource",
        tags: ["Sources"],
        summary: "Connect the caller's own token",
        description:
          "Checked first: the address must be that product, which must accept the token, and the token must not be able to list the product's API tokens (admin or owner). Kept sealed (ADR 0021).",
        parameters: SOURCE_ID,
        requestBody: json(ref("NewConnection")),
        responses: { "200": ok(ref("Source")), "400": problem, "404": problem, "409": problem, "422": problem },
      }),
      delete: op("viewer", {
        operationId: "disconnectSource",
        tags: ["Sources"],
        summary: "Forget the caller's token",
        parameters: SOURCE_ID,
        responses: { "204": noContent, "404": problem },
      }),
    },
    "/api/v1/model": {
      get: op("viewer", {
        operationId: "getModel",
        tags: ["Model"],
        summary: "Where questions are sent",
        description: "Everyone may see it: questions, earlier turns and what the tools return go to this address.",
        responses: { "200": ok(ref("Model")) },
      }),
      put: op("admin", {
        operationId: "setModel",
        tags: ["Model"],
        summary: "Set the model",
        requestBody: json(ref("NewModel")),
        responses: { "200": ok(ref("Model")), "400": problem, "409": problem, "422": problem },
      }),
      delete: op("admin", {
        operationId: "deleteModel",
        tags: ["Model"],
        summary: "Remove the model",
        description: "Questions are refused again, and nothing is sent anywhere.",
        responses: { "204": noContent },
      }),
    },
    "/api/v1/model/check": {
      post: op("admin", {
        operationId: "checkModel",
        tags: ["Model"],
        summary: "Check that the model answers",
        description: "Sends one short message without tools and no data.",
        responses: { "200": ok(ref("ModelCheck")), "409": problem },
      }),
    },
    "/api/v1/settings": {
      get: op("viewer", { operationId: "getSettings", tags: ["Model"], summary: "Retention", responses: { "200": ok(ref("Settings")) } }),
      put: op("admin", {
        operationId: "setSettings",
        tags: ["Model"],
        summary: "Set the retention",
        description: "Conversations past it are deleted at once.",
        requestBody: json(ref("Settings")),
        responses: { "200": ok(ref("Settings")), "400": problem, "422": problem },
      }),
    },
    "/api/v1/products": {
      get: op("viewer", {
        operationId: "listProducts",
        tags: ["Product"],
        summary: "Other products of this install",
        responses: { "200": ok(ref("ProductList"), "From OPENASY_PRODUCTS, for the product switcher.") },
      }),
    },
    "/api/v1/version": {
      get: { operationId: "getVersion", tags: ["Product"], summary: "Version", security: [], responses: { "200": ok(ref("Version"), "The running version.") } },
    },
    "/healthz": {
      get: {
        operationId: "liveness",
        tags: ["Product"],
        summary: "Liveness",
        security: [],
        responses: { "200": ok(ref("Status"), "The process is running.") },
      },
    },
    "/readyz": {
      get: {
        operationId: "readiness",
        tags: ["Product"],
        summary: "Readiness",
        description: "Ready while its database answers; a model or a product that does not is shown in the answers, not here.",
        security: [],
        responses: { "200": ok(ref("Status"), "Ready to serve."), "503": ok(ref("Status"), "The database is unavailable.") },
      },
    },
    "/metrics": {
      get: {
        operationId: "metrics",
        tags: ["Product"],
        summary: "Prometheus metrics",
        security: [],
        responses: { "200": { description: "Metrics in the Prometheus text format.", content: { "text/plain": { schema: str } } } },
      },
    },
  },
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-openasy-session",
        description:
          "The browser session after signing in (`openasy-session` when Assistant runs on plain http://localhost). Requests that change something must come from the Assistant origin.",
      },
      apiToken: {
        type: "http",
        scheme: "bearer",
        description:
          "An API token created under Settings → API tokens (`oa_assistant_...`): one role, always an expiry (ADR 0003). It has conversations and connected products of its own.",
      },
      adminToken: {
        type: "http",
        scheme: "bearer",
        description:
          "Only when Assistant is started by its tests or a local script: one shared token with the admin role. A production install does not have it.",
      },
    },
    responses: { Problem: { description: "An error, as RFC 9457 Problem Details.", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = spec;
if (import.meta.url === `file://${process.argv[1]}`) writeFileSync(new URL("../openapi.json", import.meta.url), JSON.stringify(spec, null, 2) + "\n");
