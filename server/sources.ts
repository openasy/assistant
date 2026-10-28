// Calls to the other OpenAsy products, the only way Assistant reads anything (ADR 0014, 0023). There is one function
// that reads and it sends GET, with no body, with the person's own token and to the address an admin set for that
// product. There is no way to send another method: the tools have no say in it.
import { readCapped } from "./model.ts";
import type { Request } from "./tools.ts";

/** The most a product's answer may weigh before it is shaped and cut for the model. */
const MAX_BODY = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

export type ReadResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number | null; reason: "unauthorized" | "forbidden" | "not-found" | "invalid" | "unreachable" | "failed"; message: string };

export interface ReadOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET one path of a product's API with a bearer token. Retried once, with jitter, when the product is unreachable. */
export async function read(apiUrl: string, token: string, req: Request, o: ReadOptions = {}): Promise<ReadResult> {
  const url = new URL(apiUrl.replace(/\/+$/, "") + req.path);
  for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);
  const doFetch = o.fetch ?? fetch;
  let last: ReadResult = { ok: false, status: null, reason: "unreachable", message: "not tried" };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(200 + Math.random() * 300);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        // A redirect could take the token to another address.
        redirect: "error",
        signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as Error;
      last = {
        ok: false,
        status: null,
        reason: "unreachable",
        message: e.name === "TimeoutError" ? "did not answer within 10 seconds" : String((e.cause as Error)?.message ?? e.message),
      };
      continue;
    }
    let text: string;
    try {
      text = await readCapped(res, MAX_BODY);
    } catch {
      return { ok: false, status: res.status, reason: "failed", message: "the answer was larger than 2 MB; narrow the query" };
    }
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: reported below by status, or as invalid
    }
    if (res.ok) {
      if (body === null) return { ok: false, status: res.status, reason: "failed", message: "the answer was not JSON" };
      return { ok: true, status: res.status, body };
    }
    const detail = String((body as { detail?: unknown; error?: unknown } | null)?.detail ?? (body as { error?: unknown } | null)?.error ?? "").slice(0, 300);
    if (res.status === 401)
      return { ok: false, status: 401, reason: "unauthorized", message: "the product no longer accepts this person's token; connect it again under Sources" };
    if (res.status === 403) return { ok: false, status: 403, reason: "forbidden", message: detail || "this person's token may not read this" };
    if (res.status === 404) return { ok: false, status: 404, reason: "not-found", message: detail || "not found" };
    if (res.status === 400 || res.status === 422)
      return { ok: false, status: res.status, reason: "invalid", message: detail || "the product refused the query" };
    last = { ok: false, status: res.status, reason: res.status >= 502 ? "unreachable" : "failed", message: detail || `the product answered ${res.status}` };
    if (res.status < 502) return last;
  }
  return last;
}

export type TokenCheck = { ok: true } | { ok: false; code: "invalid-token" | "too-powerful" | "wrong-product" | "unreachable"; message: string };

/**
 * Whether a token is one this person may give: the product at that address is the one it says, the token is
 * accepted there, and it cannot manage that product. A token that lists the product's API tokens has the admin role
 * or higher; Assistant needs to read and nothing more, so such a token is refused (ADR 0003).
 */
export async function checkToken(apiUrl: string, product: string, token: string, o: ReadOptions = {}): Promise<TokenCheck> {
  const version = await read(apiUrl, token, { path: "/api/v1/version", query: {} }, o);
  if (!version.ok) return { ok: false, code: "unreachable", message: `The product at ${apiUrl} could not be read: ${version.message}.` };
  const named = (version.body as { product?: unknown }).product;
  if (named !== product) return { ok: false, code: "wrong-product", message: `${apiUrl} is OpenAsy ${String(named ?? "something else")}, not ${product}.` };
  const reads = await read(apiUrl, token, { path: "/api/v1/products", query: {} }, o);
  if (!reads.ok)
    return reads.reason === "unauthorized" || reads.reason === "forbidden"
      ? { ok: false, code: "invalid-token", message: `${product} does not accept this token: it is unknown, expired or revoked.` }
      : { ok: false, code: "unreachable", message: `${product} could not be read: ${reads.message}.` };
  const manages = await read(apiUrl, token, { path: "/api/v1/auth/tokens", query: {} }, o);
  if (manages.ok)
    return {
      ok: false,
      code: "too-powerful",
      message: `This token can manage ${product} (the admin or owner role). Assistant only reads: create a token with the viewer role in ${product}, under Settings, API tokens.`,
    };
  if (manages.reason !== "forbidden") return { ok: false, code: "unreachable", message: `${product} could not be read: ${manages.message}.` };
  return { ok: true };
}
