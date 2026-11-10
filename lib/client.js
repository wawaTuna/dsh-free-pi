/**
 * dsh-free-pi — Client half: the account panel.
 *
 * Registers a Settings section (the `settings.section` list slot, id
 * "dsh-free-pi", with its `settings.section.icon` sibling — the pairing
 * dsh-connect-workbuddy uses) that manages the free-pi sign-ins the Host
 * half rotates across:
 *
 *   - account cards with live per-account quota (GET
 *     /plugins/dsh-free-pi/accounts),
 *   - "add account": a GitHub device login driven over the plugin's own
 *     routes (POST login/start shows the code, POST login/poll completes
 *     it into the pool),
 *   - pool removal behind an explicit confirm step (POST accounts/remove).
 *
 * The routes are loopback-guarded on the Host, so the panel only works
 * from the paired local browser, exactly like the provider itself.
 * Strings go through the Client locale service (namespace
 * "settings.free-pi", en + zh registered below); styling uses only
 * --dsw-alias-* theme tokens so the panel follows the host theme.
 */
window.__ModuleLoader__.load({
  id: "dsh-free-pi",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const ACCOUNTS_PATH = "/plugins/dsh-free-pi/accounts";
    const LOGIN_START_PATH = "/plugins/dsh-free-pi/login/start";
    const LOGIN_POLL_PATH = "/plugins/dsh-free-pi/login/poll";
    const REMOVE_PATH = "/plugins/dsh-free-pi/accounts/remove";

    const STRINGS = {
      en: {
        nav: { panel: "FreePi" },
        panel: {
          title: "FreePi accounts",
          subtitle:
            "Sign-ins used by the free-pi model provider. Requests rotate across the accounts; every GitHub account carries its own daily credit budget.",
          disclosure:
            "Note: free-pi is funded by ads and by training on session data. Signing in records your consent to free-pi's terms — sessions may be saved as traces and used to train models. Only sign in with accounts you accept that for.",
          refresh: "Refresh",
          loading: "Loading accounts…",
          loadError: "Could not load accounts.",
          empty: "No accounts yet. Add one below to start using free-pi models.",
        },
        login: {
          add: "Add account",
          addHint: "Signs in with another GitHub account through the device flow.",
          title: "Add a GitHub account",
          step1: "1. Open the GitHub device page and sign in there:",
          open: "Open GitHub",
          step2: "2. Enter this code:",
          waiting: "Waiting for authorization… this panel finishes on its own once you approve.",
          cancel: "Cancel",
          expired: "That code expired. Start again to get a new one.",
          added: "Account added to the pool.",
          failed: "Sign-in failed.",
        },
        account: {
          credits: "credits left today",
          of: "of",
          refill: "refills",
          pool: "Account pool",
          main: "Main sign-in",
          config: "From plugin config",
          env: "From environment",
          remove: "Remove",
          removeConfirm: "Remove this account from the pool?",
          confirm: "Confirm remove",
          cancel: "Cancel",
          notRemovable: "Managed outside the pool — it cannot be removed here.",
          expired: "Sign-in expired or revoked. Remove it and sign in again.",
          unreachable: "free-pi could not be reached to check this account.",
          pausedAds: "Paused by free-pi: ads aren't showing for this account, so free completions are paused. Expected back around",
          addedOn: "Added",
        },
      },
      zh: {
        nav: { panel: "FreePi" },
        panel: {
          title: "FreePi 账号",
          subtitle:
            "free-pi 模型提供方使用的登录账号。请求会在这些账号之间轮换；每个 GitHub 账号有独立的每日额度。",
          disclosure:
            "注意：free-pi 由广告和会话数据训练供资。登录即表示同意 free-pi 的条款——会话可能被保存为轨迹并用于训练模型。请只登录你能接受这一点的账号。",
          refresh: "刷新",
          loading: "正在加载账号…",
          loadError: "账号加载失败。",
          empty: "还没有账号。在下方添加一个即可开始使用 free-pi 模型。",
        },
        login: {
          add: "添加账号",
          addHint: "通过设备流程登录另一个 GitHub 账号。",
          title: "添加 GitHub 账号",
          step1: "1. 打开 GitHub 设备页面并在那里登录：",
          open: "打开 GitHub",
          step2: "2. 输入这个验证码：",
          waiting: "正在等待授权…你在 GitHub 上批准后，本面板会自动完成。",
          cancel: "取消",
          expired: "验证码已过期。重新开始获取一个新的。",
          added: "账号已加入账号池。",
          failed: "登录失败。",
        },
        account: {
          credits: "今日剩余额度",
          of: "共",
          refill: "刷新于",
          pool: "账号池",
          main: "主登录",
          config: "来自插件配置",
          env: "来自环境变量",
          remove: "移除",
          removeConfirm: "从账号池移除这个账号？",
          confirm: "确认移除",
          cancel: "取消",
          notRemovable: "由账号池之外管理，无法在此移除。",
          expired: "登录已过期或被吊销。请移除后重新登录。",
          unreachable: "暂时连不上 free-pi，无法核查这个账号。",
          pausedAds: "已被 free-pi 暂停：该账号没有展示广告，免费调用暂停。预计恢复时间",
          addedOn: "添加于",
        },
      },
    };

    const CSS = `
.fp-panel{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:16px;padding:4px 0;max-width:720px}
.fp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.fp-title{font-size:15px;font-weight:600}
.fp-sub{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.55;margin-top:4px}
.fp-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}
.fp-cards{display:flex;flex-direction:column;gap:10px}
.fp-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:6px}
.fp-card-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fp-label{font-weight:600;font-size:13.5px}
.fp-handle{color:var(--dsw-alias-label-secondary);font-size:12.5px}
.fp-badge{font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px}
.fp-credits{font-size:13px}
.fp-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.fp-error{color:var(--dsw-alias-state-error-primary);font-size:12.5px}
.fp-warn{color:var(--dsw-alias-state-warn-primary);font-size:12.5px}
.fp-success{color:var(--dsw-alias-state-success-primary);font-size:12.5px}
.fp-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:12.5px;cursor:pointer}
.fp-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fp-btn[disabled]{opacity:.55;cursor:default}
.fp-btn-primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);font-weight:600}
.fp-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.fp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fp-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:26px;letter-spacing:.35em;font-weight:700;padding:12px 14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);text-align:center}
.fp-login{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:10px;max-width:480px}
.fp-login-title{font-weight:600;font-size:13.5px}
.fp-link{color:var(--dsw-alias-brand-primary)}
`;

    async function api(path, { method = "GET", body } = {}) {
      const res = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.reason || data?.error || `HTTP ${res.status}`);
      return data;
    }

    const flatten = (obj, prefix = "", out = {}) => {
      for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === "object") flatten(value, path, out);
        else out[path] = value;
      }
      return out;
    };
    const EN_FLAT = flatten(STRINGS.en);

    function SectionIcon(props) {
      // FreePi mark: a pi (π) glyph — top bar and two legs — drawn in
      // currentColor so it follows the settings nav's own colour states,
      // matching the plugin's icon.png (white π on teal) in shape.
      const edge = typeof props?.size === "number" ? props.size : 16;
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: edge, height: edge, "aria-hidden": true, style: { display: "block" } },
        h("path", {
          d: "M4 6.5h16M8.2 6.5v10.2c0 1-.6 1.8-1.7 2.3M15.8 6.5V19",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2.1,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        const namespace = "settings.free-pi";
        try {
          ctx.effect(
            () => ctx.locale.register(namespace, { en: STRINGS.en, zh: STRINGS.zh }),
            "dsh-free-pi: settings copy",
          );
        } catch {
          // No locale service in this shell: t() falls back to English.
        }
        let bound = null;
        try {
          bound = ctx.locale.bind(namespace);
        } catch {
          bound = null;
        }
        const t = (key) => {
          try {
            const value = bound?.(key);
            if (typeof value === "string" && value !== key) return value;
          } catch {
            // fall through to the built-in table
          }
          return EN_FLAT[key] ?? key;
        };

        function AccountCard({ account: a, confirming, busy, onAskRemove, onConfirmRemove, onCancelRemove }) {
          const sourceLabel =
            a.source === "pool"
              ? t("account.pool")
              : a.source === "credentials"
                ? t("account.main")
                : a.source === "env"
                  ? t("account.env")
                  : t("account.config");
          const statusText = a.ok
            ? null
            : /unauthorized/i.test(a.error ?? "")
              ? t("account.expired")
              : t("account.unreachable");
          return h(
            "div",
            { className: "fp-card" },
            h(
              "div",
              { className: "fp-card-top" },
              h("span", { className: "fp-label" }, a.label),
              a.handle ? h("span", { className: "fp-handle" }, `@${a.handle}`) : null,
              a.tier ? h("span", { className: "fp-badge" }, a.tier) : null,
              h("span", { className: "fp-badge" }, sourceLabel),
            ),
            a.ok
              ? h(
                  "div",
                  { className: "fp-credits" },
                  `${a.remainingCredits != null ? a.remainingCredits.toLocaleString() : "—"} ${t("account.credits")}`,
                  a.allowanceCredits != null
                    ? h("span", { className: "fp-muted" }, ` · ${t("account.of")} ${a.allowanceCredits.toLocaleString()}`)
                    : null,
                  a.refillAt
                    ? h(
                        "span",
                        { className: "fp-muted" },
                        ` · ${t("account.refill")} ${new Date(a.refillAt).toLocaleString()}`,
                      )
                    : null,
                )
              : h("div", { className: "fp-error" }, statusText),
            a.status === "paused-ads"
              ? h(
                  "div",
                  { className: "fp-warn" },
                  `${t("account.pausedAds")} ${a.pausedUntil ? new Date(a.pausedUntil).toLocaleString() : ""}`.trim(),
                )
              : null,
            a.addedAt
              ? h(
                  "div",
                  { className: "fp-muted" },
                  `${t("account.addedOn")} ${new Date(a.addedAt).toLocaleDateString()}`,
                )
              : null,
            a.removable
              ? confirming
                ? h(
                    "div",
                    { className: "fp-row" },
                    h("span", { className: "fp-error" }, t("account.removeConfirm")),
                    h(
                      "button",
                      { className: "fp-btn fp-btn-danger", disabled: busy, onClick: () => onConfirmRemove(a.id) },
                      t("account.confirm"),
                    ),
                    h(
                      "button",
                      { className: "fp-btn", disabled: busy, onClick: onCancelRemove },
                      t("account.cancel"),
                    ),
                  )
                : h(
                    "div",
                    { className: "fp-row" },
                    h("button", { className: "fp-btn", disabled: busy, onClick: () => onAskRemove(a.id) }, t("account.remove")),
                  )
              : h("div", { className: "fp-muted" }, t("account.notRemovable")),
          );
        }

        function Panel() {
          const [accounts, setAccounts] = useState(null);
          const [loadError, setLoadError] = useState("");
          const [flow, setFlow] = useState(null);
          const [note, setNote] = useState(null);
          const [starting, setStarting] = useState(false);
          const [confirmId, setConfirmId] = useState(null);
          const [busyId, setBusyId] = useState(null);
          const pollTimer = useRef(null);
          const polling = useRef(false);

          const load = useCallback(async () => {
            try {
              const data = await api(ACCOUNTS_PATH);
              setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
              setLoadError("");
            } catch (err) {
              setLoadError(err?.message ?? String(err));
            }
          }, []);

          useEffect(() => {
            void load();
          }, [load]);

          const stopPolling = useCallback(() => {
            if (pollTimer.current) {
              clearInterval(pollTimer.current);
              pollTimer.current = null;
            }
          }, []);

          useEffect(() => stopPolling, [stopPolling]);

          const pollOnce = useCallback(async () => {
            if (polling.current) return;
            polling.current = true;
            try {
              const data = await api(LOGIN_POLL_PATH, { method: "POST", body: {} });
              if (data.status === "added") {
                stopPolling();
                setFlow(null);
                setNote({ kind: "added", text: t("login.added") });
                await load();
              } else if (data.status === "expired" || data.status === "none") {
                stopPolling();
                setFlow(null);
                setNote({ kind: "error", text: t("login.expired") });
              } else if (data.status === "error") {
                stopPolling();
                setFlow(null);
                setNote({ kind: "error", text: `${t("login.failed")} ${data.error ?? ""}`.trim() });
              }
              // "pending": the interval keeps polling until the code expires.
            } catch {
              // A transient failure says nothing about the login; keep polling.
            } finally {
              polling.current = false;
            }
          }, [load, stopPolling]);

          const startLogin = useCallback(async () => {
            setStarting(true);
            setNote(null);
            try {
              const data = await api(LOGIN_START_PATH, { method: "POST", body: {} });
              setFlow(data);
              stopPolling();
              pollTimer.current = setInterval(
                () => void pollOnce(),
                Math.max(data.intervalSeconds || 5, 3) * 1000,
              );
            } catch (err) {
              setNote({ kind: "error", text: `${t("login.failed")} ${err?.message ?? ""}`.trim() });
            } finally {
              setStarting(false);
            }
          }, [pollOnce, stopPolling]);

          const cancelLogin = useCallback(() => {
            stopPolling();
            setFlow(null);
          }, [stopPolling]);

          const confirmRemove = useCallback(
            async (id) => {
              setBusyId(id);
              try {
                await api(REMOVE_PATH, { method: "POST", body: { id } });
                setConfirmId(null);
                await load();
              } catch (err) {
                setNote({ kind: "error", text: err?.message ?? String(err) });
              } finally {
                setBusyId(null);
              }
            },
            [load],
          );

          return h(
            "div",
            { className: "fp-panel" },
            h("style", null, CSS),
            h(
              "div",
              { className: "fp-head" },
              h(
                "div",
                null,
                h("div", { className: "fp-title" }, t("panel.title")),
                h("div", { className: "fp-sub" }, t("panel.subtitle")),
              ),
              h(
                "button",
                { className: "fp-btn", onClick: () => void load(), disabled: accounts === null },
                t("panel.refresh"),
              ),
            ),
            h("div", { className: "fp-note" }, t("panel.disclosure")),
            note
              ? h("div", { className: note.kind === "added" ? "fp-success" : "fp-error" }, note.text)
              : null,
            accounts === null
              ? loadError
                ? h("div", { className: "fp-error" }, `${t("panel.loadError")} ${loadError}`)
                : h("div", { className: "fp-muted" }, t("panel.loading"))
              : accounts.length === 0
                ? h("div", { className: "fp-muted" }, t("panel.empty"))
                : h(
                    "div",
                    { className: "fp-cards" },
                    accounts.map((a) =>
                      h(AccountCard, {
                        key: a.id,
                        account: a,
                        confirming: confirmId === a.id,
                        busy: busyId === a.id,
                        onAskRemove: setConfirmId,
                        onConfirmRemove: confirmRemove,
                        onCancelRemove: () => setConfirmId(null),
                      }),
                    ),
                  ),
            flow
              ? h(
                  "div",
                  { className: "fp-login" },
                  h("div", { className: "fp-login-title" }, t("login.title")),
                  h("div", null, t("login.step1")),
                  h(
                    "div",
                    { className: "fp-row" },
                    h(
                      "a",
                      { className: "fp-link", href: flow.verificationUri, target: "_blank", rel: "noreferrer" },
                      t("login.open"),
                    ),
                    h("span", { className: "fp-muted" }, flow.verificationUri),
                  ),
                  h("div", null, t("login.step2")),
                  h("div", { className: "fp-code" }, flow.userCode),
                  h("div", { className: "fp-muted" }, t("login.waiting")),
                  h(
                    "div",
                    { className: "fp-row" },
                    h("button", { className: "fp-btn", onClick: cancelLogin }, t("login.cancel")),
                  ),
                )
              : h(
                  "div",
                  { className: "fp-row" },
                  h(
                    "button",
                    { className: "fp-btn fp-btn-primary", onClick: () => void startLogin(), disabled: starting },
                    t("login.add"),
                  ),
                  h("span", { className: "fp-muted" }, t("login.addHint")),
                ),
          );
        }

        try {
          ctx.slots.inject("settings.section", () => {
            const disposers = [];
            disposers.push(
              ctx.slots.register(
                {
                  name: "settings.section",
                  id: "dsh-free-pi",
                  order: 40,
                  label: () => t("nav.panel"),
                  locale: namespace,
                  inject: () => ({ t, surface: "settings" }),
                },
                Panel,
              ),
            );
            try {
              const iconInject = ctx.slots.inject("settings.section.icon", () => {
                const iconDisposer = ctx.slots.register(
                  { name: "settings.section.icon", id: "dsh-free-pi", locale: namespace },
                  SectionIcon,
                );
                disposers.push(iconDisposer);
                return iconDisposer;
              });
              if (typeof iconInject === "function") disposers.push(iconInject);
            } catch (err) {
              console.error("[dsh-free-pi] settings icon failed to register (panel unaffected):", err);
            }
            return () => {
              for (const dispose of disposers) {
                try {
                  dispose();
                } catch {
                  // Already gone with the slot; nothing to undo.
                }
              }
            };
          });
        } catch (err) {
          console.error("[dsh-free-pi] settings section failed to register:", err);
        }
      },
    };
  },
});
