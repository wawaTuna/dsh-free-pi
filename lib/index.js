/**
 * dsh-free-pi — DSH host plugin: registers the `free-pi` provider route on
 * `ctx.llm` via DSH's generic `PiAiAdapter`, following the same skeleton as
 * dsh-opencode-free (createProvider + PiAiAdapter + registerAdapter).
 *
 * free-pi's backend (https://api.freepi.ai/v1) is a plain OpenAI-compatible
 * endpoint gated by a GitHub-sign-in JWT plus `x-session-id` /
 * `x-client-version` headers. Those live in the shared core
 * (./free-pi-core.mjs, vendored from ../../../core): the JWT is re-read from
 * ~/.free-pi/agent/credentials.json on every request, so signing in again
 * (node core/login.mjs) takes effect without restarting DSH. The session id
 * is one stable id per install, persisted by the core.
 *
 * No local port is opened: the headers are static per install, so they ride
 * on the provider/model records directly — the lightest of the three routes
 * surveyed for this plugin (adapter > declarative patch > loopback proxy).
 *
 * The account panel (lib/client.js, a Settings section) is served by four
 * plugin-owned routes under /plugins/dsh-free-pi/*, registered on the
 * webServer service exactly like dsh-connect-workbuddy's status routes:
 * list accounts + quotas, start a GitHub device login, poll it to
 * completion (the new sign-in joins the core pool), and remove a pool
 * account. Every route is loopback-guarded (Host must be local or the
 * listener address; a present Origin must be loopback) because the web
 * server dispatches plugin routes without its own session check — the
 * paired browser reaches them through the local proxy, which rewrites
 * Host and drops Origin for plugin paths. Responses never carry JWTs.
 */
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import z from "@deepseek-ai/schemastery";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import {
  FALLBACK_MODELS,
  FREEPI_BASE_URL,
  FREEPI_CLIENT_VERSION,
  addAccount,
  describeAccounts,
  fetchCatalog,
  fetchMe,
  getSessionId,
  modelCaps,
  listQuotas,
  pickAccountCandidates,
  pollDeviceTokenOnce,
  refreshQuotaCache,
  removeAccount,
  startDeviceFlow,
  submitConsent,
} from "./free-pi-core.mjs";

export const name = "free-pi";
export const inject = ["llm"];

const PROVIDER_ID = "free-pi";
const BASE_URL = `${FREEPI_BASE_URL}/v1`;
const NOT_SIGNED_IN = "free-pi-not-signed-in";

export const Config = z.object({
  // Optional override. Normally empty: the JWT is read from
  // ~/.free-pi/agent/credentials.json (written by the free-pi login script)
  // or the FREEPI_JWT env var, fresh on every request.
  jwt: z.string().default(""),
  hiddenModels: z.array(z.string()).default([]).volatile(),
});

