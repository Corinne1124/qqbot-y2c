/**
 * QQ 机器人 Cloudflare Worker
 * 使用 QQ 开放平台 Bot Secret 派生 Ed25519 密钥进行签名校验
 */

export interface Env {
  QQ_APP_ID: string;        // 机器人 ID（AppID）
  QQ_APP_SECRET: string;    // 仅用于换取 access_token（OAuth client_secret）
  QQ_BOT_SECRET?: string;   // Webhook 验签 / 回调校验签名用的 Ed25519 种子，缺省回退到 QQ_APP_SECRET
  ENVIRONMENT?: string;     // wrangler.toml 中的环境标记，可选
  DEBUG_KEY?: string;       // 调试接口 /qq/debug 的访问密钥，未设置时该接口不可用
  KV?: KVNamespace;
}

// ---------- Ed25519 密钥派生（基于 Bot Secret） ----------

/** Ed25519 PKCS8 固定前缀 */
const PKCS8_ED25519_PREFIX = [
  0x30, 0x2e, 0x02, 0x01, 0x00,
  0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
];

/**
 * 将 Bot Secret 重复拼接至 32 字节作为 Ed25519 种子
 */
function deriveSeed(secret: string): Uint8Array {
  if (!secret) {
    throw new Error('QQ_BOT_SECRET is not configured');
  }
  let seed = secret;
  while (seed.length < 32) seed += seed;
  seed = seed.slice(0, 32);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = seed.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * 从种子生成 Ed25519 私钥（PKCS8 格式）
 */
async function derivePrivateKey(secret: string): Promise<CryptoKey> {
  const seed = deriveSeed(secret);
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  der.set(PKCS8_ED25519_PREFIX, 0);
  der.set(seed, PKCS8_ED25519_PREFIX.length);
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
}

/**
 * 从私钥导出公钥（用于验签）
 * 只保留 OKP 公钥必需的 kty / crv / x，避免带出 key_ops: ["sign"] 导致导入失败
 */
async function derivePublicKey(privateKey: CryptoKey): Promise<CryptoKey> {
  const jwk = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey;
  const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  return crypto.subtle.importKey('jwk', publicJwk, { name: 'Ed25519' }, true, ['verify']);
}

// ---------- 签名/验签工具 ----------

/** 十六进制字符串转字节，格式非法时返回 null */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 密钥指纹（SHA-256 前 12 位十六进制），用于比对部署的密钥是否与本地一致，不泄露密钥本身 */
async function fingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return bytesToHex(digest).slice(0, 12);
}

/**
 * 验证 QQ 平台推送的请求签名
 * 待签内容：timestamp + body（原始字符串）
 */
async function verifySignature(
  rawBody: string,
  timestamp: string | null,
  sigHex: string | null,
  publicKey: CryptoKey
): Promise<boolean> {
  if (!timestamp || !sigHex) return false;
  const signature = hexToBytes(sigHex);
  if (!signature || signature.length !== 64) return false;
  const message = new TextEncoder().encode(timestamp + rawBody);
  try {
    return await crypto.subtle.verify('Ed25519', publicKey, signature, message);
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
    const detail = await resp.text().catch(() => '');
    throw new Error(`Failed to get access token: ${resp.status} ${detail}`);
  }
  const data: any = await resp.json();
  const token = data.access_token as string;
  const expiresIn = (data.expires_in as number) || 7200;
  const expires = Date.now() + expiresIn * 1000;
  cachedToken = { token, expires };
  if (env.KV) {
    // KV 的 expirationTtl 最小为 60 秒，避免 expiresIn 很小时抛错
    await env.KV.put('access_token', JSON.stringify({ token, expires }), {
      expirationTtl: Math.max(60, expiresIn - 180),
    });
  }
  return token;
}

/** QQ 被动回复同一 msg_id 时 msg_seq 必须递增，单条消息最多回复 5 次 */
const MSG_SEQ_MAX = 5;
const msgSeqCounters = new Map<string, number>();

