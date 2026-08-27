import { config } from "./config.js";

const SEND_URL = "https://wxpusher.zjiecode.com/api/send/message";
const QR_CREATE_URL = "https://wxpusher.zjiecode.com/api/fun/create/qrcode";
const QR_SCAN_URL = "https://wxpusher.zjiecode.com/api/fun/scan-qrcode-uid";

export type WxPusherResult = {
  code?: number;
  msg?: string;
  data?: string | Record<string, unknown>;
};

export type WxPusherSendResult = {
  code?: number;
  msg?: string;
  data?: Array<Record<string, unknown>>;
};

// 向指定 UID 推送消息（text 类型，无一次性订阅限制）。
export async function sendWxPusherMessage(
  content: string,
  uids: string[],
  summary?: string,
): Promise<WxPusherSendResult> {
  const response = await fetch(SEND_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      appToken: config.WXPUSHER_APP_TOKEN,
      content,
      summary: summary || content.replace(/\n/g, " ").slice(0, 30),
      contentType: 1,
      uids,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  return await response.json() as WxPusherSendResult;
}

// 创建参数二维码，extra 携带 userId 用于绑定 UID。
export async function createWxPusherQrCode(extra: string, validTime = 1800) {
  const response = await fetch(QR_CREATE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appToken: config.WXPUSHER_APP_TOKEN, extra, validTime }),
    signal: AbortSignal.timeout(8_000),
  });
  return await response.json() as WxPusherResult & {
    data?: { code?: string; url?: string; shortUrl?: string; validTime?: number };
  };
}

// 查询最后一次扫描参数二维码的用户 UID（轮询间隔不得少于 10 秒）。
export async function queryWxPusherScanUid(code: string) {
  const url = new URL(QR_SCAN_URL);
  url.searchParams.set("code", code);
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  return await response.json() as WxPusherResult;
}

// 下载二维码图片为 base64，供本服务代理给小程序展示（避免域名白名单问题）。
export async function fetchWxPusherImageAsBase64(imageUrl: string) {
  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("base64");
}