const PI_AI_AUTH_CONTEXT = Object.freeze({
  async env(name) {
    return process.env[name];
  },
  async fileExists(path) {
    const expanded = path === "~" || path.startsWith("~/")
      ? resolvePath(homedir(), path.slice(1).replace(/^\//, ""))
      : path;
    try {
      await access(expanded);
      return true;
    } catch {
      return false;
    }
  },
});

/** Satisfies the PiAiAdapter seam only; the JWT is re-read live, never stored here. */
class EphemeralCredentialStore {
  async read() {
    return undefined;
  }
  async list(options) {
    options?.signal?.throwIfAborted();
    return [];
  }
  async modify(_providerId, update, options) {
    options?.signal?.throwIfAborted();
    return update(undefined);
  }
  async delete(_providerId, options) {
    options?.signal?.throwIfAborted();
  }
}

// ---------------------------------------------------------------------------
// Account panel routes (/plugins/dsh-free-pi/*). Raw node req/res handlers,
// the webServer responder's shape. Every handler is loopback-guarded with
// the same semantics dsh-connect-workbuddy uses: the web server dispatches
// plugin routes without a session check of its own, so the plugin proves
// the caller is local — Host must be a local name or the listener's own
// address, and a present Origin must be loopback (an absent Origin is a
// non-browser caller and passes). Account responses are built from core
// summaries only; no JWT ever crosses these routes.
// ---------------------------------------------------------------------------

const ACCOUNTS_PATH = "/plugins/dsh-free-pi/accounts";
const LOGIN_START_PATH = "/plugins/dsh-free-pi/login/start";
const LOGIN_POLL_PATH = "/plugins/dsh-free-pi/login/poll";
const REMOVE_PATH = "/plugins/dsh-free-pi/accounts/remove";
const LOGIN_TTL_MS = 15 * 60 * 1000;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function isLocalHostname(hostname) {
  const name = String(hostname ?? "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1" || name.endsWith(".localhost");
}

function bareIp(value) {
  return String(value ?? "").replace(/^\[|\]$/g, "").toLowerCase();
}

function hostMatchesListener(req) {
  const host = req.headers?.host;
  if (!host || !String(host).trim()) return false;
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (isLocalHostname(hostname)) return true;
  const local = req.socket?.localAddress;
  if (!local) return false;
  return bareIp(hostname) === bareIp(local);
}

function originIsLoopback(req) {
  const origin = req.headers?.origin;
  if (!origin || !String(origin).trim()) return true;
  try {
    const { hostname } = new URL(origin);
    if (isLocalHostname(hostname)) return true;
    const local = req.socket?.localAddress;
    return Boolean(local) && bareIp(hostname) === bareIp(local);
  } catch {
    return false;
  }
}

function requireLoopback(req, res) {
  if (!hostMatchesListener(req)) {
    sendJson(res, 403, { error: "host-not-trusted" });
    return false;
  }
  if (!originIsLoopback(req)) {
    sendJson(res, 403, { error: "origin-not-trusted" });
    return false;
  }
  return true;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function registerAccountRoutes(ctx, config) {
  const explicit = () => config?.jwt;
  // One in-flight device login per plugin instance. Starting a new one
  // replaces the old; the abandoned upstream session just expires.
  let pendingLogin = null;

  const listHandler = async (req, res) => {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    if (!requireLoopback(req, res)) return;
    try {
      const infos = describeAccounts(explicit());
      const quotas = await listQuotas(explicit());
      const quotaById = new Map(quotas.map((q) => [q.id, q]));
      const accounts = infos.map((info) => {
        const quota = quotaById.get(info.id) ?? { ok: false, error: "quota unavailable" };
        return { ...info, ...quota, id: info.id, label: info.label };
      });
      sendJson(res, 200, { accounts });
    } catch (err) {
      sendJson(res, 500, { error: `account list failed: ${err?.message ?? err}` });
    }
  };

  const startHandler = async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    if (!requireLoopback(req, res)) return;
    try {
      const flow = await startDeviceFlow();
      if (!flow.sessionId || !flow.userCode) throw new Error("device flow response was incomplete");
      // Clicking "add account" in the panel, under the disclosure printed
      // there, is the consent the CLI asks for interactively; it must be
      // recorded before the token poll or the server refuses the token.
      await submitConsent(flow.sessionId);
      pendingLogin = { sessionId: flow.sessionId, expiresAt: Date.now() + LOGIN_TTL_MS };
      sendJson(res, 200, {
        userCode: flow.userCode,
        verificationUri: flow.verificationUri,
        intervalSeconds: Math.max(flow.interval || 5, 2),
        expiresAt: pendingLogin.expiresAt,
      });
    } catch (err) {
      sendJson(res, 502, { error: `login start failed: ${err?.message ?? err}` });
    }
  };

  const pollHandler = async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    if (!requireLoopback(req, res)) return;
    if (!pendingLogin) return sendJson(res, 200, { status: "none" });
    if (Date.now() > pendingLogin.expiresAt) {
      pendingLogin = null;
      return sendJson(res, 200, { status: "expired" });
    }
    try {
      const once = await pollDeviceTokenOnce(pendingLogin.sessionId);
      if (!once.token) return sendJson(res, 200, { status: "pending" });
      // The token stays in this closure: it goes into the pool via
      // addAccount and is never part of any response.
      const token = once.token;
      pendingLogin = null;
      const me = await fetchMe(token).catch(() => null);
      const entry = addAccount({ label: me?.handle || "account", jwt: token });
      sendJson(res, 200, {
        status: "added",
        account: { id: entry.id, label: entry.label, handle: me?.handle ?? null, tier: me?.tier ?? null },
      });
    } catch (err) {
      if (err?.code === "consent_required") {
        pendingLogin = null;
        return sendJson(res, 200, {
          status: "error",
          error: "consent was not recorded for this login — start again",
        });
      }
      sendJson(res, 502, { status: "error", error: `login poll failed: ${err?.message ?? err}` });
    }
  };

  const removeHandler = async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    if (!requireLoopback(req, res)) return;
    const body = await readJsonBody(req);
    const id = typeof body?.id === "string" ? body.id : "";
    const info = describeAccounts(explicit()).find((a) => a.id === id);
    if (!info) return sendJson(res, 404, { error: "unknown account" });
    if (!info.removable) {
      return sendJson(res, 400, {
        error: "not-removable",
        reason: info.source === "credentials"
          ? "This sign-in lives in ~/.free-pi/agent/credentials.json, the file free-pi-cli owns. Delete that file, or sign in again from the CLI, to change it."
          : "This sign-in comes from the plugin configuration or the environment, not from the account pool.",
      });
    }
    sendJson(res, 200, { removed: removeAccount(id), id });
  };

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: "exact", path: ACCOUNTS_PATH, handler: listHandler }),
      ctx.webServer.register({ kind: "exact", path: LOGIN_START_PATH, handler: startHandler }),
      ctx.webServer.register({ kind: "exact", path: LOGIN_POLL_PATH, handler: pollHandler }),
      ctx.webServer.register({ kind: "exact", path: REMOVE_PATH, handler: removeHandler }),
    ];
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // Already disposed with the server; nothing to undo.
        }
      }
    };
  });
}