/**
 * 生成 msg_seq。Worker 无状态，这里是 isolate 内的尽力而为计数：
 * 计数丢失时回落到 1，重发同一条消息仍可正常回复。
 */
function nextMsgSeq(msgId: string): number {
  if (msgSeqCounters.size >= 1024) msgSeqCounters.clear();
  const next = Math.min((msgSeqCounters.get(msgId) ?? 0) + 1, MSG_SEQ_MAX);
  msgSeqCounters.set(msgId, next);
  return next;
}

/** 调试记录：写入 KV 的最近事件，便于在无法使用 wrangler tail 的环境里排查 */
interface DebugEntry {
  ts: string;
  type: string;
  msgId?: string;
  target?: string;
  content?: string;
  ok?: boolean;
  status?: number;
  detail?: string;
  error?: string;
}

const DEBUG_EVENT_LIMIT = 10;

async function recordDebug(env: Env, entry: DebugEntry): Promise<void> {
  if (!env.KV) return;
  try {
    const prevRaw = await env.KV.get('debug:events');
    const prev: DebugEntry[] = prevRaw ? JSON.parse(prevRaw) : [];
    prev.unshift(entry);
    await env.KV.put('debug:events', JSON.stringify(prev.slice(0, DEBUG_EVENT_LIMIT)), {
      expirationTtl: 86400,
    });
  } catch (e) {
    console.error('recordDebug failed:', String(e));
  }
}

interface SendResult {
  ok: boolean;
  status: number;
  detail?: string;
}

/**
 * 发送消息（被动回复必须带 msg_id 与 msg_seq）
 */
