// What the search window (Cmd+K) finds in Assistant: a new question with the text, and the person's own
// conversations by title. They are read whole and filtered here.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { History, MessageSquareText } from "lucide-react";
import type { ConversationSummary } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const { conversations } = await call<{ conversations: ConversationSummary[] }>("/api/v1/conversations", { signal });
    return [
      {
        id: "ask",
        label: t("search.ask", { text: q }),
        kind: t("search.question"),
        icon: MessageSquareText,
        href: `/ask?${new URLSearchParams({ q })}`,
      },
      ...conversations
        .filter((c) => c.title.toLowerCase().includes(q))
        .slice(0, 8)
        .map((c): SearchResult => ({
          id: `conversation:${c.id}`,
          label: c.title,
          kind: t("search.conversation"),
          icon: History,
          href: `/ask?${new URLSearchParams({ c: c.id })}`,
        })),
    ];
  };
}
