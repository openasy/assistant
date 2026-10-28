// A fake language model and fake OpenAsy products, for the tests and for e2e/run.sh. Neither a hosted model nor a
// real product is ever called: the model answers what the test scripts, in OpenAI's chat completions shape or
// Anthropic's Messages shape, and the products answer their public API paths for the tokens the test hands out.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** What the fake model says next: text, tool calls, or both. */
export interface Scripted {
  text?: string;
  calls?: Array<{ name: string; arguments: unknown }>;
  /** Answer with this HTTP status and error instead. */
  status?: number;
}

/** What the model was sent, in one shape for both APIs, to look at in a test. */
export interface ModelRequest {
  api: "openai" | "anthropic";
  headers: IncomingMessage["headers"];
  body: Record<string, any>;
  /** The last tool results it was sent, parsed. */
  toolResults: Array<Record<string, any>>;
}

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
};

const listen = async (server: Server, port = 0, host = "127.0.0.1") => {
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${(server.address() as AddressInfo).port}`;
};

/**
 * A model server. `script` gives each answer: an array is used in order (and repeats its last), a function decides
 * from the request. It speaks POST /v1/chat/completions and POST /v1/messages.
 */
export async function fakeModel(script: Scripted[] | ((r: ModelRequest) => Scripted), opts: { port?: number; host?: string } = {}) {
  const requests: ModelRequest[] = [];
  let turn = 0;
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}") as Record<string, any>;
    const api = req.url === "/v1/messages" ? "anthropic" : req.url === "/v1/chat/completions" ? "openai" : null;
    if (req.method !== "POST" || !api) return res.writeHead(404).end();
    const messages = (body.messages ?? []) as Array<Record<string, any>>;
    const toolResults =
      api === "openai"
        ? messages.slice(messages.findLastIndex((m) => m.role === "assistant") + 1).filter((m) => m.role === "tool")
        : ((messages.at(-1)?.content ?? []) as Array<Record<string, any>>).filter((b) => b?.type === "tool_result");
    const r: ModelRequest = {
      api,
      headers: req.headers,
      body,
      toolResults: toolResults.map((t) => JSON.parse(String(t.content)) as Record<string, any>),
    };
    requests.push(r);
    const next = typeof script === "function" ? script(r) : (script[Math.min(turn, script.length - 1)] ?? { text: "" });
    turn++;
    if (next.status) {
      res.writeHead(next.status, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "scripted failure" } }));
    }
    const calls = next.calls ?? [];
    const out =
      api === "openai"
        ? {
            id: `chatcmpl-${turn}`,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                finish_reason: calls.length ? "tool_calls" : "stop",
                message: {
                  role: "assistant",
                  content: next.text ?? null,
                  ...(calls.length && {
                    tool_calls: calls.map((c, i) => ({
                      id: `call_${turn}_${i}`,
                      type: "function",
                      function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments) },
                    })),
                  }),
                },
              },
            ],
          }
        : {
            id: `msg_${turn}`,
            type: "message",
            role: "assistant",
            stop_reason: calls.length ? "tool_use" : "end_turn",
            content: [
              ...(next.text ? [{ type: "text", text: next.text }] : []),
              ...calls.map((c, i) => ({ type: "tool_use", id: `toolu_${turn}_${i}`, name: c.name, input: c.arguments })),
            ],
          };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
  const url = await listen(server, opts.port, opts.host);
  return { url, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Who a fake product's token belongs to, and whether it can manage the product. */
export interface FakeToken {
  product: string;
  person: string;
  admin?: boolean;
}

export interface ProductRequest {
  product: string;
  method: string;
  path: string;
  query: Record<string, string>;
  token: string | null;
}

type Answer = (query: URLSearchParams, who: FakeToken) => { status?: number; body: unknown };

/**
 * OpenAsy products under one server, each at /<product>, such as http://127.0.0.1:4000/logs. `answers` maps
 * `<product> <path>` to what it answers; every request is recorded with its method and token.
 */
export async function fakeProducts(tokens: Record<string, FakeToken>, answers: Record<string, Answer>, opts: { port?: number; host?: string } = {}) {
  const requests: ProductRequest[] = [];
  const server = createServer(async (req, res) => {
    await readBody(req);
    const url = new URL(req.url ?? "/", "http://fake");
    const [, product = "", ...rest] = url.pathname.split("/");
    const path = `/${rest.join("/")}`;
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    requests.push({ product, method: req.method ?? "GET", path, query: Object.fromEntries(url.searchParams), token });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": status < 400 ? "application/json" : "application/problem+json" });
      res.end(JSON.stringify(body));
    };
    // A product's API is only read: the fakes take nothing else, so a write would show as a failure.
    if (req.method !== "GET") return send(405, { code: "method-not-allowed", detail: "Assistant only reads." });
    if (path === "/api/v1/version") return send(200, { product, version: "0.1.0" });
    const who = token ? tokens[token] : undefined;
    if (!who || who.product !== product) return send(401, { code: "invalid-token", detail: "The API token is unknown or expired." });
    if (path === "/api/v1/products") return send(200, { products: [] });
    if (path === "/api/v1/auth/tokens")
      return who.admin ? send(200, { tokens: [] }) : send(403, { code: "forbidden", detail: "This needs the admin role or higher." });
    const answer =
      answers[`${product} ${path}`] ?? Object.entries(answers).find(([k]) => k.endsWith("*") && `${product} ${path}`.startsWith(k.slice(0, -1)))?.[1];
    if (!answer) return send(404, { code: "not-found", detail: "Not found." });
    const out = answer(url.searchParams, who);
    send(out.status ?? 200, out.body);
  });
  const url = await listen(server, opts.port, opts.host);
  return { url, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
