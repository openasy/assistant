import {
  AppShell,
  Avatar,
  Badge,
  BrandProvider,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  IconButton,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  PRODUCTS,
  SearchInput,
  SelectField,
  StatusBadge,
  Switch,
  TextField,
  toLocale,
  useLocalePreference,
  usePath,
  useThemePreference,
  type Column,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  Bot,
  Database,
  ExternalLink,
  History,
  KeyRound,
  Link2,
  LogIn,
  LogOut,
  MessageSquareText,
  Plus,
  Send,
  Sparkles,
  Trash2,
  Unlink,
  UserRound,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { blocks, type Segment } from "./answer.ts";
import {
  api,
  MfaSetupRequired,
  Unauthorized,
  type Call as ToolCall,
  type CallStatus,
  type Conversation,
  type ConversationSummary,
  type Message,
  type Model,
  type ModelCheck,
  type ProductLink,
  type Provider,
  type Settings,
  type Source,
} from "./api.ts";
import { useT } from "./i18n.ts";
import { search } from "./search.ts";

const PAGES = ["history", "sources", "model", "account", "members", "signin", "tokens"] as const;
type Page = "ask" | (typeof PAGES)[number];
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["ask", ...PAGES];
function parsePage(path: string): Page {
  const page = path.replace(/^\//, "").split("/")[0] ?? "";
  return (PAGES as readonly string[]).includes(page) ? (page as Page) : "ask";
}

/** A query parameter of the address. */
const param = (name: string) => new URLSearchParams(window.location.search).get(name);

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
type Call = ReturnType<typeof useApi>;

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const productOf = (id: string | null) => (id && (PRODUCT_IDS as readonly string[]).includes(id) ? PRODUCTS[id as ProductId] : PRODUCTS.assistant);

function ErrorText({ message }: { message?: string }) {
  return message ? <p className="assistant-error">{message}</p> : null;
}

const STATUS_TONE: Record<CallStatus, "success" | "neutral" | "warning" | "danger"> = {
  ok: "success",
  empty: "neutral",
  "not-connected": "warning",
  invalid: "warning",
  error: "danger",
};

// ---------------------------------------------------------------- Ask

/** A citation: the product and the call's number, linking to the page where the data is. */
function Cite({ call, n }: { call: ToolCall | undefined; n: number }) {
  const t = useT();
  // A number with no call behind it is not a citation; it stays as it was written.
  if (!call) return <span>[{n}]</span>;
  const P = productOf(call.source);
  const body = (
    <>
      <P.icon aria-hidden className="size-3" />
      {P.name} <span className="assistant-cite-n">{call.n}</span>
    </>
  );
  const label = t("ask.citeLabel", { product: P.name, n: call.n, title: call.title });
  return call.href ? (
    <a className="assistant-cite" href={call.href} target="_blank" rel="noreferrer" aria-label={label} title={call.detail}>
      {body}
    </a>
  ) : (
    <span className="assistant-cite" aria-label={label}>
      {body}
    </span>
  );
}

function Segments({ items, calls }: { items: Segment[]; calls: ToolCall[] }) {
  return (
    <>
      {items.map((s, i) =>
        s.kind === "text" ? (
          <span key={i}>{s.text}</span>
        ) : s.kind === "code" ? (
          <code key={i} className="assistant-code">
            {s.text}
          </code>
        ) : (
          <Cite key={i} n={s.n} call={calls.find((c) => c.n === s.n)} />
        ),
      )}
    </>
  );
}

function AnswerBody({ m }: { m: Message }) {
  const t = useT();
  const calls = m.sources ?? [];
  if (m.status === "failed")
    return (
      <Callout tone="danger" title={t("ask.failed")}>
        {m.error}
      </Callout>
    );
  return (
    <div className="assistant-answer">
      {!m.grounded && (
        <Callout tone="warning" title={t("ask.noData")}>
          {t("ask.noDataDetail")}
        </Callout>
      )}
      {blocks(m.text).map((b, i) => (
        <div key={i} className="assistant-block" data-uncited={b.cites.length === 0 || undefined}>
          {b.kind === "list" ? (
            <ul className="assistant-list">
              {b.items.map((item, j) => (
                <li key={j}>
                  <Segments items={item} calls={calls} />
                </li>
              ))}
            </ul>
          ) : (
            <p>
              <Segments items={b.items[0]!} calls={calls} />
            </p>
          )}
          {b.cites.length === 0 && m.grounded && (
            <span className="assistant-uncited" title={t("ask.uncitedDetail")}>
              {t("ask.uncited")}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function MessageRow({ m, me, active, onSelect }: { m: Message; me: string; active: boolean; onSelect: () => void }) {
  const t = useT();
  const user = m.role === "user";
  return (
    <li className="assistant-message" data-active={active || undefined}>
      {user ? (
        <Avatar name={me} size="sm" />
      ) : (
        <span aria-hidden className="assistant-avatar">
          <Sparkles className="size-3.5" />
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-semibold text-fg">{user ? me : t("ask.assistant")}</span>
        {user ? <p className="assistant-question">{m.text}</p> : <AnswerBody m={m} />}
        {!user && (
          <span className="flex flex-wrap items-center gap-2 text-2xs text-fg-muted">
            {t("ask.footer", { count: m.sources?.length ?? 0, time: seconds(m.ms ?? 0), model: m.model ?? "" })}
            <Button size="xs" variant="ghost" onClick={onSelect} aria-pressed={active}>
              {t("ask.showSources")}
            </Button>
          </span>
        )}
      </div>
    </li>
  );
}

/** Every call an answer made: what it read, how much, and the link to see it. */
function SourcesPanel({ m }: { m: Message | undefined }) {
  const t = useT();
  const calls = m?.sources ?? [];
  return (
    <Panel title={t("ask.sources")} description={m ? t("ask.sourcesDetail", { count: calls.length, cited: m.cited?.length ?? 0 }) : t("ask.sourcesNone")} flush>
      {calls.length ? (
        <ol aria-label={t("ask.sourcesRead")} className="assistant-list-plain">
          {calls.map((c) => {
            const P = productOf(c.source);
            const inner = (
              <>
                <span className="assistant-n">{c.n}</span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-2xs font-medium tracking-wider text-fg-muted uppercase">
                    <P.icon aria-hidden className="size-3" />
                    {P.name}
                    <Badge tone={STATUS_TONE[c.status]}>{t(`callStatus.${c.status}`)}</Badge>
                    {m?.cited?.includes(c.n) && <Badge tone="info">{t("ask.cited")}</Badge>}
                  </span>
                  <span className="assistant-wrap text-sm">{c.title}</span>
                  {c.detail && <span className="text-2xs text-fg-muted">{c.detail}</span>}
                  {c.error && <span className="text-2xs text-fg-muted">{c.error}</span>}
                  {c.href && (
                    <span className="flex items-center gap-1 text-2xs text-fg-muted">
                      <ExternalLink aria-hidden className="size-3" />
                      {t("ask.openIn", { product: P.name })}
                    </span>
                  )}
                </span>
              </>
            );
            return (
              <li key={c.n} className="assistant-source">
                {c.href ? (
                  <a href={c.href} target="_blank" rel="noreferrer" className="assistant-source-row">
                    {inner}
                  </a>
                ) : (
                  <div className="assistant-source-row">{inner}</div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="assistant-empty">{m ? t("ask.noCalls") : t("ask.sourcesNoneDetail")}</p>
      )}
    </Panel>
  );
}

function AskPage({ call, model, sources }: { call: Call; model?: Model; sources?: Source[] }) {
  const t = useT();
  const { me, can } = useAuth();
  const [id, setId] = useState(param("c"));
  const [conversation, setConversation] = useState<Conversation>();
  const [draft, setDraft] = useState(param("q") ?? "");
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<number>();
  const inputId = useId();

  useEffect(() => {
    if (!id) return setConversation(undefined);
    void call<Conversation>(`/api/v1/conversations/${encodeURIComponent(id)}`).then(setConversation, (err: Error) => setError(err.message));
  }, [call, id]);

  const answers = conversation?.messages.map((m, i) => ({ m, i })).filter((x) => x.m.role === "assistant") ?? [];
  const shown = conversation?.messages[selected ?? answers.at(-1)?.i ?? -1];
  const allowed = sources?.filter((s) => s.allowed) ?? [];
  const connected = allowed.filter((s) => s.connection);
  const ready = model?.configured && allowed.length > 0;

  const ask = async (e?: FormEvent) => {
    e?.preventDefault();
    const question = draft.trim();
    if (!question || pending) return;
    setPending(question);
    setDraft("");
    setError(undefined);
    try {
      const c = await call<Conversation>(conversation ? `/api/v1/conversations/${conversation.id}/messages` : "/api/v1/conversations", {
        method: "POST",
        body: JSON.stringify({ question }),
      });
      setConversation(c);
      setSelected(undefined);
      if (c.id !== id) {
        window.history.replaceState(null, "", `/ask?c=${c.id}`);
        setId(c.id);
      }
    } catch (err) {
      setError((err as Error).message);
      setDraft(question);
    } finally {
      setPending(undefined);
    }
  };
  const fresh = () => {
    window.history.replaceState(null, "", "/ask");
    setId(null);
    setConversation(undefined);
    setSelected(undefined);
    setError(undefined);
  };

  return (
    <>
      <PageHeader
        title={t("ask.title")}
        description={t("ask.description")}
        meta={<Badge>{t("ask.readOnly")}</Badge>}
        actions={
          <Button icon={<Plus />} onClick={fresh} disabled={!conversation}>
            {t("ask.new")}
          </Button>
        }
      />
      {model && !model.configured && (
        <Callout
          tone="info"
          title={t("ask.noModel")}
          action={
            can("admin") && (
              <Button size="sm" onClick={() => navigate("/model")}>
                {t("ask.setModel")}
              </Button>
            )
          }
        >
          {t("ask.noModelDetail")}
        </Callout>
      )}
      {model?.configured && sources && allowed.length === 0 && (
        <Callout
          tone="info"
          title={t("ask.noSources")}
          action={
            can("admin") && (
              <Button size="sm" onClick={() => navigate("/sources")}>
                {t("ask.allowSources")}
              </Button>
            )
          }
        >
          {t("ask.noSourcesDetail")}
        </Callout>
      )}
      {ready && connected.length === 0 && (
        <Callout
          tone="warning"
          title={t("ask.noConnections")}
          action={
            <Button size="sm" onClick={() => navigate("/sources")}>
              {t("ask.connect")}
            </Button>
          }
        >
          {t("ask.noConnectionsDetail")}
        </Callout>
      )}
      <div className="assistant-ask">
        <Panel
          title={conversation?.title ?? t("ask.conversation")}
          description={
            conversation
              ? t("ask.started", { when: when(conversation.createdAt) })
              : model?.configured
                ? t("ask.sentTo", { host: model.destination.host })
                : undefined
          }
        >
          {conversation || pending ? (
            <ol aria-label={t("ask.conversation")} className="assistant-thread">
              {conversation?.messages.map((m, i) => (
                <MessageRow key={i} m={m} me={me.user.name} active={m.role === "assistant" && shown === m} onSelect={() => setSelected(i)} />
              ))}
              {pending && (
                <>
                  <MessageRow
                    m={{ role: "user", text: pending, status: "question", error: null, createdAt: "" }}
                    me={me.user.name}
                    active={false}
                    onSelect={() => {}}
                  />
                  <li className="assistant-message">
                    <span aria-hidden className="assistant-avatar">
                      <Sparkles className="size-3.5" />
                    </span>
                    <p className="text-sm text-fg-muted" role="status">
                      {t("ask.reading", { products: connected.map((s) => s.name).join(", ") || t("ask.theProducts") })}
                    </p>
                  </li>
                </>
              )}
            </ol>
          ) : (
            <EmptyState icon={<MessageSquareText />} title={t("ask.emptyTitle")}>
              {t("ask.emptyDetail")}
            </EmptyState>
          )}
          <ErrorText message={error} />
          <form onSubmit={(e) => void ask(e)} className="assistant-composer">
            <label htmlFor={inputId} className="text-xs font-medium text-fg">
              {conversation ? t("ask.followUp") : t("ask.question")}
            </label>
            <textarea
              id={inputId}
              rows={2}
              maxLength={4000}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void ask();
                }
              }}
              placeholder={t("ask.placeholder")}
              className="assistant-textarea"
              disabled={!ready}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs text-fg-muted">{t("ask.keys")}</span>
              <Button type="submit" size="sm" variant="primary" icon={<Send />} disabled={!draft.trim() || !ready} loading={Boolean(pending)}>
                {t("ask.send")}
              </Button>
            </div>
          </form>
        </Panel>
        <SourcesPanel m={shown?.role === "assistant" ? shown : undefined} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- History

function HistoryPage({ call }: { call: Call }) {
  const t = useT();
  const [data, setData] = useState<{ retentionDays: number; conversations: ConversationSummary[] }>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const load = useCallback(() => void call<typeof data>("/api/v1/conversations").then(setData, (err: Error) => setError(err.message)), [call]);
  useEffect(load, [load]);
  const remove = async (c: ConversationSummary) => {
    await call(`/api/v1/conversations/${c.id}`, { method: "DELETE" }).catch((err: Error) => setError(err.message));
    load();
  };
  const rows = (data?.conversations ?? []).filter((c) => !query || c.title.toLowerCase().includes(query.toLowerCase()));
  const columns: Column<ConversationSummary>[] = [
    { id: "title", header: t("history.conversation"), width: "50%", cell: (c) => <span className="block truncate font-medium">{c.title}</span> },
    { id: "questions", header: t("history.questions"), align: "right", mono: true, sortValue: (c) => c.questions, cell: (c) => c.questions },
    {
      id: "sources",
      header: t("history.readFrom"),
      cell: (c) =>
        c.sources.length ? (
          <span className="flex flex-wrap gap-1">
            {c.sources.map((s) => (
              <Badge key={s}>{productOf(s).name}</Badge>
            ))}
          </span>
        ) : (
          <span className="text-fg-subtle">–</span>
        ),
    },
    { id: "updated", header: t("history.updated"), sortValue: (c) => c.updatedAt, cell: (c) => <span className="text-xs">{when(c.updatedAt)}</span> },
    {
      id: "delete",
      header: <span className="sr-only">{t("history.delete")}</span>,
      width: "48px",
      cell: (c) => (
        <IconButton
          label={t("history.deleteOne", { title: c.title })}
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            void remove(c);
          }}
        >
          <Trash2 />
        </IconButton>
      ),
    },
  ];
  return (
    <>
      <PageHeader title={t("history.title")} description={data ? t("history.description", { days: data.retentionDays }) : undefined} />
      <ErrorText message={error} />
      <div className="assistant-filter">
        <SearchInput label={t("history.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <Panel title={t("history.conversations")} description={t("history.shown", { count: rows.length })} flush>
        <DataTable
          label={t("history.conversations")}
          columns={columns}
          rows={rows}
          getRowId={(c) => c.id}
          onRowClick={(c) => navigate(`/ask?c=${c.id}`)}
          minWidth={720}
          empty={<p className="py-8">{data ? t("history.none") : t("product.loading")}</p>}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Sources

function ConnectDialog({ call, source, onClose, onSaved }: { call: Call; source?: Source; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => (setToken(""), setError(undefined)), [source]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!source) return;
    setSaving(true);
    setError(undefined);
    try {
      await call(`/api/v1/sources/${source.id}/connection`, { method: "PUT", body: JSON.stringify({ token: token.trim() }) });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={source !== undefined}
      onOpenChange={(open) => !open && onClose()}
      title={t("sources.connectTitle", { product: source?.name ?? "" })}
      description={t("sources.connectDetail", { product: source?.name ?? "" })}
      onSubmit={(e) => void save(e)}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!token.trim()}>
            {t("sources.connect")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <ol className="assistant-steps">
          <li>{t("sources.step1", { product: source?.name ?? "", url: source?.webUrl ?? "" })}</li>
          <li>{t("sources.step2")}</li>
          <li>{t("sources.step3")}</li>
        </ol>
        <TextField
          label={t("sources.token")}
          type="password"
          mono
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          hint={t("sources.tokenHint")}
        />
        <ErrorText message={error} />
      </div>
    </Dialog>
  );
}

function SourceDialog({ call, source, onClose, onSaved }: { call: Call; source?: Source; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [allowed, setAllowed] = useState(false);
  const [apiUrl, setApiUrl] = useState("");
  const [webUrl, setWebUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setAllowed(source?.allowed ?? false);
    setApiUrl(source?.apiUrl ?? "");
    setWebUrl(source?.webUrl ?? "");
    setError(undefined);
  }, [source]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!source) return;
    setSaving(true);
    setError(undefined);
    try {
      await call(`/api/v1/sources/${source.id}`, {
        method: "PUT",
        body: JSON.stringify({ allowed, apiUrl: apiUrl.trim() || null, webUrl: webUrl.trim() || null }),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const moved = source?.apiUrl && apiUrl.trim().replace(/\/+$/, "") !== source.apiUrl;
  return (
    <Dialog
      open={source !== undefined}
      onOpenChange={(open) => !open && onClose()}
      title={t("sources.editTitle", { product: source?.name ?? "" })}
      description={t("sources.editDetail")}
      onSubmit={(e) => void save(e)}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={saving}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <Switch
          checked={allowed}
          onCheckedChange={setAllowed}
          label={t("sources.allow", { product: source?.name ?? "" })}
          description={t("sources.allowDetail")}
        />
        <TextField
          label={t("sources.apiUrl")}
          mono
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder="http://logs:8080"
          hint={t("sources.apiUrlHint")}
        />
        <TextField
          label={t("sources.webUrl")}
          mono
          value={webUrl}
          onChange={(e) => setWebUrl(e.target.value)}
          placeholder="https://logs.example.com"
          hint={t("sources.webUrlHint")}
        />
        {moved && (
          <Callout tone="warning" title={t("sources.movedTitle")}>
            {t("sources.moved")}
          </Callout>
        )}
        <ErrorText message={error} />
      </div>
    </Dialog>
  );
}

function SourcesPage({ call, sources, model, reload }: { call: Call; sources?: Source[]; model?: Model; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [connecting, setConnecting] = useState<Source>();
  const [editing, setEditing] = useState<Source>();
  const [error, setError] = useState<string>();
  const list = sources ?? [];
  const allowed = list.filter((s) => s.allowed);
  const disconnect = async (s: Source) => {
    await call(`/api/v1/sources/${s.id}/connection`, { method: "DELETE" }).catch((err: Error) => setError(err.message));
    reload();
  };
  const columns: Column<Source>[] = [
    {
      id: "product",
      header: t("sources.product"),
      width: "18%",
      sortValue: (s) => s.name,
      cell: (s) => {
        const P = productOf(s.id);
        return (
          <span className="flex items-center gap-1.5">
            <P.icon aria-hidden className="size-3.5 text-fg-muted" />
            <span className="font-medium">{s.name}</span>
          </span>
        );
      },
    },
    { id: "reads", header: t("sources.reads"), width: "30%", cell: (s) => <span className="text-xs">{t(`reads.${s.id}`)}</span> },
    {
      id: "allowed",
      header: t("sources.allowed"),
      cell: (s) =>
        s.allowed ? <StatusBadge tone="success">{t("sources.isAllowed")}</StatusBadge> : <StatusBadge tone="neutral">{t("sources.notAllowed")}</StatusBadge>,
    },
    {
      id: "yours",
      header: t("sources.yourToken"),
      cell: (s) =>
        s.connection ? (
          <span className="flex flex-col">
            <StatusBadge tone="success" className="self-start">
              {t("sources.connected")}
            </StatusBadge>
            <span className="text-2xs text-fg-muted">
              {s.connection.lastUsedAt
                ? t("sources.lastUsed", { when: when(s.connection.lastUsedAt) })
                : t("sources.since", { when: when(s.connection.connectedAt) })}
            </span>
          </span>
        ) : (
          <span className="text-xs text-fg-muted">{s.allowed ? t("sources.notConnected") : "–"}</span>
        ),
    },
    {
      id: "actions",
      header: <span className="sr-only">{t("sources.actions")}</span>,
      cell: (s) => (
        <span className="flex flex-wrap justify-end gap-1">
          {s.allowed &&
            (s.connection ? (
              <Button size="xs" icon={<Unlink />} onClick={() => void disconnect(s)}>
                {t("sources.disconnect")}
              </Button>
            ) : (
              <Button size="xs" variant="primary" icon={<Link2 />} onClick={() => setConnecting(s)}>
                {t("sources.connect")}
              </Button>
            ))}
          {can("admin") && (
            <Button size="xs" variant="ghost" onClick={() => setEditing(s)}>
              {t("sources.edit")}
            </Button>
          )}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader title={t("sources.title")} description={t("sources.description")} />
      <KpiGrid>
        <KpiCard label={t("sources.kpiAllowed")} value={String(allowed.length)} unit={t("sources.kpiOf", { count: list.length })} />
        <KpiCard
          label={t("sources.kpiConnected")}
          value={String(allowed.filter((s) => s.connection).length)}
          unit={t("sources.kpiOf", { count: allowed.length })}
        />
        <KpiCard
          label={t("sources.kpiWrites")}
          value="0"
          unit={t("sources.kpiNever")}
          tone="success"
          delta={{ label: t("sources.kpiReadOnly"), intent: "good" }}
        />
        <KpiCard
          label={t("sources.kpiSentTo")}
          value={model?.configured ? model.destination.host : t("sources.kpiNowhere")}
          tone={model?.configured && model.destination.network === "internet" ? "warning" : "success"}
          delta={{ label: model?.configured ? t(`network.${model.destination.network}`) : t("sources.kpiNoModel") }}
        />
      </KpiGrid>
      <Callout tone="info" title={t("sources.asYouTitle")}>
        {t("sources.asYou")}
      </Callout>
      <ErrorText message={error} />
      <Panel title={t("sources.products")} flush>
        <DataTable label={t("sources.products")} columns={columns} rows={list} getRowId={(s) => s.id} minWidth={860} />
      </Panel>
      <ConnectDialog call={call} source={connecting} onClose={() => setConnecting(undefined)} onSaved={reload} />
      <SourceDialog call={call} source={editing} onClose={() => setEditing(undefined)} onSaved={reload} />
    </>
  );
}

// ---------------------------------------------------------------- Model

const PLACEHOLDER: Record<Provider, string> = { openai: "http://ollama:11434/v1", anthropic: "https://api.anthropic.com" };

function ModelForm({ call, model, onSaved }: { call: Call; model: Model; onSaved: () => void }) {
  const t = useT();
  const [provider, setProvider] = useState<Provider>(model.configured ? model.provider : "openai");
  const [baseUrl, setBaseUrl] = useState(model.configured ? model.baseUrl : "");
  const [name, setName] = useState(model.configured ? model.model : "");
  const [apiKey, setApiKey] = useState("");
  const [maxTokens, setMaxTokens] = useState(String(model.configured ? model.maxTokens : 2048));
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<ModelCheck>();
  const [error, setError] = useState<string>();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await call("/api/v1/model", {
        method: "PUT",
        body: JSON.stringify({ provider, baseUrl: baseUrl.trim(), model: name.trim(), maxTokens: Number(maxTokens), ...(apiKey && { apiKey }) }),
      });
      setApiKey("");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const runCheck = async () => {
    setChecking(true);
    setCheck(undefined);
    try {
      setCheck(await call<ModelCheck>("/api/v1/model/check", { method: "POST" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const remove = async () => {
    await call("/api/v1/model", { method: "DELETE" }).catch((err: Error) => setError(err.message));
    onSaved();
  };
  const keyKept = model.configured && model.hasKey && model.baseUrl === baseUrl.trim().replace(/\/+$/, "") && model.provider === provider;
  return (
    <Panel title={t("model.form")} description={t("model.formDetail")}>
      <form className="flex flex-col gap-2.5" onSubmit={(e) => void save(e)}>
        <SelectField
          label={t("model.provider")}
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
          options={[
            { value: "openai", label: t("model.openai") },
            { value: "anthropic", label: t("model.anthropic") },
          ]}
        />
        <TextField
          label={t("model.baseUrl")}
          mono
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={PLACEHOLDER[provider]}
          hint={t(`model.baseUrlHint.${provider}`)}
        />
        <TextField
          label={t("model.model")}
          mono
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={provider === "openai" ? "llama3.1:8b" : ""}
        />
        <TextField
          label={t("model.apiKey")}
          type="password"
          mono
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          hint={keyKept ? t("model.apiKeyKept") : t("model.apiKeyHint")}
        />
        <TextField label={t("model.maxTokens")} type="number" min={256} max={32000} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
        <ErrorText message={error} />
        {check && (
          <Callout tone={check.ok ? "success" : "danger"} title={check.ok ? t("model.checkOk", { time: seconds(check.ms) }) : t("model.checkFailed")}>
            {check.ok ? t("model.checkReply", { reply: check.reply ?? "" }) : check.error}
          </Callout>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={saving} disabled={!baseUrl.trim() || !name.trim()}>
            {t("common.save")}
          </Button>
          {model.configured && (
            <>
              <Button onClick={() => void runCheck()} loading={checking}>
                {t("model.check")}
              </Button>
              <Button variant="danger" onClick={() => void remove()}>
                {t("model.remove")}
              </Button>
            </>
          )}
        </div>
      </form>
    </Panel>
  );
}

function RetentionPanel({ call }: { call: Call }) {
  const t = useT();
  const { can } = useAuth();
  const [days, setDays] = useState("");
  const [saved, setSaved] = useState<number>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void call<Settings>("/api/v1/settings").then(
      (s) => (setDays(String(s.retentionDays)), setSaved(s.retentionDays)),
      () => {},
    );
  }, [call]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      const s = await call<Settings>("/api/v1/settings", { method: "PUT", body: JSON.stringify({ retentionDays: Number(days) }) });
      setSaved(s.retentionDays);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Panel title={t("model.retention")} description={saved !== undefined ? t("model.retentionDetail", { days: saved }) : undefined}>
      {can("admin") ? (
        <form className="flex flex-col gap-2.5" onSubmit={(e) => void save(e)}>
          <TextField
            label={t("model.retentionDays")}
            type="number"
            min={1}
            max={400}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            hint={t("model.retentionHint")}
          />
          <ErrorText message={error} />
          <Button type="submit" className="self-start" disabled={Number(days) === saved}>
            {t("common.save")}
          </Button>
        </form>
      ) : (
        <p className="text-sm">{t("model.retentionViewer")}</p>
      )}
    </Panel>
  );
}

function ModelPage({ call, model, reload }: { call: Call; model?: Model; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  if (!model) return <EmptyState title={t("product.loading")} />;
  return (
    <>
      <PageHeader title={t("model.title")} description={t("model.description")} />
      {model.configured ? (
        <Callout tone={model.destination.network === "internet" ? "warning" : "info"} title={t("model.sentTo", { host: model.destination.host })}>
          {t("model.sentToDetail", { url: model.baseUrl })} {t(`model.network.${model.destination.network}`)}
        </Callout>
      ) : (
        <Callout tone="success" title={t("model.nowhere")}>
          {t("model.nowhereDetail")}
        </Callout>
      )}
      <div className="assistant-cols">
        <Panel title={t("model.current")}>
          {model.configured ? (
            <dl className="assistant-facts">
              <dt>{t("model.provider")}</dt>
              <dd>{t(`model.${model.provider}`)}</dd>
              <dt>{t("model.baseUrl")}</dt>
              <dd className="font-mono text-xs">{model.baseUrl}</dd>
              <dt>{t("model.model")}</dt>
              <dd className="font-mono text-xs">{model.model}</dd>
              <dt>{t("model.where")}</dt>
              <dd>
                <Badge tone={model.destination.network === "internet" ? "warning" : "success"}>{t(`network.${model.destination.network}`)}</Badge>
              </dd>
              <dt>{t("model.apiKey")}</dt>
              <dd>{model.hasKey ? t("model.keyKept") : t("model.noKey")}</dd>
              <dt>{t("model.changed")}</dt>
              <dd>{t("model.changedBy", { by: model.updatedBy, when: when(model.updatedAt) })}</dd>
            </dl>
          ) : (
            <p className="text-sm text-fg-muted">{t("model.none")}</p>
          )}
        </Panel>
        <Panel title={t("model.what")}>
          <ul className="assistant-list">
            <li>{t("model.what1")}</li>
            <li>{t("model.what2")}</li>
            <li>{t("model.what3")}</li>
            <li>{t("model.what4")}</li>
          </ul>
        </Panel>
      </div>
      {can("admin") && <ModelForm key={model.configured ? model.updatedAt : "none"} call={call} model={model} onSaved={reload} />}
      <RetentionPanel call={call} />
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`settingsPage.${page}.title`)}
        description={t(`settingsPage.${page}.description`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settingsPage.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const page = parsePage(usePath());
  const [model, setModel] = useState<Model>();
  const [sources, setSources] = useState<Source[]>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();
  const onSearch = useMemo(() => search(call, msg), [call, msg]);

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "assistant" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Model>("/api/v1/model").then(setModel, () => {});
    void call<{ sources: Source[] }>("/api/v1/sources").then(
      (r) => setSources(r.sources),
      () => setSources([]),
    );
  }, [call]);
  useEffect(reload, [reload]);

  const missing = sources?.filter((s) => s.allowed && !s.connection).length;
  const nav = [
    { id: "ask", label: msg("product.ask"), icon: MessageSquareText },
    { id: "history", label: msg("product.history"), icon: History },
    { id: "sources", label: msg("product.sources"), icon: Database, count: missing || undefined },
    { id: "model", label: msg("product.model"), icon: Bot },
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: msg("product.members"), icon: Users },
          { id: "signin", label: msg("product.signIn"), icon: LogIn },
          { id: "tokens", label: msg("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("product.account"), icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const settings = page === "account" || page === "members" || page === "signin" || page === "tokens";

  let content: ReactNode;
  if (settings) content = <SettingsPage page={page as "account" | "members" | "signin" | "tokens"} />;
  else if (page === "history") content = <HistoryPage call={call} />;
  else if (page === "sources") content = <SourcesPage call={call} sources={sources} model={model} reload={reload} />;
  else if (page === "model") content = <ModelPage call={call} model={model} reload={reload} />;
  else content = <AskPage key={window.location.search} call={call} model={model} sources={sources} />;

  return (
    <AppShell
      product="assistant"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={page}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      setup
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {content}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Assistant">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
