// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export type Provider = "openai" | "anthropic";
export type Network = "this-host" | "private" | "internet";

export type Model =
  | { configured: false }
  | {
      configured: true;
      provider: Provider;
      baseUrl: string;
      model: string;
      maxTokens: number;
      hasKey: boolean;
      destination: { host: string; network: Network };
      updatedBy: string;
      updatedAt: string;
    };

export interface ModelCheck {
  ok: boolean;
  ms: number;
  reply: string | null;
  error: string | null;
}

export interface Settings {
  retentionDays: number;
}

export type SourceId = "logs" | "metrics" | "traces" | "siem" | "alerts" | "incidents" | "vulnerabilities";

export interface Source {
  id: SourceId;
  name: string;
  tools: string[];
  allowed: boolean;
  apiUrl: string | null;
  webUrl: string | null;
  connection: { connectedAt: string; lastUsedAt: string | null } | null;
}

export type CallStatus = "ok" | "empty" | "not-connected" | "invalid" | "error";

/** One tool call of an answer. The answer cites it as [n]. */
export interface Call {
  n: number;
  tool: string;
  source: SourceId | null;
  args: Record<string, string | number | boolean>;
  status: CallStatus;
  title: string;
  detail: string;
  href: string | null;
  count: number;
  ms: number;
  error: string | null;
}

export interface Message {
  role: "user" | "assistant";
  text: string;
  status: "question" | "answered" | "failed";
  error: string | null;
  createdAt: string;
  model?: string | null;
  ms?: number | null;
  sources?: Call[];
  cited?: number[];
  grounded?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  questions: number;
  sources: SourceId[];
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
