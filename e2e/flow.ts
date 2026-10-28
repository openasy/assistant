// The steps of e2e/run.sh that use the API: the owner signs in with a second factor, as in a browser, sets the stub
// model and the stub products, connects their own tokens and asks one question, which must come back with citations.
import { createHmac } from "node:crypto";

const [setupLink, stubs] = process.argv.slice(2) as [string, string];
const base = new URL(setupLink).origin;
let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

const cookies = new Map<string, string>();
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      origin: base,
      "user-agent": "Mozilla/5.0 (X11; Linux) Firefox/140.0",
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    cookies.set(pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1));
  }
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, body: (type.includes("json") ? await res.json() : await res.text()) as any };
}

const totp = (secret: string) => {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "")) bits += a.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac("sha1", key).update(msg).digest();
  return String((h.readUInt32BE(h[19]! & 15) & 0x7fffffff) % 1e6).padStart(6, "0");
};

const token = new URL(setupLink).searchParams.get("setup");
check(
  (await call("POST", "/api/v1/auth/setup", { token, name: "Olivia", email: "owner@example.com", password: "correct horse battery staple" })).status === 200,
  "the owner is created",
);
const { secret } = (await call("POST", "/api/v1/auth/me/totp", {})).body as { secret: string };
check((await call("POST", "/api/v1/auth/me/totp/confirm", { code: totp(secret) })).status === 200, "the owner adds a second factor");

check((await call("POST", "/api/v1/conversations", { question: "Anything?" })).status === 409, "with no model, a question is refused");
const model = await call("PUT", "/api/v1/model", { provider: "openai", baseUrl: `http://${stubs}:11434/v1`, model: "stub" });
check(model.status === 200 && model.body.destination.network === "private", `the model is set, in the private network (${model.body.destination?.host})`);
const checked = await call("POST", "/api/v1/model/check");
check(checked.body.ok === true, "the model answers a check");
for (const id of ["logs", "siem"]) {
  const r = await call("PUT", `/api/v1/sources/${id}`, { allowed: true, apiUrl: `http://${stubs}:8080/${id}`, webUrl: `https://${id}.example.com` });
  check(r.status === 200, `${id} is allowed`);
  const c = await call("PUT", `/api/v1/sources/${id}/connection`, { token: `oa_${id}_e2eviewer000000000000` });
  check(c.status === 200 && c.body.connection !== null, `the owner connects their own ${id} token`);
}

const asked = await call("POST", "/api/v1/conversations", { question: "Did anything unusual happen on web-2 yesterday?" });
const answer = asked.body.messages?.[1];
check(asked.status === 201 && answer?.status === "answered", "the question is answered");
console.log(`\n${answer?.text}\n`);
for (const s of answer?.sources ?? []) console.log(`  [${s.n}] ${s.tool} ${s.status} ${s.title} · ${s.detail}\n      ${s.href}`);
check(answer?.grounded === true && JSON.stringify(answer?.cited) === "[1,2]", "the answer cites both calls");
check(
  answer?.sources?.[0]?.href?.startsWith("https://logs.example.com/explorer?q=host%3Aweb-2&range=24h"),
  "the Logs citation links to the Explorer with the query",
);
check(answer?.sources?.[1]?.href === "https://siem.example.com/signals?host=web-2", "the SIEM citation links to the signals of web-2");

const metrics = await (await fetch(`${base}/metrics`)).text();
check(metrics.includes('openasy_assistant_questions_total{outcome="answered"} 1'), "/metrics counts the answered question");
process.exit(failed ? 1 : 0);
