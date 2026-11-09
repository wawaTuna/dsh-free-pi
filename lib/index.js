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
  fetchCatalog,
  getSessionId,
  pickAccountCandidates,
  refreshQuotaCache,
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

  const toModel = (m) => ({
    id: m.id,
    name: m.name,
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    api: "openai-completions",
    headers: { ...staticHeaders },
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 8192,
  });

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
    name: "free-pi",
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
    displayName: "free-pi",
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
}
