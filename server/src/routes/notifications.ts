import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { loadActiveActor } from "../authz.js";
import { config } from "../config.js";
import { db } from "../db.js";

const subscribeSchema = z.object({
  templateId: z.string().min(1),
});

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  const protectedHooks = { onRequest: [app.authenticate, loadActiveActor] };

  app.get("/config", protectedHooks, async () => ({
    enabled: Boolean(config.WECHAT_SUBSCRIBE_TEMPLATE_ID),
    templateId: config.WECHAT_SUBSCRIBE_TEMPLATE_ID,
  }));

  app.post("/subscribe", protectedHooks, async (request, reply) => {
    const parsed = subscribeSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.templateId !== config.WECHAT_SUBSCRIBE_TEMPLATE_ID) {
      return reply.code(400).send({ code: "INVALID_TEMPLATE", message: "订阅模板配置无效" });
    }
    const actor = request.actor!;
    await db.query(
      `INSERT INTO notification_subscriptions (user_id, template_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, template_id) DO NOTHING`,
      [actor.id, parsed.data.templateId],
    );
    return { success: true };
  });
};
