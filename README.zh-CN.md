<p align="center">
  <img src="https://raw.githubusercontent.com/wawaTuna/dsh-free-pi/main/assets/banner.png" alt="dsh-free-pi" width="100%">
</p>

# dsh-free-pi

给 DeepSeek Harness 用的免费模型，靠广告养活 —— 不要 API key、不用绑卡，GitHub 登录一次即可。

**DeepSeek V4.1 Flash、DeepSeek V4 Flash、GLM 5.3 Flash、Particle，在 DSH 里免费无限用。**

![CI](https://github.com/wawaTuna/dsh-free-pi/actions/workflows/ci.yml/badge.svg) [![npm](https://img.shields.io/npm/v/dsh-free-pi)](https://www.npmjs.com/package/dsh-free-pi) ![License](https://img.shields.io/badge/license-MIT-blue.svg)

**[快速开始](#快速开始) · [多账号与轮换](#多账号与轮换) · [原理](#原理) · [隐私](#隐私) · [English](README.md)**

## 快速开始

**1 · 安装。**

```bash
dsh plugin --profile web add github:wawaTuna/dsh-free-pi
```

<details>
<summary>其他安装方式</summary>

```bash
# 本地克隆
git clone https://github.com/wawaTuna/dsh-free-pi
dsh plugin --profile web add file:/abs/path/to/dsh-free-pi
```

</details>

当前版本的 DSH 会依据包元数据自动登记插件的 bundle；无论如何，装完用 `dsh --profile web --dump-config` 确认一次（找 `# == dsh-free-pi` 段），再重启 `dsh-web`。模型选择器里就会出现 `free-pi` 分组。

**2 · 登录。**（登录即接受 free-pi 的条款 —— 先读 [隐私](#隐私) 一节。）以下任何一种方式写的都是插件读取的同一个凭据文件（`~/.free-pi/agent/credentials.json`，0600 权限）：

```bash
npx free-pi-cli@latest          # 官方客户端：跑一次并在里面登录
# —— 或者在 free-pi-plugins 单体仓库里 ——
node core/login.mjs
```

也可以直接在插件配置里设 `jwt`，或设 `FREEPI_JWT` 环境变量。令牌在**每次请求**时现读，所以重新登录立刻生效，不用重启 DSH。

**3 · 验证。** 在模型选择器的 `free-pi` 分组里选 **DeepSeek V4.1 Flash**，发一条消息试试。

## 你能得到什么

- **免费无限档不花钱。** free-pi 标记为 Free Unlimited 的模型（写作时为 DeepSeek V4.1 Flash、DeepSeek V4 Flash、GLM 5.3 Flash、Particle）永远不占用预算。
- **其余模型走每日预算。** 每个账号每天 15,000 点（约 $1.125），UTC 00:00（北京时间 08:00）刷新。扣费模型（DeepSeek V4 Pro、GPT-6 系列、Kimi 等）按真实上游成本 × 目录倍率扣。
- **模型列表是实时的。** 来自 free-pi 自己的目录接口，它增删模型这边立刻跟随，不用更新插件。
- **不开本地端口。** 插件注册的是进程内的 provider 适配器，没有额外的东西要跑、要暴露。

## 多账号与轮换

每个 free-pi 账号就是一个 GitHub 账号，各有一份每日预算。DSH 没有原生的多账号 provider，所以这个插件自己在本机账号池上做轮换（`~/.free-pi/agent/accounts.json`，0600；`credentials.json` 算第一个账号）：

```bash
node core/login.mjs --label work   # free-pi-plugins 单体仓库：给池里再加一个 GitHub 账号
```

每次请求取下一个健康账号，按额度感知轮换：

- **401** —— 跳过该账号（令牌被拒或已过期）；
- **预算花光** —— 跳过该账号，直到它的刷新时间；额度在后台从各账号的 `/me` 记录刷新，永不阻塞请求；
- **已在流式输出** —— 请求留在它起始的账号上。

两个账号 = 扣费模型每天 2 × 15,000 点；免费无限档在每个账号上都免费。查余额在宿主机上跑 `node core/quota.mjs`（free-pi-plugins 单体仓库）—— 每个账号的用户名、等级、剩余点数/美元和刷新时间。姊妹版 [magpie-free-pi](https://github.com/wawaTuna/magpie-free-pi) 会在 `magpie quota` 里显示同样的数据。

## 配置

| 字段 | 含义 |
|---|---|
| **`jwt`** | 可选的单令牌覆盖；通常留空 —— 文件、环境变量和账号池都是现读的 |
| **`hiddenModels`** | 要在选择器里隐藏的模型 id（实时生效，不用重启） |

## 原理

free-pi 的后端是一个普通的 OpenAI 兼容接口（`POST https://api.freepi.ai/v1/chat/completions`），拦路的是三样普通 OpenAI 客户端不会发的东西：上面的 JWT、一个 `x-session-id` 头（客户端自选的租约标签 —— 上游接受任意稳定值，这也是为什么轮换只需要换 JWT）、一个 `x-client-version` 头（服务器强制最低客户端版本）。它也没有 `/v1/models` 接口 —— 目录在无需鉴权的 `GET /client-version` 上。

本插件沿用 dsh-opencode-free 的骨架：构建一个带这些头的 pi-ai provider，用 DSH 的 `PiAiAdapter` 包起来，再通过 `ctx.llm.registerAdapter(["free-pi"], …)` 注册。模型记录先用内置快照，再从目录实时刷新。本插件与 [magpie-free-pi](https://github.com/wawaTuna/magpie-free-pi) 共用同一个反代核心（JWT / 会话 / 目录 / 轮换 / 额度），该核心在 free-pi-plugins 单体仓库里还有一个独立的 OpenAI 兼容代理形态。

## 隐私

free-pi 由广告**和用会话数据训练模型**养活。它的同意文本 —— 你登录时即接受 —— 写明：你的编码会话（提示词、代码、文件、模型回复）会被保存为轨迹、用于训练模型，并可能共享或出售给第三方；广告商会拿到你近期对话的摘录来选广告。完整条款：https://freepi.ai/terms

只用你能接受这个交换的账号和代码登录。这一条对你经 free-pi 发送的一切内容都适用，与从哪个宿主用它无关。

## 常见问题

#### 预算什么时候刷新？

每天 UTC 00:00。`node core/quota.mjs` 会显示每个账号的精确时间。

#### "免费无限"是永久的吗？

不是 —— 这是 free-pi 的限时促销，随时可能结束。结束后扣费模型仍可走每日预算。

#### 令牌过期了怎么办？

令牌约 90 天有效期。用你之前用的任何一种方式重新登录即可 —— 插件在下一次请求就会读到新令牌，不用重启。

#### free-pi 会封这种客户端吗？

它的后端官方只服务它自己的终端客户端。本插件以同样方式调同一后端，但 free-pi 可能收紧校验（比如要求真实广告会话）。

## 参与贡献

欢迎提 issue 和 PR。

## 许可

MIT —— 见 [LICENSE](LICENSE)。

*非官方插件。与 free-pi、DeepSeek 及各模型提供方无隶属关系。"free-pi"、"DeepSeek" 与各模型名称归其各自所有者所有。*