export function apply(ctx, config) {
  const sessionId = getSessionId();
  const staticHeaders = Object.freeze({
    "x-session-id": sessionId,
    "x-client-version": FREEPI_CLIENT_VERSION,
  });
  // Multi-account rotation: every request takes the next healthy account
  // from the core pool (config JWT + accounts.json + credentials.json),
  // skipping tokens the server rejected and budgets that are spent. The
  // quota cache refreshes in the background, so picking never blocks a
  // request on a /me round-trip. A request already streaming stays on the
  // account it started with.
  const getJwt = () => {
    void refreshQuotaCache(config?.jwt).catch(() => {});
    return pickAccountCandidates(config?.jwt)[0]?.jwt;
  };

  // Capability fields come from the shared core caps table (the free-pi
  // catalogue carries none). reasoning: true is what makes pi offer its
  // thinking levels (off/low/medium/high), which the transport forwards
  // as reasoning_effort — verified honoured upstream.
  const toModel = (m) => {
    const caps = modelCaps(m.id);
    return {
      id: m.id,
      name: m.name,
      provider: PROVIDER_ID,
      baseUrl: BASE_URL,
      api: "openai-completions",
      headers: { ...staticHeaders },
      reasoning: caps.reasoning,
      input: caps.image ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: caps.context,
      maxTokens: caps.output,
    };
  };

  // The picker reads this live array; the catalogue refresh below swaps it
  // when the server-side list changes (models come and go upstream).
  let liveModels = FALLBACK_MODELS.map(toModel);
  const refreshCatalogue = async () => {
    const models = await fetchCatalog().catch(() => null);
    if (Array.isArray(models) && models.length) liveModels = models.map(toModel);
    return liveModels;
  };
  void refreshCatalogue();

  const rawHidden = config?.hiddenModels;
  const hiddenGet = typeof rawHidden === "object" && rawHidden !== null && "get" in rawHidden
    ? rawHidden.get
    : undefined;
  const isHidden = (id) => {
    const live = typeof hiddenGet === "function" ? hiddenGet() : rawHidden;
    const list = Array.isArray(live) ? live : [];
    return list.some((entry) => String(entry).trim() === id);
  };

  const provider = createProvider({
    id: PROVIDER_ID,
    name: "FreePi",
    baseUrl: BASE_URL,
    headers: { ...staticHeaders },
    auth: {
      apiKey: {
        name: "free-pi JWT (GitHub sign-in)",
        async resolve({ ctx: authCtx }) {
          void authCtx;
          return {
            auth: { apiKey: getJwt() ?? NOT_SIGNED_IN, headers: { ...staticHeaders } },
            source: "free-pi",
          };
        },
      },
    },
    models: liveModels,
    api: { "openai-completions": openAICompletionsApi() },
  });

  const filtered = {
    ...provider,
    getModels: () => liveModels.filter((m) => !isHidden(m.id)),
    async refreshModels(c) {
      if (c?.stored && Array.isArray(c.stored.models) && c.stored.models.length) {
        const ids = new Set(c.stored.models.map((m) => m.id));
        const restored = FALLBACK_MODELS.filter((m) => ids.has(m.id)).map(toModel);
        if (restored.length) liveModels = restored;
      }
      if (c && c.allowNetwork === false) return;
      const next = await refreshCatalogue();
      if (typeof c?.publish === "function") {
        try {
          await c.publish({
            persist: { models: next, checkedAt: Date.now() },
            update: () => {},
          });
        } catch {
          // Publishing is bookkeeping; the live list is already updated.
        }
      }
    },
  };

  const auth = Object.freeze({
    credentials: new EphemeralCredentialStore(),
    authContext: PI_AI_AUTH_CONTEXT,
  });
  const authModels = createModels(auth);
  authModels.setProvider(filtered);

  const profile = Object.freeze({
    provider: PROVIDER_ID,
    displayName: "FreePi",
    piProvider: filtered,
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
    streamIdleTimeoutMs: 600 * 1_000,
    timeoutMs: 180_000,
    retryPolicy: resolveRetryPolicy(undefined, "free-pi retryPolicy"),
    cacheRetention: "short",
    transport: "sse",
  });
  const profiles = new Map([[PROVIDER_ID, profile]]);
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth,
    resolveApiKey: async (route) => {
      if (route !== PROVIDER_ID) return undefined;
      return getJwt() ?? NOT_SIGNED_IN;
    },
    resolveAttachments: () => ctx.get("attachments"),
  });
  ctx.llm.registerAdapter([PROVIDER_ID], adapter);

  // Account panel routes for lib/client.js. ctx.inject (not the static
  // inject list) so the routes land whenever the webServer service
  // appears, whatever the plugin startup order; a profile without a web
  // server simply never gets them. A failure here must not take the
  // provider down with it.
  try {
    ctx.inject(["webServer"], (webCtx) => {
      registerAccountRoutes(webCtx, config);
    });
  } catch (err) {
    console.error("[dsh-free-pi] account panel routes unavailable:", err?.message ?? err);
  }
}
