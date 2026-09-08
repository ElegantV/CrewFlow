import { config } from "../config.js";

const TOKEN_URL = "https://api.weixin.qq.com/cgi-bin/token";
const SCHEME_URL = "https://api.weixin.qq.com/wxa/generatescheme";

let cachedToken: { value: string; expiresAt: number } | null = null;
let tokenPromise: Promise<string> | null = null;

async function fetchAccessToken(): Promise<string> {
  const url = new URL(TOKEN_URL);
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", config.WECHAT_APP_ID);
  url.searchParams.set("secret", config.WECHAT_APP_SECRET);
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  const body = await response.json() as { access_token?: string; errcode?: number; errmsg?: string };
  if (!body.access_token) {
    throw new Error(`获取微信 access_token 失败: ${body.errcode} ${body.errmsg}`);
  }
  return body.access_token;
}

// 单飞缓存 access_token（有效期 7200s，提前 2 分钟过期）。
function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 120_000) {
    return Promise.resolve(cachedToken.value);
  }
  if (!tokenPromise) {
    tokenPromise = fetchAccessToken()
      .then((token) => {
        cachedToken = { value: token, expiresAt: Date.now() + 7_000_000 };
        return token;
      })
      .finally(() => {
        tokenPromise = null;
      });
  }
  return tokenPromise;
}

const schemeCache = new Map<string, { value: string; expiresAt: number }>();

// 生成小程序 URL Scheme（微信内点击直达小程序，供 wxpusher 消息"查看链接"使用）。
// 失败返回 null，通知降级为无链接，绝不影响主流程。
export async function generateMiniProgramScheme(path: string, query?: string): Promise<string | null> {
  const key = query ? `${path}?${query}` : path;
  const hit = schemeCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  try {
    const token = await getAccessToken();
    const response = await fetch(SCHEME_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jump_wxa: { path, query },
        is_expire: true,
        expire_type: 1,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = await response.json() as { openlink?: string; errcode?: number; errmsg?: string };
    if (!body.openlink) {
      console.error("生成小程序 scheme 失败", body.errcode, body.errmsg);
      return null;
    }
    schemeCache.set(key, { value: body.openlink, expiresAt: Date.now() + 6 * 3600_000 });
    return body.openlink;
  } catch (error) {
    console.error("生成小程序 scheme 异常", error);
    return null;
  }
}