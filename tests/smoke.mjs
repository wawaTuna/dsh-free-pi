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
assert.equal(pkg.version, "0.2.1");
assert.equal(pkg.displayName, "FreePi", "settings panel shows the plugin as FreePi");
assert.ok(pkg.icon && existsSync(join(root, pkg.icon)), "plugin icon file exists on disk");
for (const lang of ["en", "zh"]) {
  const locale = JSON.parse(readFileSync(join(root, "locale", `${lang}.json`), "utf8"));
  assert.equal(locale.meta.title, "FreePi", `${lang} locale title is FreePi`);
}
assert.ok(pkg.exports?.["./client"], "client export declared for the account panel");
assert.ok(existsSync(join(root, pkg.exports["./client"])), "client module exists on disk");
assert.equal(pkg.dsh?.client?.platform, "web", "client targets the web shell");

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

// --- account management (describe / remove / single-shot device poll) -------------------
const described = core.describeAccounts();
assert.equal(described.length, 2, "describe covers both pool accounts");
assert.ok(
  described.every((a) => a.source === "pool" && a.removable === true && typeof a.addedAt === "string"),
  "pool accounts are removable and carry addedAt",
);
core.saveJwt("jwt-main");
const withMain = core.describeAccounts();
const main = withMain.find((a) => a.id === "default");
assert.ok(main, "credentials.json sign-in shows up as the default account");
assert.equal(main.source, "credentials");
assert.equal(main.removable, false, "the credentials file sign-in is not pool-removable");
const bId = withMain.find((a) => a.label === "b").id;
assert.equal(core.removeAccount(bId), true, "pool removal succeeds");
assert.equal(core.removeAccount(bId), false, "a second removal finds nothing");
assert.ok(!core.loadAccounts().some((a) => a.jwt === "jwt-b"), "removed account leaves the rotation");
assert.equal(core.removeAccount("default"), false, "the default account cannot be removed via the pool");

const realFetch = globalThis.fetch;
let pollBody = {};
globalThis.fetch = async (url) => {
  if (new URL(url).pathname === "/auth/token") return jsonRes(200, pollBody);
  throw new Error("unexpected path");
};
const stillPending = await core.pollDeviceTokenOnce("sess-1");
assert.equal(stillPending.pending, true, "no token yet reads as pending");
pollBody = { token: "jwt-new" };
const completed = await core.pollDeviceTokenOnce("sess-1");
assert.equal(completed.token, "jwt-new", "a token completes the single-shot poll");
globalThis.fetch = async () => jsonRes(403, { code: "consent_required" });
await assert.rejects(() => core.pollDeviceTokenOnce("sess-1"), /consent_required/);
globalThis.fetch = realFetch;

// --- ads gate: a 403 with the ads text pauses one account, failover covers it ------------
core.addAccount({ label: "c", jwt: "jwt-c" });
core.addAccount({ label: "d", jwt: "jwt-d" });
const ADS_BODY =
  "free-pi is free because ads pay for it, so ads can't be skipped. Ads aren't showing for this account, so free completions are paused. Run free-pi with `npx free-pi-cli@latest` so ads show, then retry.";
const textRes = (status, text) => ({
  status,
  ok: status >= 200 && status < 300,
  clone() { return this; },
  text: async () => text,
  json: async () => ({}),
});
const adsFetch = async (_url, init) => {
  const auth = init.headers.authorization || "";
  if (auth.includes("jwt-d")) return jsonRes(200, { ok: true });
  if (auth.includes("jwt-c")) return textRes(403, ADS_BODY);
  return jsonRes(401, { error: "nope" }); // every other account is out of the way
};
const adsRotated = await core.rotatingFetch("/v1/chat/completions", { body: "{}", fetchImpl: adsFetch });
assert.equal(adsRotated.res.status, 200, "ads-paused account fails over to a healthy one");
assert.equal(adsRotated.account.jwt, "jwt-d");
const cInfo = core.describeAccounts().find((a) => a.label === "c");
assert.equal(cInfo.status, "paused-ads", "describeAccounts surfaces the ads pause distinctly");
assert.ok(
  cInfo.pausedUntil && Date.parse(cInfo.pausedUntil) > Date.now() + 20 * 60 * 1000,
  "the pause carries a resume time about 30 minutes out",
);
const cQuota = await core.fetchAccountQuota(
  { id: cInfo.id, label: "c", jwt: "jwt-c" },
  async () => jsonRes(200, meRecord),
);
assert.equal(cQuota.status, "paused-ads", "the quota summary surfaces the ads pause too");
assert.equal(cQuota.ok, true, "/me still answers while completions are paused");
// A 403 that is not the ads gate is returned to the caller, never a pause.
const noPause = await core.rotatingFetch("/v1/chat/completions", {
  body: "{}",
  fetchImpl: async () => textRes(403, "forbidden for another reason"),
});
assert.equal(noPause.res.status, 403, "an unrelated 403 is surfaced, not swallowed");
assert.ok(noPause.account, "an unrelated 403 does not fail over");
assert.equal(
  core.describeAccounts().find((a) => a.label === "d").status,
  "ok",
  "the account that served the unrelated 403 stays un-paused",
);

console.log("smoke: all assertions passed");
