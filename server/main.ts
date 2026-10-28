import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { createAssistant } from "./assistant.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";
import { sealer } from "./seal.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.ASSISTANT_DB ?? "/data/assistant.db";
const retentionDays = Number(process.env.ASSISTANT_RETENTION_DAYS ?? 30);
const modelTimeoutSeconds = Number(process.env.ASSISTANT_MODEL_TIMEOUT_SECONDS ?? 120);
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.ASSISTANT_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.ASSISTANT_METRICS_PORT ? Number(process.env.ASSISTANT_METRICS_PORT) : undefined;

if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 400)
  throw new Error("ASSISTANT_RETENTION_DAYS must be a whole number of days, 1 to 400");
if (!Number.isFinite(modelTimeoutSeconds) || modelTimeoutSeconds < 5 || modelTimeoutSeconds > 600)
  throw new Error("ASSISTANT_MODEL_TIMEOUT_SECONDS must be a number of seconds, 5 to 600");

const db = openDb(dbPath);
// The address people open Assistant at, behind the TLS proxy (ADR 0026). Cookies, passkeys and OIDC redirects use it.
const publicUrl = (process.env.ASSISTANT_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.ASSISTANT_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const secretsKey = readSecretsKey(secretsKeyFile);
const auth = createAuth({
  db,
  product: "assistant",
  productName: "OpenAsy Assistant",
  origin: publicUrl,
  // Locally the same Assistant is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.ASSISTANT_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "ASSISTANT_"),
  secretsKey,
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });

const assistant = createAssistant(db, { sealer: sealer(secretsKey), products: products.products, retentionDays, modelTimeoutMs: modelTimeoutSeconds * 1000 });
const server = createServer(
  createApp({
    db,
    assistant,
    version,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
// Answers from a local model can take minutes; the default request timeout of five minutes stays.
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(assistant, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

const model = assistant.model();
server.listen(port, () =>
  log("info", "assistant started", {
    version,
    port,
    db: dbPath,
    headless,
    retentionDays,
    model: model.configured ? `${model.model} at ${model.destination.host}` : "none",
  }),
);
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "ASSISTANT_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put Assistant behind TLS (ADR 0026)", {
    url: publicUrl,
  });
}
if (!secretsKey)
  log(
    "warn",
    "no secrets key: nobody can connect a product and no model API key can be kept, since Assistant keeps none unsealed. Mount a 32-byte key (openssl rand -hex 32)",
    {
      file: secretsKeyFile,
    },
  );
// Nothing leaves the install until an admin chooses a model (ADR 0015).
if (!model.configured) log("info", "no language model is set up: questions are refused and nothing is sent anywhere until an admin sets one under Model");
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

assistant.purge();
const timers: NodeJS.Timeout[] = [setInterval(() => auth.purge(), 5 * 60_000), setInterval(() => assistant.purge(), 3_600_000)];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
