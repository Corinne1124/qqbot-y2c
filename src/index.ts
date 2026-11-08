/**
 * QQ 机器人 Cloudflare Worker 入口
 * 使用 Ed25519 签名校验，支持 C2C 和群 AT 消息
 */

export interface Env {
  QQ_APP_ID: string;
  QQ_APP_SECRET: string;
  BOT_SECRET: string;           // 用于 Ed25519 签名的种子
  KV?: KVNamespace;             // 可选，用于缓存 access_token
}

// ---------- Ed25519 工具 ----------

function stringToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * 将 BotSecret 转换为 32 字节种子：
 * 重复拼接直到长度 >= 32，然后取前 32 字节
 */
function seedFromSecret(secret: string): Uint8Array {
  let combined = '';
  while (combined.length < 32) combined += secret;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = combined.charCodeAt(i);
  return bytes;
}

/**
 * 从种子导入 Ed25519 私钥（用于签名）
 */
async function importPrivateKey(seed: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    seed,
    { name: 'Ed25519' },
    true,
    ['sign']
  );
}

/**
 * 从种子导入 Ed25519 公钥（用于验证）
 */
async function importPublicKey(seed: Uint8Array): Promise<CryptoKey> {
  // 先从种子生成私钥，再提取公钥
  const privateKey = await importPrivateKey(seed);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  // 删除私钥参数，只保留公钥
  delete jwk.d;
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'Ed25519' },
    true,
    ['verify']
  );
}

/**
 * 验证 QQ 平台推送的 Ed25519 签名
 */
async function verifyQQSignature(
  body: string,
  timestamp: string | null,
  signatureHex: string | null,
  publicKey: CryptoKey
): Promise<boolean> {
  if (!timestamp || !signatureHex) return false;
  const message = stringToBytes(timestamp + body);
  const sig = new Uint8Array(
    signatureHex.match(/.{2}/g)!.map((b) => parseInt(b, 16))
  );
  return crypto.subtle.verify('Ed25519', publicKey, sig, message);
}

/**
 * 对给定数据用私钥签名，返回 hex 字符串
 */
async function signData(data: string, privateKey: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign('Ed25519', privateKey, stringToBytes(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------- QQ API 调用 ----------

let cachedToken: { token: string; expires: number } | null = null;

/**
 * 获取 QQ Bot 的 access_token（带缓存）
 */
async function getAccessToken(env: Env): Promise<string> {
  // 优先从内存缓存读取
  if (cachedToken && Date.now() < cachedToken.expires - 60000) {
    return cachedToken.token;
  }

  // 如果有 KV，尝试从 KV 读取
  if (env.KV) {
    const stored = await env.KV.get('access_token');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Date.now() < parsed.expires - 60000) {
          cachedToken = parsed;
          return parsed.token;
        }
      } catch {}
    }
  }

  // 重新获取
  const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: env.QQ_APP_ID,
      clientSecret: env.QQ_APP_SECRET,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Failed to get access token: ${resp.status} ${await resp.text()}`);
  }

  const data: any = await resp.json();
  const token = data.access_token as string;
  const expiresIn = (data.expires_in as number) || 7200; // 默认两小时
  const expires = Date.now() + expiresIn * 1000;

  const cacheEntry = { token, expires };
  cachedToken = cacheEntry;

  // 写入 KV
  if (env.KV) {
    await env.KV.put('access_token', JSON.stringify(cacheEntry), {
      expirationTtl: expiresIn - 60, // 提前一分钟过期
    });
  }

  return token;
}

/**
 * 发送 C2C 消息
 */
async function sendC2CMessage(
  openid: string,
  content: string,
  msgId: string | undefined,
  token: string
): Promise<void> {
  const body: Record<string, unknown> = {
    content,
    msg_type: 0,
  };
  if (msgId) body.msg_id = msgId;

  const resp = await fetch(
    `https://api.bot.qq.com/v2/users/${openid}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    console.error('Send C2C message failed:', await resp.text());
  }
}

/**
 * 发送群消息
 */
async function sendGroupMessage(
  groupOpenid: string,
  content: string,
  msgId: string | undefined,
  token: string
): Promise<void> {
  const body: Record<string, unknown> = {
    content,
    msg_type: 0,
  };
  if (msgId) body.msg_id = msgId;

  const resp = await fetch(
    `https://api.bot.qq.com/v2/groups/${groupOpenid}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    console.error('Send group message failed:', await resp.text());
  }
}

// ---------- 事件处理 ----------

async function handleEvent(eventType: string, d: any, env: Env): Promise<void> {
  try {
    const token = await getAccessToken(env);

    if (eventType === 'C2C_MESSAGE_CREATE') {
      const userOpenid = d.author.user_openid;
      const content = (d.content || '').replace(/<@!?\d+>/g, '').trim(); // 去除 @ 标记
      const msgId = d.id;

      // ---- 你的业务逻辑 ----
      const reply = `你说了：${content}`;
      await sendC2CMessage(userOpenid, reply, msgId, token);
    } else if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
      const groupOpenid = d.group_openid;
      const userOpenid = d.author.user_openid;
      const content = (d.content || '').replace(/<@!?\d+>/g, '').trim();
      const msgId = d.id;

      // ---- 你的业务逻辑 ----
      const reply = `你艾特了我，你说：${content}`;
      await sendGroupMessage(groupOpenid, reply, msgId, token);
    }
    // 其他事件忽略
  } catch (err) {
    console.error('handleEvent error:', err);
  }
}

// ---------- Worker 入口 ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 只接受 /qq/webhook 路径的 POST 请求
    if (url.pathname !== '/qq/webhook' || request.method !== 'POST') {
      return new Response('Not Found', { status: 404 });
    }

    const rawBody = await request.text();

    // 准备 Ed25519 密钥
    const seed = seedFromSecret(env.BOT_SECRET);
    const publicKey = await importPublicKey(seed);
    const privateKey = await importPrivateKey(seed);

    // 校验签名
    const isValid = await verifyQQSignature(
      rawBody,
      request.headers.get('X-Signature-Timestamp'),
      request.headers.get('X-Signature-Ed25519'),
      publicKey
    );

    if (!isValid) {
      return new Response('Invalid signature', { status: 403 });
    }

    const payload = JSON.parse(rawBody);

    // 处理 op=13 回调验证
    if (payload.op === 13) {
      const { plain_token, event_ts } = payload.d;
      const signature = await signData(event_ts + plain_token, privateKey);
      return Response.json({ plain_token, signature });
    }

    // 处理正常事件 (op=0)
    if (payload.op === 0) {
      const eventType = payload.t as string;
      const eventData = payload.d;

      // 异步处理，立即返回 200 ACK
      ctx.waitUntil(handleEvent(eventType, eventData, env));
      return new Response(null, { status: 204 }); // 204 No Content 也可
    }

    // 未知操作
    return new Response('Unknown operation', { status: 400 });
  },
};