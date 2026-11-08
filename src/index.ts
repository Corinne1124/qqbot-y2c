/**
 * QQ 机器人 Cloudflare Worker
 * 使用 QQ 开放平台 Bot Secret 派生 Ed25519 密钥进行签名校验
 */

export interface Env {
  QQ_APP_ID: string;
  QQ_APP_SECRET: string;   // Bot Secret
  KV?: KVNamespace;
}

// ---------- Ed25519 密钥派生（基于 Bot Secret） ----------

/**
 * 将 Bot Secret 重复拼接至 32 字节作为 Ed25519 种子
 */
function deriveSeed(secret: string): Uint8Array {
  let seed = secret;
  while (seed.length < 32) seed += seed;
  seed = seed.slice(0, 32);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = seed.charCodeAt(i);
  return bytes;
}

/**
 * 从种子生成 Ed25519 私钥（PKCS8 格式）
 */
async function derivePrivateKey(secret: string): Promise<CryptoKey> {
  const seed = deriveSeed(secret);
  // Ed25519 PKCS8 固定前缀 (30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20) + 32字节种子
  const prefix = [
    0x30, 0x2e, 0x02, 0x01, 0x00,
    0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20
  ];
  const der = new Uint8Array(prefix.length + 32);
  der.set(prefix, 0);
  der.set(seed, prefix.length);
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
}

/**
 * 从私钥导出公钥（用于验签）
 */
async function derivePublicKey(privateKey: CryptoKey): Promise<CryptoKey> {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  delete (jwk as any).d;  // 移除私钥参数
  return crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, true, ['verify']);
}

// ---------- 签名/验签工具 ----------

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
}

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 验证 QQ 平台推送的正常事件签名
 * 待签内容：timestamp + body（原始字符串）
 */
async function verifySignature(
  rawBody: string,
  timestamp: string | null,
  sigHex: string | null,
  publicKey: CryptoKey
): Promise<boolean> {
  if (!timestamp || !sigHex) return false;
  const message = new TextEncoder().encode(timestamp + rawBody);
  try {
    return await crypto.subtle.verify('Ed25519', publicKey, hexToBytes(sigHex), message);
  } catch {
    return false;
  }
}

/**
 * 对回调验证数据签名
 * 待签内容：event_ts + plain_token
 */
async function signForChallenge(data: string, privateKey: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(data));
  return bytesToHex(sig);
}

// ---------- QQ API 调用 ----------

let cachedToken: { token: string; expires: number } | null = null;

async function getAccessToken(env: Env): Promise<string> {
  // 内存缓存
  if (cachedToken && Date.now() < cachedToken.expires - 60000) {
    return cachedToken.token;
  }
  // KV 缓存
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
    throw new Error(`Failed to get access token: ${resp.status}`);
  }
  const data: any = await resp.json();
  const token = data.access_token as string;
  const expiresIn = (data.expires_in as number) || 7200;
  const expires = Date.now() + expiresIn * 1000;
  cachedToken = { token, expires };
  if (env.KV) {
    await env.KV.put('access_token', JSON.stringify({ token, expires }), {
      expirationTtl: expiresIn - 180,
    });
  }
  return token;
}

async function sendC2CMessage(openid: string, content: string, msgId: string | undefined, token: string) {
  const body: Record<string, unknown> = { content, msg_type: 0 };
  if (msgId) body.msg_id = msgId;
  await fetch(`https://api.bot.qq.com/v2/users/${openid}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `QQBot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function sendGroupMessage(groupOpenid: string, content: string, msgId: string | undefined, token: string) {
  const body: Record<string, unknown> = { content, msg_type: 0 };
  if (msgId) body.msg_id = msgId;
  await fetch(`https://api.bot.qq.com/v2/groups/${groupOpenid}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `QQBot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

// ---------- 事件处理 ----------

async function handleEvent(eventType: string, d: any, env: Env) {
  try {
    const token = await getAccessToken(env);
    if (eventType === 'C2C_MESSAGE_CREATE') {
      const content = (d.content || '').replace(/<@!?\d+>/g, '').trim();
      const reply = `你说了：${content}`;
      await sendC2CMessage(d.author.user_openid, reply, d.id, token);
    } else if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
      const content = (d.content || '').replace(/<@!?\d+>/g, '').trim();
      const reply = `你在群里说：${content}`;
      await sendGroupMessage(d.group_openid, reply, d.id, token);
    }
  } catch (e) {
    console.error('handleEvent error:', e);
  }
}

// ---------- Worker 入口 ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/qq/webhook' || request.method !== 'POST') {
      return new Response('Not Found', { status: 404 });
    }

    // 重要：先读取原始 body，不要提前 JSON.parse
    const rawBody = await request.text();

    // 派生密钥
    const privateKey = await derivePrivateKey(env.QQ_APP_SECRET);
    const publicKey = await derivePublicKey(privateKey);

    // 获取签名头
    const timestamp = request.headers.get('X-Signature-Timestamp');
    const sigHex = request.headers.get('X-Signature-Ed25519');

    // 验签（正常事件）
    const isValid = await verifySignature(rawBody, timestamp, sigHex, publicKey);
    if (!isValid) {
      console.error('Signature verification failed');
      return new Response('Invalid signature', { status: 403 });
    }

    const payload = JSON.parse(rawBody);

    // 回调地址验证 (op=13)
    if (payload.op === 13) {
      const { plain_token, event_ts } = payload.d;
      const signature = await signForChallenge(event_ts + plain_token, privateKey);
      return Response.json({ plain_token, signature });
    }

    // 正常事件 (op=0)
    if (payload.op === 0) {
      ctx.waitUntil(handleEvent(payload.t, payload.d, env));
      return new Response(null, { status: 204 });
    }

    return new Response('Unknown operation', { status: 400 });
  },
};