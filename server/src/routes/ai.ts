import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { allowRoles, loadActiveActor } from "../authz.js";
import { config } from "../config.js";
import { calendarExceptions } from "../business/calendar.js";
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

const upstreamDeltaSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({ content: z.string().optional() }).optional(),
  })).min(1),
});

type AiConfig = {
  apiUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  maxReplyChars: number;
  systemPrompt: string;
};

// 配置存于 ai_config 单行表,空字段沿用 .env 默认值;管理员可在小程序内修改,免登服务器。
async function loadAiConfig(): Promise<AiConfig> {
  const result = await db.query<{
    model: string;
    api_url: string;
    api_key: string;
    max_tokens: number;
    max_reply_chars: number;
    system_prompt: string;
  }>(
    "SELECT model, api_url, api_key, max_tokens, max_reply_chars, system_prompt FROM ai_config WHERE id = 1",
  );
  const row = result.rows[0];
  return {
    apiUrl: row?.api_url || config.AI_API_URL,
    apiKey: row?.api_key || config.AI_API_KEY,
    model: row?.model || config.AI_MODEL,
    maxTokens: row?.max_tokens || 400,
    maxReplyChars: row?.max_reply_chars || 120,
    systemPrompt: row?.system_prompt || "",
  };
}

// 节假日名称按起始月份映射,与 holiday-cn 同步入库的日期数据配合使用。
const HOLIDAY_NAMES: Record<number, string> = {
  1: "元旦", 2: "春节", 4: "清明节", 5: "劳动节", 6: "端午节", 9: "中秋节", 10: "国庆节",
};

function beijingDateParts(date = new Date()) {
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
  const [year, month, day] = iso.split("-").map(Number);
  const weekday = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][
    new Date(`${iso}T00:00:00Z`).getUTCDay()
  ];
  return { iso, year, month, day, weekday };
}

function monthDay(iso: string) {
  const [, month, day] = iso.split("-").map(Number);
  return `${month}月${day}日`;
}

// 把法定节假日按连续日期聚合为区间并给出名称;跳过已过去的区间,标注下一个即将到来的节假日。
// 数据来自 calendar_days( holiday-cn 同步 + 管理员手工覆盖)。
function describeHolidaySchedule(todayIso: string) {
  const { holidays, makeups } = calendarExceptions();
  const ranges: Array<{ start: string; end: string }> = [];
  for (const iso of holidays) {
    const last = ranges[ranges.length - 1];
    const prevDay = new Date(`${last?.end ?? iso}T00:00:00Z`);
    prevDay.setUTCDate(prevDay.getUTCDate() + 1);
    const prevIso = prevDay.toISOString().slice(0, 10);
    if (last && prevIso === iso) last.end = iso;
    else ranges.push({ start: iso, end: iso });
  }
  const holidayLine = ranges
    .map((range) => `${HOLIDAY_NAMES[Number(range.start.split("-")[1])] ?? "法定节假日"}：${monthDay(range.start)}${range.end !== range.start ? `至${monthDay(range.end)}` : ""}`)
    .join("；");
  const makeupLine = makeups.length ? `\n调休上班日：${makeups.map(monthDay).join("、")}。` : "";
  const next = ranges.find((range) => range.end >= todayIso);
  let nextLine = "";
  if (next) {
    const days = Math.round(
      (new Date(`${next.start}T00:00:00Z`).getTime() - new Date(`${todayIso}T00:00:00Z`).getTime()) / 86_400_000,
    );
    const name = HOLIDAY_NAMES[Number(next.start.split("-")[1])] ?? "法定节假日";
    nextLine = `下一个法定节假日是${name}（${monthDay(next.start)}${next.end !== next.start ? `至${monthDay(next.end)}` : ""}），还有 ${days} 天。`;
  }
  return `以下是国务院办公厅公布的法定节假日安排（含调休上班日），回答日期类问题时必须以此为准：\n法定节假日：${holidayLine}。${makeupLine}\n${nextLine}`;
}

