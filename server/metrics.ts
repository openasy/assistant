// Prometheus text exposition, written by hand: a few lines, no client library needed. Questions by outcome and tool
// calls by tool and status, so Metrics can keep them and Alerts can fire when sources keep failing.
const requests = new Map<string, number>();
const questions = new Map<string, number>();
const toolCalls = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

/** answered: at least one source read something; no-data: none did; failed: the model did not answer. */
export function countQuestion(outcome: "answered" | "no-data" | "failed") {
  questions.set(outcome, (questions.get(outcome) ?? 0) + 1);
}

/** `tool` is one of the fixed tools, or unknown. */
export function countToolCall(tool: string, status: string) {
  const key = `tool="${tool}",status="${status}"`;
  toolCalls.set(key, (toolCalls.get(key) ?? 0) + 1);
}

export interface Gauges {
  modelConfigured: boolean;
  sourcesAllowed: number;
  connections: number;
  conversations: number;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="assistant",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_assistant_questions_total Questions asked, by outcome.",
    "# TYPE openasy_assistant_questions_total counter",
    ...[...questions].map(([outcome, n]) => `openasy_assistant_questions_total{outcome="${outcome}"} ${n}`),
    "# HELP openasy_assistant_tool_calls_total Tool calls made for questions, by tool and status.",
    "# TYPE openasy_assistant_tool_calls_total counter",
    ...[...toolCalls].map(([labels, n]) => `openasy_assistant_tool_calls_total{${labels}} ${n}`),
    "# HELP openasy_assistant_model_configured 1 when a language model is set up.",
    "# TYPE openasy_assistant_model_configured gauge",
    `openasy_assistant_model_configured ${g.modelConfigured ? 1 : 0}`,
    "# HELP openasy_assistant_sources_allowed Products the tools may read.",
    "# TYPE openasy_assistant_sources_allowed gauge",
    `openasy_assistant_sources_allowed ${g.sourcesAllowed}`,
    "# HELP openasy_assistant_connections People's tokens kept for products, sealed.",
    "# TYPE openasy_assistant_connections gauge",
    `openasy_assistant_connections ${g.connections}`,
    "# HELP openasy_assistant_conversations Conversations kept.",
    "# TYPE openasy_assistant_conversations gauge",
    `openasy_assistant_conversations ${g.conversations}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
