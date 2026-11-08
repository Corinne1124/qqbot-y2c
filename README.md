# QQ Bot Y2C

基于 Cloudflare Worker 的 QQ 机器人，使用 Webhook 方式接入。

## 功能特性

- 支持 C2C 私聊消息和群聊 @ 消息
- Ed25519 签名校验
- access_token 自动获取与缓存（支持 KV）
- GitHub Actions 自动部署

## 快速开始

### 1. 准备工作

- 注册 [QQ 开放平台](https://q.qq.com/) 并创建机器人，获取 AppID、AppSecret 和 BotSecret
- 拥有 Cloudflare 账号

### 2. 克隆并安装依赖

```bash
git clone <your-repo-url>
cd qqbot_y2c
npm install
```

### 3. 设置 Secrets

在 Cloudflare Dashboard 或使用 wrangler CLI 设置以下变量：

```bash
wrangler secret put QQ_APP_ID
wrangler secret put QQ_APP_SECRET
wrangler secret put BOT_SECRET
```

### 4. 本地开发

```bash
npm run dev
```

### 5. 部署

```bash
npm run deploy
```

### 6. 配置 QQ 开放平台

- 在机器人「开发设置」中选择接入方式为 **Webhook**
- 回调地址填写：`https://你的worker域名/qq/webhook`
- 添加沙箱测试 QQ 号

### 7. 自动部署

配置 GitHub Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

每次 push 到 main 分支会自动部署。

## 目录结构

```
.
├── .github/workflows/deploy.yml
├── src/index.ts
├── package.json
├── tsconfig.json
├── wrangler.toml
└── README.md
```

## 注意事项

- 群消息只有 @机器人 时才会推送
- 回调必须在 3 秒内响应，业务逻辑请放入 `ctx.waitUntil`
- 生产环境建议绑定 KV 以持久化 access_token
- BotSecret 需妥善保管，切勿提交到 Git