// 系统提示词:回答严格限定在本小程序的考勤日程领域,无关问题礼貌拒绝,并强制控制篇幅。
// 管理员可通过 ai_config.system_prompt 整体覆盖默认提示词。
function buildSystemPrompt(name: string | null, role: string, ai: AiConfig) {
  const roleLabel = role === "super_admin" ? "超级管理员" : role === "admin" ? "管理员" : "普通用户";
  const scope = ai.systemPrompt.trim() || [
    "你只回答与本小程序功能相关的问题：请假、调休、加班、审批流程、通讯录、个人考勤与日程。",
    "与小程序功能无关的问题（天气、新闻、闲聊、其他领域知识等），礼貌说明你只能协助考勤日程相关事宜，并用一句话引导回正题。",
  ].join("\n");
  const today = beijingDateParts();
  return [
    `你是「简序日程助手」，一个企业考勤与日程小程序的 AI 助手。当前用户：${name || "未命名用户"}（${roleLabel}）。`,
    `今天是 ${today.iso}（${today.weekday}，北京时间）。`,
    describeHolidaySchedule(today.iso),
    scope,
    "不要编造用户的考勤、请假、审批等内部数据——你没有查询这些数据的工具。",
    "如果用户想办理业务（请假、加班、审批等），引导他们直接发送简短指令（如「8月13号请一天调休假」），系统会自动识别执行；不要声称自己执行了任何操作。",
    `回答必须非常简洁：不超过 ${ai.maxReplyChars} 字，直接给结论，不写铺垫、不列长清单、不使用 Markdown 标记。`,
  ].join("\n");
}

// 硬性截断:即使模型超长也保证返回不超过 maxReplyChars。
function truncateReply(text: string, maxChars: number) {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars).trimEnd() + "…";
}

function wantsStream(request: FastifyRequest) {
  return String(request.headers.accept || "").includes("text/event-stream");
}

function startSse(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  return {
    send(payload: Record<string, unknown>) {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    end() {
      reply.raw.end();
    },
    onAbort(handler: () => void) {
      reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) handler();
      });
    },
  };
}

