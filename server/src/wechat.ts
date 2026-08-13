import { config } from "./config.js";

// access_token 有效期 7200 秒，这里缓存并在过期前 60 秒刷新。
let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", config.WECHAT_APP_ID);
  url.searchParams.set("secret", config.WECHAT_APP_SECRET);
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  const body = await response.json() as {
    access_token?: string;
    expires_in?: number;
    errcode?: number;
    errmsg?: string;
  };
  if (!body.access_token) {
    throw new Error(`WeChat access_token failed: ${body.errcode} ${body.errmsg}`);
  }
  const expiresIn = body.expires_in ?? 7_200;
  cachedToken = { value: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return cachedToken.value;
}

export type SubscribeSendResult = {
  errcode?: number;
  errmsg?: string;
  msgid?: number;
};

export type SubscribeMessageData = Record<string, { value: string }>;

export async function sendSubscribeMessage(
  openid: string,
  templateId: string,
  data: SubscribeMessageData,
  page: string,
): Promise<SubscribeSendResult> {
  const token = await getAccessToken();
  const response = await fetch(
    `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        touser: openid,
        template_id: templateId,
        page,
        miniprogram_state: config.WECHAT_SUBSCRIBE_STATE,
        data,
      }),
      signal: AbortSignal.timeout(8_000),
    },
  );
  return await response.json() as SubscribeSendResult;
}
