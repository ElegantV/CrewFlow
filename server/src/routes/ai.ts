import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { loadActiveActor } from "../authz.js";
import { config } from "../config.js";
import { db } from "../db.js";

const chatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(2000),
  })).min(1).max(20),
});

const upstreamChoiceSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().optional() }),
  })).min(1),
});

// 大模型输出只作为回答文本返回给前端展示,永远不在这里解析成指令或直接执行任何操作;
// 系统功能(请假/加班/审批等)仍由小程序端的规则引擎走既有业务接口。
function buildSystemPrompt(name: string | null, role: string) {
  const roleLabel = role === "super_admin" ? "超级管理员" : role === "admin" ? "管理员" : "普通用户";
  return [
    "你是「简序日程助手」，一个企业考勤与日程小程序里的 AI 问答助手。",
    "用户已主动开启深度问答，你可以回答工作相关或任何其他领域的复杂问题。",
    `当前用户：${name || "未命名用户"}（${roleLabel}）。可以自然地在回答中引用其姓名，但不要编造其考勤、请假、审批等内部数据——你没有查询这些数据的工具。`,
    "如果用户要求办理请假、加班、审批等系统操作，请引导用户直接用简短指令（如「8月13号请一天调休假」）在对话里发送，系统会自动识别并执行；不要声称自己已经执行了任何操作。",
    "用简体中文回答，语气简洁专业，纯文本输出，不要使用 Markdown 标记。",
  ].join("\n");
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  const protectedHooks = { onRequest: [app.authenticate, loadActiveActor] };

  app.post("/chat", {
    ...protectedHooks,
    // AI 调用有真实成本,单独收紧限流;全局 300/分钟 的兜底仍然生效。
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (!config.AI_API_KEY) {
      return reply.code(503).send({ code: "AI_NOT_CONFIGURED", message: "AI 问答未配置，请联系管理员" });
    }

    const enabled = await db.query<{ ai_agent_enabled: boolean }>(
      "SELECT ai_agent_enabled FROM users WHERE id = $1",
      [request.actor!.id],
    );
    if (!enabled.rows[0]?.ai_agent_enabled) {
      return reply.code(403).send({ code: "AI_DISABLED", message: "请先在「个人信息」中开启 AI 深度问答" });
    }

    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_CHAT", message: "对话内容无效" });
    }

    const profile = await db.query<{ name: string | null; role: string }>(
      "SELECT name, role FROM users WHERE id = $1",
      [request.actor!.id],
    );
    const user = profile.rows[0]!;

    let response: Response;
    try {
      response = await fetch(config.AI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.AI_API_KEY}`,
        },
        body: JSON.stringify({
          model: config.AI_MODEL,
          messages: [
            { role: "system", content: buildSystemPrompt(user.name, user.role) },
            ...parsed.data.messages,
          ],
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      request.log.warn({ err: error }, "AI upstream request failed");
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      return reply.code(504).send({
        code: "AI_UPSTREAM_TIMEOUT",
        message: isTimeout ? "AI 回答超时，请稍后重试" : "AI 服务暂时不可用，请稍后重试",
      });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      request.log.warn({ status: response.status, detail: detail.slice(0, 500) }, "AI upstream returned error");
      return reply.code(502).send({ code: "AI_UPSTREAM_ERROR", message: "AI 服务暂时不可用，请稍后重试" });
    }

    const payload = upstreamChoiceSchema.safeParse(await response.json().catch(() => null));
    const content = payload.success ? payload.data.choices[0]?.message?.content?.trim() : "";
    if (!content) {
      request.log.warn("AI upstream response missing content");
      return reply.code(502).send({ code: "AI_UPSTREAM_ERROR", message: "AI 未返回有效回答，请稍后重试" });
    }
    return { reply: content };
  });
};
