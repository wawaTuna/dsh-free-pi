// Hermetic smoke tests for the vendored free-pi core + this package's
// manifest. No network: every upstream call is stubbed.
// The plugin entry (lib/index.js) imports DSH host packages
// (@deepseek-ai/dsh-llm, pi-ai, ...) that only exist inside a DSH
// profile, so it is syntax-checked in CI but not imported here.
// Run: node tests/smoke.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Isolate all ~/.free-pi state before the core reads homedir().
process.env.HOME = mkdtempSync(join(tmpdir(), "dsh-free-pi-test-"));
delete process.env.FREEPI_JWT;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import("../lib/free-pi-core.mjs");
const meRecord = {
  handle: "tester",
  tier: "young",
  allowance_credits: 15000,
  remaining_credits_today: 12000,
  remaining_usd_today: 0.9,
  cap_usd_today: 1.125,
  premium_credits: 0,
  refill_at: "2026-11-10T00:00:00.000Z",
  earn_reward: null,
};
const jsonRes = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
  clone() { return this; },
});

// --- package manifest ---------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(pkg.name, "dsh-free-pi");
assert.ok(pkg.dsh?.bundle?.patch, "dsh.bundle.patch declared");
assert.ok(existsSync(join(root, pkg.dsh.bundle.patch)), "bundle patch file exists");
assert.ok(pkg.peerDependencies?.["@deepseek-ai/dsh-llm"], "host peers declared");

// --- account pool ---------------------------------------------------------------
assert.equal(core.loadAccounts().length, 0, "pool starts empty");
core.addAccount({ label: "a", jwt: "jwt-a" });
core.addAccount({ label: "b", jwt: "jwt-b" });
core.addAccount({ label: "a-again", jwt: "jwt-a" }); // dedupe by token
const accounts = core.loadAccounts();
assert.equal(accounts.length, 2, "two accounts after dedupe");
const firsts = new Set(Array.from({ length: 6 }, () => core.pickAccountCandidates()[0]?.jwt));
assert.deepEqual([...firsts].sort(), ["jwt-a", "jwt-b"], "round-robin covers both accounts");
core.markAccountInvalid(accounts.find((x) => x.jwt === "jwt-a").id);
assert.ok(core.pickAccountCandidates().every((x) => x.jwt !== "jwt-a"), "invalid account skipped");

// --- quota ----------------------------------------------------------------------
const summary = core.summarizeQuota({ id: "x", label: "x" }, meRecord);
assert.equal(summary.usedCredits, 3000);
assert.equal(summary.remainingCredits, 12000);
const quota = await core.fetchAccountQuota({ id: "q", label: "q", jwt: "jwt-b" }, async () => jsonRes(200, meRecord));
assert.equal(quota.ok, true);
assert.equal(quota.handle, "tester");
const deadQuota = await core.fetchAccountQuota({ id: "q2", label: "q2", jwt: "nope" }, async () => jsonRes(401, {}));
assert.equal(deadQuota.ok, false, "401 quota reads as unauthorized");

// --- rotating fetch failover ------------------------------------------------------
const stubFetch = async (_url, init) => {
  const auth = init.headers.authorization || "";
  return auth.includes("jwt-a") ? jsonRes(401, { error: "bad token" }) : jsonRes(200, { ok: true });
};
const rotated = await core.rotatingFetch("/v1/chat/completions", { body: "{}", fetchImpl: stubFetch });
assert.equal(rotated.res.status, 200, "failover lands on the healthy account");
assert.equal(rotated.account.jwt, "jwt-b");

// --- catalogue ----------------------------------------------------------------------
const catalog = await core.fetchCatalog(async () =>
  jsonRes(200, { models: [{ id: "deepseek-v4.1-flash", name: "V4.1" }, { id: "gone", name: "Gone", unavailable: true }] }),
);
assert.deepEqual(catalog.map((m) => m.id), ["deepseek-v4.1-flash"], "unavailable models filtered");

// --- session id stability -------------------------------------------------------------
assert.equal(core.getSessionId(), core.getSessionId(), "session id is stable per install");

console.log("smoke: all assertions passed");