async function postMessage(
  apiPath: string,
  content: string,
  msgId: string | undefined,
  token: string
): Promise<SendResult> {
  const body: Record<string, unknown> = { content, msg_type: 0 };
  if (msgId) {
    body.msg_id = msgId;
    body.msg_seq = nextMsgSeq(msgId);
  }
  const resp = await fetch(`https://api.bot.qq.com${apiPath}`, {
    method: 'POST',
    headers: {
      Authorization: `QQBot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.error(`Send message failed (${resp.status} ${resp.statusText}): ${detail}`);
    return { ok: false, status: resp.status, detail: detail.slice(0, 500) };
  }
  return { ok: true, status: resp.status };
}

function sendC2CMessage(
  openid: string,
  content: string,
  msgId: string | undefined,
  token: string
): Promise<SendResult> {
  return postMessage(`/v2/users/${encodeURIComponent(openid)}/messages`, content, msgId, token);
}

function sendGroupMessage(
  groupOpenid: string,
  content: string,
  msgId: string | undefined,
  token: string
): Promise<SendResult> {
  return postMessage(`/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, content, msgId, token);
}

// ---------- 事件处理 ----------

async function handleEvent(eventType: string, d: any, env: Env) {
  const msgId = d?.id as string | undefined;
  const ts = new Date().toISOString();
  try {
    const token = await getAccessToken(env);
    const content = String(d?.content ?? '').replace(/<@!?\d+>/g, '').trim();
    if (eventType === 'C2C_MESSAGE_CREATE') {
      const openid = d?.author?.user_openid;
      if (!openid) throw new Error('missing d.author.user_openid');
      const result = await sendC2CMessage(openid, `你说了：${content}`, msgId, token);
      await recordDebug(env, { ts, type: eventType, msgId, target: openid, content, ...result });
      if (result.ok) console.log('replied C2C', { msgId, openid });
      else console.error('Failed to reply C2C message', { msgId, openid, detail: result.detail });
    } else if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
      const groupOpenid = d?.group_openid;
      if (!groupOpenid) throw new Error('missing d.group_openid');
      const result = await sendGroupMessage(groupOpenid, `你在群里说：${content}`, msgId, token);
      await recordDebug(env, { ts, type: eventType, msgId, target: groupOpenid, content, ...result });
      if (result.ok) console.log('replied GROUP', { msgId, groupOpenid });
      else console.error('Failed to reply group message', { msgId, groupOpenid, detail: result.detail });
    } else {
      await recordDebug(env, { ts, type: eventType, msgId, content });
      console.log('ignore event type', eventType);
    }
  } catch (e) {
    await recordDebug(env, { ts, type: eventType, msgId, content: String(d?.content ?? ''), error: String(e) });
    console.error('handleEvent error:', { eventType, msgId, error: String(e) });
  }
}

// ---------- Worker 入口 ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 调试接口（不依赖 wrangler tail；需在环境变量里设置 DEBUG_KEY，且建议绑定 KV 才有事件记录）
    if (url.pathname === '/qq/debug' && request.method === 'GET') {
      if (!env.DEBUG_KEY || url.searchParams.get('key') !== env.DEBUG_KEY) {
        return new Response('Not Found', { status: 404 });
      }
      const secret = env.QQ_BOT_SECRET || env.QQ_APP_SECRET;
      let events: DebugEntry[] | null = null;
      if (env.KV) {
        const raw = await env.KV.get('debug:events');
        events = raw ? JSON.parse(raw) : [];
      }
      const result: Record<string, unknown> = {
        now: new Date().toISOString(),
        kvBound: Boolean(env.KV),
        secretConfigured: Boolean(secret),
        secretLength: secret?.length ?? 0,
        secretFingerprint: secret ? await fingerprint(secret) : null,
        events,
      };
      if (url.searchParams.get('selftest') === '1') {
        try {
          const token = await getAccessToken(env);
          result.token = { ok: true, length: token.length };
        } catch (e) {
          result.token = { ok: false, error: String(e) };
        }
      }
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (url.pathname !== '/qq/webhook' || request.method !== 'POST') {
      return new Response('Not Found', { status: 404 });
    }

    // 验签密钥：优先 QQ_BOT_SECRET；部分机器人（如只发放 AppSecret 的）回退到 QQ_APP_SECRET
    const botSecret = env.QQ_BOT_SECRET || env.QQ_APP_SECRET;
    if (!botSecret) {
      console.error('Neither QQ_BOT_SECRET nor QQ_APP_SECRET is configured');
      return new Response('Server misconfigured', { status: 500 });
    }

    // 重要：先读取原始 body，不要提前 JSON.parse
    const rawBody = await request.text();

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return new Response('Invalid payload', { status: 400 });
    }

    // 派生私钥
    const privateKey = await derivePrivateKey(botSecret);

    // 回调地址验证 (op=13)：平台该请求不带 X-Signature-* 头，只要求返回签名
    if (payload.op === 13) {
      const { plain_token, event_ts } = payload.d ?? {};
      if (!plain_token || !event_ts) {
        return new Response('Invalid challenge payload', { status: 400 });
      }
      const signature = await signForChallenge(event_ts + plain_token, privateKey);
      return Response.json({ plain_token, signature });
    }

    // 其余请求（事件推送）必须验签
    const timestamp = request.headers.get('X-Signature-Timestamp');
    const sigHex = request.headers.get('X-Signature-Ed25519');
    const publicKey = await derivePublicKey(privateKey);
    if (!(await verifySignature(rawBody, timestamp, sigHex, publicKey))) {
      // 只打印非敏感信息，便于和本地 .dev.vars 的 fingerprint 对照，确认部署的密钥是否正确
      console.error('Signature verification failed', {
        op: payload.op,
        appIdHeader: request.headers.get('X-Bot-Appid'),
        hasTimestamp: Boolean(timestamp),
        hasSignature: Boolean(sigHex),
        signatureLength: sigHex?.length ?? 0,
        bodyLength: rawBody.length,
        secretLength: botSecret.length,
        secretFingerprint: await fingerprint(botSecret),
      });
      return new Response('Invalid signature', { status: 403 });
    }

    // 正常事件 (op=0)
    if (payload.op === 0) {
      console.log('event received', { type: payload.t, id: payload.d?.id });
      ctx.waitUntil(handleEvent(payload.t, payload.d, env));
      return new Response(null, { status: 204 });
    }

    return new Response('Unknown operation', { status: 400 });
  },
};