// 解析上游 OpenAI 兼容 SSE:逐行提取 data: 帧里的 delta.content,遇 [DONE] 结束。
async function* upstreamDeltas(response: Response) {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const parsed = upstreamDeltaSchema.safeParse(JSON.parse(payload));
        const text = parsed.success ? parsed.data.choices[0]?.delta?.content : undefined;
        if (text) yield text;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// AI 有真实成本,限流按登录用户计数而非 IP:同一出口 IP 后面可能是多个正常用户,
// 而 IP 维度在伪造 XFF 时也不可靠;未鉴权的极端情况回落到 request.ip。
const aiRateLimitKey = (request: FastifyRequest) => `user:${request.actor?.id ?? request.ip}`;

export const aiRoutes: FastifyPluginAsync = async (app) => {
  const protectedHooks = { onRequest: [app.authenticate, loadActiveActor] };
  const adminHooks = { onRequest: [app.authenticate, loadActiveActor, allowRoles("super_admin")] };

  app.post("/chat", {
    ...protectedHooks,
    // AI 调用有真实成本,单独收紧限流;groupId 隔离计数器,避免与登录等其他限流路由互吃额度。
    config: { rateLimit: { max: 10, timeWindow: "1 minute", groupId: "ai-chat", keyGenerator: aiRateLimitKey } },
  }, async (request, reply) => {
    const ai = await loadAiConfig();
    if (!ai.apiKey) {
      return reply.code(503).send({ code: "AI_NOT_CONFIGURED", message: "AI 问答未配置，请联系管理员" });
    }

    const enabled = await db.query<{ ai_agent_enabled: boolean }>(
      "SELECT ai_agent_enabled FROM users WHERE id = $1",
      [request.actor!.id],
    );
    if (!enabled.rows[0]?.ai_agent_enabled) {
      return reply.code(403).send({ code: "AI_DISABLED", message: "请先开启 AI 深度问答" });
    }

    // 宽容清洗而非直接拒绝:历史消息可能带出空文本/超长内容,剔除无效条目、截断超长,
    // 清洗后为空才返回 400,并记录请求体摘要便于定位客户端问题。
    const rawMessages = Array.isArray((request.body as any)?.messages) ? (request.body as any).messages : [];
    const sanitized = rawMessages
      .filter((item: any) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
      .map((item: any) => ({ role: item.role, content: String(item.content).trim().slice(0, 2000) }))
      .filter((item: { content: string }) => item.content.length > 0);
    const parsed = chatSchema.safeParse({ messages: sanitized });
    if (!parsed.success) {
      request.log.warn(
        { bodyPreview: JSON.stringify(request.body)?.slice(0, 600), issues: parsed.error.issues },
        "AI chat payload rejected",
      );
      return reply.code(400).send({ code: "INVALID_CHAT", message: "对话内容无效" });
    }

    const profile = await db.query<{ name: string | null; role: string }>(
      "SELECT name, role FROM users WHERE id = $1",
      [request.actor!.id],
    );
    const user = profile.rows[0]!;

    const stream = wantsStream(request);
    const abortController = new AbortController();
    if (stream) {
      const sse = startSse(reply);
      sse.onAbort(() => abortController.abort());
      try {
        const upstream = await fetch(ai.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ai.apiKey}`,
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            model: ai.model,
            messages: [
              { role: "system", content: buildSystemPrompt(user.name, user.role, ai) },
              ...parsed.data.messages,
            ],
            max_tokens: ai.maxTokens,
            stream: true,
          }),
          signal: abortController.signal,
        });
        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => "");
          request.log.warn({ status: upstream.status, detail: detail.slice(0, 500) }, "AI upstream returned error");
          sse.send({ type: "error", message: "AI 服务暂时不可用，请稍后重试" });
          sse.end();
          return;
        }
        let full = "";
        for await (const delta of upstreamDeltas(upstream)) {
          full += delta;
          sse.send({ type: "delta", text: delta });
          if (full.length >= ai.maxReplyChars + 50) {
            abortController.abort();
            break;
          }
        }
        const replyText = truncateReply(full, ai.maxReplyChars);
        if (replyText) sse.send({ type: "result", text: replyText });
        else sse.send({ type: "error", message: "AI 未返回有效回答，请稍后重试" });
      } catch (error) {
        if (!abortController.signal.aborted) {
          request.log.warn({ err: error }, "AI upstream request failed");
          sse.send({ type: "error", message: "AI 服务暂时不可用，请稍后重试" });
        }
      } finally {
        if (!reply.raw.writableEnded) sse.end();
      }
      return;
    }

    // 非流式 JSON 模式:兼容测试与降级场景。
    let response: Response;
    try {
      response = await fetch(ai.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ai.apiKey}`,
        },
        body: JSON.stringify({
          model: ai.model,
          messages: [
            { role: "system", content: buildSystemPrompt(user.name, user.role, ai) },
            ...parsed.data.messages,
          ],
          max_tokens: ai.maxTokens,
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
    return { reply: truncateReply(content, ai.maxReplyChars) };
  });

  app.post("/classify", {
    ...protectedHooks,
    // 每条开启深度问答的消息都会先分类一次,限流比 /chat 稍宽,计数器独立于 /chat。
    config: { rateLimit: { max: 30, timeWindow: "1 minute", groupId: "ai-classify", keyGenerator: aiRateLimitKey } },
  }, async (request, reply) => {
    const ai = await loadAiConfig();
    if (!ai.apiKey) {
      return reply.code(503).send({ code: "AI_NOT_CONFIGURED", message: "AI 问答未配置，请联系管理员" });
    }

    const enabled = await db.query<{ ai_agent_enabled: boolean }>(
      "SELECT ai_agent_enabled FROM users WHERE id = $1",
      [request.actor!.id],
    );
    if (!enabled.rows[0]?.ai_agent_enabled) {
      return reply.code(403).send({ code: "AI_DISABLED", message: "请先开启 AI 深度问答" });
    }

    const parsed = z.object({ text: z.string().trim().min(1).max(500) }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_CHAT", message: "消息内容无效" });
    }

    let response: Response;
    try {
      response = await fetch(ai.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ai.apiKey}`,
        },
        body: JSON.stringify({
          model: ai.model,
          messages: [
            { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
            { role: "user", content: parsed.data.text },
          ],
          max_tokens: 60,
        }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      request.log.warn({ err: error }, "AI classify request failed");
      return reply.code(504).send({ code: "AI_UPSTREAM_TIMEOUT", message: "AI 服务暂时不可用，请稍后重试" });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      request.log.warn({ status: response.status, detail: detail.slice(0, 300) }, "AI classify upstream error");
      return reply.code(502).send({ code: "AI_UPSTREAM_ERROR", message: "AI 服务暂时不可用，请稍后重试" });
    }

    const payload = upstreamChoiceSchema.safeParse(await response.json().catch(() => null));
    const content = payload.success ? payload.data.choices[0]?.message?.content?.trim() : "";
    const route = content ? parseClassifyReply(content) : null;
    if (!route) {
      request.log.warn({ content: content?.slice(0, 200) }, "AI classify returned unusable reply");
      return reply.code(502).send({ code: "AI_UPSTREAM_ERROR", message: "AI 服务暂时不可用，请稍后重试" });
    }
    return { route };
  });
};

// 意图分类器:开启深度问答后,每条消息先经此判定 command(走规则引擎执行)还是 chat(直接回答)。
// 分类结果只是路由信号,系统操作始终由规则引擎与业务接口执行。
const CLASSIFY_SYSTEM_PROMPT = [
  "你是企业考勤小程序「简序日程助手」的意图分类器。只输出一行 JSON，不输出任何其他文字、不用代码块包裹。",
  '输出格式：{"route":"command"} 或 {"route":"chat"}。',
  '- "command"：用户想执行系统操作或查询系统内数据。系统能力包括：创建/撤销请假申请、登记/撤销加班、查询自己的调休余额/加班记录/请假记录、按姓名查询某员工当天的请假与加班情况、查询通讯录电话、处理审批（通过/驳回/查看）、设置工作代理人、打开某功能页面。',
  '- "chat"：政策与知识咨询（如撤销规则、加班费算法、节假日安排）、闲聊、与系统无关的问题，以及用户想查但系统做不到的事（如查询他人的完整加班记录、工资、统计报表）。',
  '示例：',
  '- 「8月13号请一天调休假」→ {"route":"command"}',
  '- 「查一下我的调休余额」→ {"route":"command"}',
  '- 「张三今天是否请假」→ {"route":"command"}（系统支持按姓名查员工当天请假情况）',
  '- 「张三的电话」→ {"route":"command"}（通讯录支持按姓名查）',
  '- 「撤销上周一的加班」→ {"route":"command"}',
  '- 「查询张三的加班记录」→ {"route":"chat"}（系统查不了他人的完整加班记录）',
  '- 「撤销加班有什么限制吗」→ {"route":"chat"}（政策咨询）',
  '- 「下一个法定节假日是什么」→ {"route":"chat"}',
  '- 「加班费怎么计算」→ {"route":"chat"}',
].join("\n");

function parseClassifyReply(content: string): "command" | "chat" | null {
  const cleaned = content.replace(/```(?:json)?/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed.route === "command" || parsed.route === "chat" ? parsed.route : null;
  } catch {
    return null;
  }
}

export const adminAiConfigSchema = z.object({
  model: z.string().trim().max(80).optional(),
  apiUrl: z.string().trim().max(300).url().or(z.literal("")).optional(),
  apiKey: z.string().trim().max(500).optional(),
  maxTokens: z.coerce.number().int().min(50).max(4000).optional(),
  maxReplyChars: z.coerce.number().int().min(30).max(1000).optional(),
  systemPrompt: z.string().max(2000).optional(),
  // 防 SSRF:服务端会带着 API Key 请求该地址,必须限定公网 HTTPS 域名——
  // 禁止 IP 字面量/localhost/无点主机名,IP 字面量再排除内网段,
  // 防止把 Key 送去内网探测或任意外部服务器。
}).refine((value) => {
  if (!value.apiUrl) return true;
  try {
    const url = new URL(value.apiUrl);
    if (url.protocol !== "https:") return false;
    const host = url.hostname;
    if (!host.includes(".") || /^(localhost|.*\.local)$/i.test(host)) return false;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
      const [a = 0, b = 0] = host.split(".").map(Number);
      const privateIp = a === 0 || a === 10 || a === 127
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 169 && b === 254);
      if (privateIp) return false;
    }
    return true;
  } catch {
    return false;
  }
}, { message: "AI API 地址必须是公网 HTTPS 域名" });

export async function readAdminAiConfig() {
  const ai = await loadAiConfig();
  return {
    model: ai.model,
    apiUrl: ai.apiUrl,
    maxTokens: ai.maxTokens,
    maxReplyChars: ai.maxReplyChars,
    systemPrompt: ai.systemPrompt,
    hasKey: Boolean(ai.apiKey),
    keyMasked: ai.apiKey ? `***${ai.apiKey.slice(-4)}` : "",
  };
}
