// The language model, behind one small interface: a system prompt, the turns so far and the tools, in; text and tool
// calls, out. Two wire formats are spoken: OpenAI's chat completions with tool calling, which a local Ollama, vLLM or
// llama.cpp server speaks too, and Anthropic's Messages API. Nothing else is sent anywhere, and nothing is sent at
// all until an admin sets a model (ADR 0015).
import type { ToolSpec } from "./tools.ts";

export type Provider = "openai" | "anthropic";

export interface ModelConfig {
  provider: Provider;
  /** openai: up to and with /v1, such as http://ollama:11434/v1. anthropic: https://api.anthropic.com. */
  baseUrl: string;
  model: string;
  apiKey: string | null;
  maxTokens: number;
}

/** A tool call the model asked for. `input` is what it sent, still unchecked; `raw` is set when it was not JSON. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  raw?: string;
}

export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; calls: ToolCall[] }
  | { role: "tool"; results: Array<{ id: string; name: string; content: string }> };

export interface Reply {
  text: string;
  calls: ToolCall[];
}

export class ModelError extends Error {}

export interface ModelOptions {
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** The longest answer read from the model. */
const MAX_BODY = 1024 * 1024;

async function post(url: string, headers: Record<string, string>, body: unknown, o: ModelOptions): Promise<unknown> {
  const doFetch = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    throw new ModelError(
      e.name === "TimeoutError"
        ? `The model did not answer within ${Math.round(o.timeoutMs / 1000)} seconds.`
        : `The model could not be reached: ${causeOf(e)}`,
    );
  }
  const text = await readCapped(res, MAX_BODY).catch(() => {
    throw new ModelError("The model's answer was too large.");
  });
  if (!res.ok) {
    // The provider's own message, which says what is wrong with the model or the key; never the key itself.
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string };
      detail = (typeof j.error === "string" ? j.error : j.error?.message) ?? detail;
    } catch {
      // not JSON: keep the start of the body
    }
    throw new ModelError(`The model answered ${res.status}: ${detail.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ModelError("The model's answer is not JSON.");
  }
}

const causeOf = (e: Error) => String((e.cause as Error | undefined)?.message ?? e.message);

/** The body as text, failing beyond `max` bytes so a misbehaving server cannot fill the memory. */
export async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const join = (base: string, path: string) => base.replace(/\/+$/, "") + path;

function parseInput(raw: unknown): { input: unknown; raw?: string } {
  if (typeof raw !== "string") return { input: raw ?? {} };
  if (raw.trim() === "") return { input: {} };
  try {
    return { input: JSON.parse(raw) as unknown };
  } catch {
    return { input: undefined, raw: raw.slice(0, 200) };
  }
}

// ---------------------------------------------------------------- OpenAI chat completions

async function openai(cfg: ModelConfig, system: string, turns: Turn[], tools: ToolSpec[], o: ModelOptions & { final: boolean }): Promise<Reply> {
  const messages: unknown[] = [{ role: "system", content: system }];
  for (const t of turns) {
    if (t.role === "user") messages.push({ role: "user", content: t.text });
    else if (t.role === "assistant")
      messages.push({
        role: "assistant",
        content: t.text || null,
        ...(t.calls.length && {
          tool_calls: t.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.raw ?? JSON.stringify(c.input ?? {}) } })),
        }),
      });
    else for (const r of t.results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }
  const body = {
    model: cfg.model,
    messages,
    max_tokens: cfg.maxTokens,
    temperature: 0,
    ...(tools.length && { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: o.final ? "none" : "auto" }),
  };
  const res = (await post(join(cfg.baseUrl, "/chat/completions"), cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}, body, o)) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> } }>;
  };
  const message = res.choices?.[0]?.message;
  if (!message) throw new ModelError("The model's answer has no message.");
  return {
    text: typeof message.content === "string" ? message.content : "",
    calls: (message.tool_calls ?? []).map((c, i) => ({ id: c.id || `call_${i}`, name: String(c.function?.name ?? ""), ...parseInput(c.function?.arguments) })),
  };
}

// ---------------------------------------------------------------- Anthropic Messages

async function anthropic(cfg: ModelConfig, system: string, turns: Turn[], tools: ToolSpec[], o: ModelOptions & { final: boolean }): Promise<Reply> {
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const t of turns) {
    if (t.role === "user") messages.push({ role: "user", content: [{ type: "text", text: t.text }] });
    else if (t.role === "assistant")
      messages.push({
        role: "assistant",
        content: [
          ...(t.text ? [{ type: "text", text: t.text }] : []),
          ...t.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input && typeof c.input === "object" ? c.input : {} })),
        ],
      });
    // Every result of one turn goes back in one user message, as the API requires.
    else messages.push({ role: "user", content: t.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content })) });
  }
  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    temperature: 0,
    system,
    messages,
    ...(tools.length && {
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      tool_choice: { type: o.final ? "none" : "auto" },
    }),
  };
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01", ...(cfg.apiKey && { "x-api-key": cfg.apiKey }) };
  const res = (await post(join(cfg.baseUrl, "/v1/messages"), headers, body, o)) as {
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
  };
  if (!Array.isArray(res.content)) throw new ModelError("The model's answer has no content.");
  return {
    text: res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(""),
    calls: res.content.filter((b) => b.type === "tool_use").map((b, i) => ({ id: b.id || `toolu_${i}`, name: String(b.name ?? ""), input: b.input ?? {} })),
  };
}

/**
 * One turn of the model: what it writes, and the tools it wants called. `final` keeps the tools described, as both
 * APIs need when earlier turns used them, but tells the model to answer without calling another.
 */
export function complete(cfg: ModelConfig, system: string, turns: Turn[], tools: ToolSpec[], o: ModelOptions & { final?: boolean }): Promise<Reply> {
  const opts = { ...o, final: o.final ?? false };
  return cfg.provider === "anthropic" ? anthropic(cfg, system, turns, tools, opts) : openai(cfg, system, turns, tools, opts);
}
