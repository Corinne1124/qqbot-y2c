# QQ Bot Y2C

基于 Cloudflare Pages（Functions，workerd 运行时）的 QQ 机器人，使用 Webhook 方式接入。

> **为什么用 Pages 而不是 Workers**：`*.workers.dev` 在国内被整域封锁（DNS 污染 + SNI 阻断），
> QQ 平台的回调请求根本到不了；`*.pages.dev` 可以直连。业务代码完全一致，只是换了部署壳。

## 功能特性

- 支持 C2C 私聊消息和群聊 @ 消息
- Ed25519 签名校验（由 Bot Secret 派生密钥）
- access_token 自动获取与缓存（支持 KV）
- 构建产物为单文件 `dist/_worker.js`（Pages 高级模式）
- GitHub Actions 自动部署

## 快速开始

### 1. 准备工作

- 注册 [QQ 开放平台](https://q.qq.com/) 并创建机器人，获取 AppID、AppSecret 和 BotSecret
- 拥有 Cloudflare 账号

> **AppSecret 与 BotSecret**：`QQ_APP_SECRET` 用于换取 `access_token`；
> Webhook 验签与回调地址校验使用 Bot Secret。多数 QQ 机器人控制台只有一个 AppSecret，
> 此时两者相同；代码在 `QQ_BOT_SECRET` 缺省时会自动回退到 `QQ_APP_SECRET`。

### 2. 克隆并安装依赖

```bash
git clone <your-repo-url>
cd qqbot_y2c
npm install
```

### 3. 创建 Pages 项目并设置 Secrets

```bash
npx wrangler login
npx wrangler pages project create qqbot-y2c --production-branch=main --compatibility-date=2025-12-01
```

密钥（三个变量）可以二选一设置：

```bash
# 方式一：本地批量上传（读取 .dev.vars）
npm run secrets:push

# 方式二：Cloudflare Dashboard → Workers & Pages → qqbot-y2c
#        → Settings → Environment variables 逐个添加，注意选 Production
```

### 4. 本地开发

本地开发时 Secret 不会从 Cloudflare 读取，需要创建 `.dev.vars`（已在 `.gitignore` 中忽略，可参考 `dev.vars.example`）：

```bash
QQ_APP_ID=your_app_id
QQ_APP_SECRET=your_app_secret
QQ_BOT_SECRET=your_app_secret
```

```bash
npm run dev
```

### 5. 部署

```bash
npm run deploy   # 等价于：npm run build && wrangler pages deploy dist --project-name qqbot-y2c
```

部署成功后会得到 `https://qqbot-y2c.pages.dev`。

### 6. 配置 QQ 开放平台

- 在机器人「开发设置」中选择接入方式为 **Webhook**
- 回调地址填写：`https://qqbot-y2c.pages.dev/qq/webhook`
- 添加沙箱测试 QQ 号

自测（期望 `200` + `{"plain_token":"...","signature":"..."}`）：

```bash
curl -i -X POST https://qqbot-y2c.pages.dev/qq/webhook ^
  -H "Content-Type: application/json" ^
  -d "{\"op\":13,\"d\":{\"plain_token\":\"test\",\"event_ts\":\"1725442341\"}}"
```

### 7. 自动部署

配置 GitHub Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

每次 push 到 main 分支会自动部署（也可在 Actions 页面手动触发）。工作流会自动创建 Pages 项目、构建、同步密钥、部署。

密钥（`QQ_APP_ID` / `QQ_APP_SECRET` / `QQ_BOT_SECRET`）有两种管理方式，**选一种即可**：

| 方式 | 做法 | 说明 |
|---|---|---|
| A. 存在 Cloudflare（默认） | 本地跑一次 `npm run secrets:push` | 之后 push 只发代码，密钥沿用 Cloudflare Pages 上的，不会丢 |
| B. 存在 GitHub | 在仓库 Settings → Secrets and variables → Actions 里添加这三个变量 | 每次推送会先 `wrangler pages secret bulk` 同步到 Cloudflare，再部署，适合换机器/重建项目 |

注意：
- `.dev.vars` 已被 `.gitignore` 忽略，**不会**随仓库上传，所以 GitHub 部署读不到它。
- 两种方式同时配置时，方式 B 会在每次推送时覆盖 Cloudflare 上的值，改密钥请以 GitHub 为准。
- 方式 B 未配置时，`Sync secrets to Cloudflare Pages` 步骤会自动跳过，不影响部署。

## 目录结构

```
.
├── .github/workflows/deploy.yml
├── src/index.ts          # 全部业务逻辑
├── scripts/build-pages.mjs  # 编译出 dist/_worker.js
├── dev.vars.example
├── package.json
├── tsconfig.json
├── wrangler.toml         # 仅本地 dev / Workers 备用部署使用
└── README.md
```

## 注意事项

- `*.workers.dev` 在国内不可用；本项目的线上入口是 `*.pages.dev`
- Pages 免费额度为 100,000 请求/天，个人机器人够用，超了需要升级
- Pages 不读取 `wrangler.toml` 的 KV 绑定，如需 KV 请在 Dashboard → Settings → Functions → KV namespace bindings 里配置
- 群消息只有 @机器人 时才会推送
- 回调必须在 3 秒内响应，业务逻辑请放入 `ctx.waitUntil`
- 被动回复需要携带 `msg_id` 与 `msg_seq`（同一 msg_id 最多回复 5 次），代码已自动处理
- BotSecret 需妥善保管，切勿提交到 Git
