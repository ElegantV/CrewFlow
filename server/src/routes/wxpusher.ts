import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { loadActiveActor } from "../authz.js";
import { config } from "../config.js";
import { db } from "../db.js";
import {
  createWxPusherQrCode,
  fetchWxPusherImageAsBase64,
  queryWxPusherScanUid,
  sendWxPusherMessage,
} from "../wxpusher.js";

function randomToken() {
  // 密码学随机:二维码拉取接口是公开的,token 可预测即可拉取他人绑定二维码,
  // Math.random+时间戳的组合熵不足且可缩小猜测空间。
  return randomBytes(12).toString("base64url");
}

export const wxpusherRoutes: FastifyPluginAsync = async (app) => {
  const protectedHooks = { onRequest: [app.authenticate, loadActiveActor] };

  // 当前绑定状态
  app.get("/status", protectedHooks, async (request) => {
    const actor = request.actor!;
    const result = await db.query<{ uid: string | null }>(
      "SELECT uid FROM wxpusher_bindings WHERE user_id = $1",
      [actor.id],
    );
    const uid = result.rows[0]?.uid ?? null;
    return {
      enabled: Boolean(config.WXPUSHER_APP_TOKEN),
      bound: Boolean(uid),
      uid: uid ? `${uid.slice(0, 7)}…${uid.slice(-3)}` : null,
    };
  });

  // 生成扫码绑定二维码
  app.post("/qr", protectedHooks, async (request, reply) => {
    if (!config.WXPUSHER_APP_TOKEN) {
      return reply.code(400).send({ code: "WXPUSHER_DISABLED", message: "微信推送未配置" });
    }
    const actor = request.actor!;
    const created = await createWxPusherQrCode(actor.id, 1800);
    if (created.code !== 1000 || !created.data?.code) {
      return reply.code(502).send({ code: "WXPUSHER_ERROR", message: created.msg || "获取二维码失败" });
    }
    let qrData: string | null = null;
    const imageUrl = created.data.url ?? created.data.shortUrl;
    if (imageUrl) {
      qrData = await fetchWxPusherImageAsBase64(imageUrl);
    }
    const qrToken = randomToken();
    await db.query(
      `INSERT INTO wxpusher_bindings (user_id, qr_token, qr_data, wxpusher_code, follow_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET qr_token = EXCLUDED.qr_token, qr_data = EXCLUDED.qr_data,
             wxpusher_code = EXCLUDED.wxpusher_code, follow_url = EXCLUDED.follow_url,
             updated_at = now()`,
      [actor.id, qrToken, qrData, created.data.code ?? null, imageUrl ?? null],
    );
    return { qrToken };
  });

  // 公开二维码图片接口（token 随机不可猜测）
  app.get("/qr/:token", async (request, reply) => {
    const token = z.string().min(1).safeParse((request.params as { token?: string }).token);
    if (!token.success) return reply.code(404).send();
    const result = await db.query<{ qr_data: string | null }>(
      "SELECT qr_data FROM wxpusher_bindings WHERE qr_token = $1",
      [token.data],
    );
    const data = result.rows[0]?.qr_data;
    if (!data) return reply.code(404).send();
    return reply.type("image/png").send(Buffer.from(data, "base64"));
  });

  // 轮询扫码结果并完成绑定（前端每 10 秒调用一次）
  app.post("/check", protectedHooks, async (request) => {
    const actor = request.actor!;
    const result = await db.query<{ uid: string | null; wxpusher_code: string | null }>(
      "SELECT uid, wxpusher_code FROM wxpusher_bindings WHERE user_id = $1",
      [actor.id],
    );
    const binding = result.rows[0];
    if (!binding) return { bound: false };
    if (binding.uid) return { bound: true, uid: `${binding.uid.slice(0, 7)}…${binding.uid.slice(-3)}` };
    if (!config.WXPUSHER_APP_TOKEN || !binding.wxpusher_code) return { bound: false };

    const scanned = await queryWxPusherScanUid(binding.wxpusher_code);
    // scan-qrcode-uid 返回 data 为字符串 "UID_xxx"，不是对象。
    const uid = typeof scanned.data === "string" ? scanned.data : (scanned.data as Record<string, unknown>)?.uid as string | undefined;
    if (scanned.code === 1000 && uid) {
      await db.query(
        "UPDATE wxpusher_bindings SET uid = $1, updated_at = now() WHERE user_id = $2",
        [uid, actor.id],
      );
      return { bound: true, uid: `${uid.slice(0, 7)}…${uid.slice(-3)}` };
    }
    return { bound: false };
  });

  // 解绑
  app.post("/unbind", protectedHooks, async (request) => {
    const actor = request.actor!;
    await db.query("UPDATE wxpusher_bindings SET uid = NULL, updated_at = now() WHERE user_id = $1", [actor.id]);
    return { success: true };
  });

  // 发送测试消息
  app.post("/test", protectedHooks, async (request, reply) => {
    const actor = request.actor!;
    const result = await db.query<{ uid: string | null }>(
      "SELECT uid FROM wxpusher_bindings WHERE user_id = $1",
      [actor.id],
    );
    const uid = result.rows[0]?.uid;
    if (!uid) return reply.code(409).send({ code: "NOT_BOUND", message: "尚未绑定微信推送" });
    const sent = await sendWxPusherMessage("【简序日程】这是一条测试推送，绑定成功。", [uid]);
    if (sent.code !== 1000) {
      return reply.code(502).send({ code: "WXPUSHER_ERROR", message: sent.msg || "发送失败" });
    }
    return { success: true, sendRecordId: sent.data?.[0]?.sendRecordId ?? null };
  });
};
