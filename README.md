<p align="center">
  <img src="https://raw.githubusercontent.com/wawaTuna/dsh-free-pi/main/assets/banner.png" alt="dsh-free-pi" width="100%">
</p>

# dsh-free-pi

Free models for DeepSeek Harness, funded by ads — no API key, no card, one GitHub sign-in.

**DeepSeek V4.1 Flash, DeepSeek V4 Flash, GLM 5.3 Flash and Particle, free and unlimited in DSH.**

![CI](https://github.com/wawaTuna/dsh-free-pi/actions/workflows/ci.yml/badge.svg) ![License](https://img.shields.io/badge/license-MIT-blue.svg)

**[Quick start](#quick-start) · [Multiple accounts](#multiple-accounts--rotation) · [How it works](#how-it-works) · [Privacy](#privacy) · [简体中文](README.zh-CN.md)**

## Quick start

**1 · Install.**

```bash
dsh plugin --profile web add github:wawaTuna/dsh-free-pi
```

<details>
<summary>Other install routes</summary>

```bash
# Local clone
git clone https://github.com/wawaTuna/dsh-free-pi
dsh plugin --profile web add file:/abs/path/to/dsh-free-pi
```

</details>

Current DSH versions register the plugin's bundle from the package metadata automatically; either way, confirm with `dsh --profile web --dump-config` (look for the `# == dsh-free-pi` segment), then restart `dsh-web`. The `free-pi` group appears in the model picker.

**2 · Sign in.** (Accepts free-pi's terms — read [Privacy](#privacy) first.) Any of these writes the credentials file the plugin reads (`~/.free-pi/agent/credentials.json`, 0600):

```bash
npx free-pi-cli@latest          # official client: run once and sign in
# — or, in the free-pi-plugins monorepo —
node core/login.mjs
```

Alternatively set the plugin config `jwt` or the `FREEPI_JWT` env var. The token is re-read on **every request**, so signing in again takes effect without restarting DSH.

**3 · Verify.** Pick **DeepSeek V4.1 Flash** in the `free-pi` group of the model picker and send a message.

## What you get

- **Free Unlimited models cost nothing.** The models free-pi marks Free Unlimited (DeepSeek V4.1 Flash, DeepSeek V4 Flash, GLM 5.3 Flash, Particle at the time of writing) never touch your budget.
- **Everything else runs on a daily budget.** 15,000 credits (≈ $1.125) per account per day, refilled at 00:00 UTC. Metered models (DeepSeek V4 Pro, GPT-6 series, Kimi, …) deduct their real upstream cost × a catalogue multiplier.
- **The model list is live.** It comes from free-pi's own catalogue endpoint, so models appear and disappear as free-pi changes them — no plugin update needed.
- **No local port.** The plugin registers an in-process provider adapter; nothing extra to run or expose.

## Multiple accounts + rotation

Each free-pi account is a GitHub account with its own daily budget. DSH has no native multi-account providers, so this plugin rotates over an on-disk account pool itself (`~/.free-pi/agent/accounts.json`, 0600; `credentials.json` counts as the first account):

```bash
node core/login.mjs --label work   # free-pi-plugins monorepo: add ANOTHER GitHub account
```

Every request takes the next healthy account, quota-aware round-robin:

- **401** — the account is skipped (token rejected or expired);
- **budget spent** — the account is skipped until its refill time; quota is refreshed in the background from each account's `/me` record, never blocking a request;
- **already streaming** — a request stays on the account it started with.

Two accounts = 2 × 15,000 credits a day for metered models; Free Unlimited stays free on every account. To check balances, run `node core/quota.mjs` (free-pi-plugins monorepo) on the host — per-account handle, tier, remaining credits/USD and refill time. The sibling [magpie-free-pi](https://github.com/wawaTuna/magpie-free-pi) shows the same data in `magpie quota`.

## Configuration

| Field | Meaning |
|---|---|
| **`jwt`** | Optional single-token override; normally empty — file, env and pool are read live |
| **`hiddenModels`** | Model ids to hide from the picker (live, no restart) |

## How it works

free-pi's backend is a plain OpenAI-compatible endpoint (`POST https://api.freepi.ai/v1/chat/completions`) gated by three things a normal OpenAI client doesn't send: the JWT above, an `x-session-id` header (a client-chosen lease label — upstream accepts any stable value, which is also why rotation only ever needs to swap the JWT), and an `x-client-version` header (the server enforces a minimum client version). It has no `/v1/models` route — the catalogue lives on the unauthenticated `GET /client-version`.

The plugin follows the dsh-opencode-free skeleton: it builds a pi-ai provider carrying those headers, wraps it in DSH's `PiAiAdapter`, and registers it with `ctx.llm.registerAdapter(["free-pi"], …)`. Model records start from a built-in snapshot and refresh live from the catalogue. Both this plugin and [magpie-free-pi](https://github.com/wawaTuna/magpie-free-pi) share one reverse-proxy core (JWT / session / catalogue / rotation / quota), which also ships as a standalone OpenAI-compatible proxy in the free-pi-plugins monorepo.

## Privacy

free-pi is funded by ads **and by training on session data**. Its consent text — which you accept when you sign in — says your coding sessions (prompts, code, files, model responses) are saved as traces, used to train models, and may be shared or sold to third parties; the ad provider receives excerpts of your recent conversation to pick ads. Full terms: https://freepi.ai/terms

Only sign in with accounts and code you are comfortable with that trade. This applies to everything you send through free-pi, from any host.

## FAQ

#### When does the budget refill?

Daily at 00:00 UTC. `node core/quota.mjs` shows the exact time per account.

#### Is "Free Unlimited" permanent?

No — it's free-pi's promotion and can end at any time. Metered models keep working on the daily budget either way.

#### My token expired. What now?

Tokens last ~90 days. Sign in again with whichever route you used before — the plugin picks the new token up on the next request, no restart needed.

#### Could free-pi block this kind of client?

Its backend officially serves free-pi's own terminal client. This plugin talks to the same backend the same way, but free-pi could tighten its checks (for example, require live ad sessions).

## Contributing

Issues and PRs are welcome.

## License

MIT — see [LICENSE](LICENSE).

*Unofficial plugin. Not affiliated with free-pi, DeepSeek, or the model providers. "free-pi", "DeepSeek" and model names belong to their respective owners.*
