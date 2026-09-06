import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// /ai/chat 只有在配置了 AI_API_KEY 时才可用,配置在模块加载时读取,
// 因此必须在 import src 之前写入进程环境。
process.env.AI_API_KEY = "test-ai-key-9012";

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");

const app = await buildApp();

type TestUser = { id: string; role: "user" | "admin" | "super_admin" };
let normalUser: TestUser;
let superAdmin: TestUser;

function token(user: TestUser) {
  return app.jwt.sign({ sub: user.id, role: user.role, status: "active" });
}

function auth(user: TestUser) {
  return { authorization: `Bearer ${token(user)}` };
}

const upstreamPayload = {
  choices: [{ message: { content: "  这是 AI 的回答文本。 " } }],
};

function sseResponse(events: string[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function upstreamSseEvents(text: string) {
  return text.split("").map(ch => `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`)
    .concat("data: [DONE]\n\n");
}

async function insertUser(openid: string, name: string, role: TestUser["role"]) {
  const result = await db.query<TestUser>(
    `INSERT INTO users (openid, name, role, status)
     VALUES ($1, $2, $3, 'active') RETURNING id, role`,
    [openid, name, role],
  );
  return result.rows[0]!;
}

before(async () => {
  // 只清理本文件的前缀用户,不做 TRUNCATE:测试文件并发共享同一个库,
  // 清空共享表会与 business/export-records 的数据互相踩踏。
  await db.query("DELETE FROM users WHERE openid LIKE 'ai-test-%'");
  normalUser = await insertUser("ai-test-user", "AI测试用户", "user");
  superAdmin = await insertUser("ai-test-super", "AI测试超管", "super_admin");
  await db.query(
    `UPDATE ai_config SET model = '', api_url = '', api_key = '', system_prompt = '',
     max_tokens = 400, max_reply_chars = 120 WHERE id = 1`,
  );
});

after(async () => {
  // 先清数据再关 app:app.close() 会触发 onClose 关闭数据库连接池。
  await db.query("DELETE FROM users WHERE openid LIKE 'ai-test-%'");
  await app.close();
});

async function enableAi(userId: string) {
  await db.query("UPDATE users SET ai_agent_enabled = true WHERE id = $1", [userId]);
}

test("AI 未开启时 /ai/chat 返回 403", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/ai/chat",
    headers: auth(normalUser),
    payload: { messages: [{ role: "user", content: "帮我写一首诗" }] },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, "AI_DISABLED");
});

test("PUT /me/ai-agent 切换开关且 GET /me 暴露状态", async () => {
  const enable = await app.inject({
    method: "PUT",
    url: "/api/v1/me/ai-agent",
    headers: auth(normalUser),
    payload: { enabled: true },
  });
  assert.equal(enable.statusCode, 200);
  assert.equal(enable.json().enabled, true);

  const profile = await app.inject({ method: "GET", url: "/api/v1/me", headers: auth(normalUser) });
  assert.equal(profile.json().aiAgentEnabled, true);

  const disable = await app.inject({
    method: "PUT",
    url: "/api/v1/me/ai-agent",
    headers: auth(normalUser),
    payload: { enabled: false },
  });
  assert.equal(disable.json().enabled, false);
  await app.inject({
    method: "PUT",
    url: "/api/v1/me/ai-agent",
    headers: auth(normalUser),
    payload: { enabled: true },
  });
});

test("开关参数无效返回 400", async () => {
  const response = await app.inject({
    method: "PUT",
    url: "/api/v1/me/ai-agent",
    headers: auth(normalUser),
    payload: { enabled: "yes" },
  });
  assert.equal(response.statusCode, 400);
});

test("JSON 模式:转发大模型,回答按 max_reply_chars 截断", async () => {
  await enableAi(normalUser.id);
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, options: any) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(upstreamPayload), { status: 200 });
  }) as typeof fetch;
  try {
    await db.query("UPDATE ai_config SET max_reply_chars = 5 WHERE id = 1");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth(normalUser),
      payload: { messages: [{ role: "user", content: "什么是复式记账" }] },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "这是 AI…");
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.includes("chatapi.weixin.qq.com"));
    const body = JSON.parse(String(calls[0]!.options.body));
    assert.equal(body.stream, undefined);
    assert.equal(body.messages[0].role, "system");
    assert.ok(body.messages[0].content.includes("简序日程助手"));
    assert.ok(body.messages[0].content.includes("不超过 5 字"));
    assert.ok(!body.messages[0].content.includes("test-ai-key"));
  } finally {
    globalThis.fetch = originalFetch;
    await db.query("UPDATE ai_config SET max_reply_chars = 120 WHERE id = 1");
  }
});

test("SSE 流式模式:返回 delta 帧并以 result 结尾,文本同样截断", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse(upstreamSseEvents("一二三四五六七八九十"))) as typeof fetch;
  try {
    await db.query("UPDATE ai_config SET max_reply_chars = 6 WHERE id = 1");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: Object.assign({ accept: "text/event-stream" }, auth(normalUser)),
      payload: { messages: [{ role: "user", content: "你好" }] },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(String(response.headers["content-type"]).includes("text/event-stream"));
    const frames = response.body
      .split("\n\n")
      .filter(Boolean)
      .map(line => JSON.parse(line.replace(/^data:\s*/, "")));
    const deltas = frames.filter(f => f.type === "delta");
    const results = frames.filter(f => f.type === "result");
    assert.ok(deltas.length >= 6);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.text, "一二三四五六…");
  } finally {
    globalThis.fetch = originalFetch;
    await db.query("UPDATE ai_config SET max_reply_chars = 120 WHERE id = 1");
  }
});

test("非法消息体返回 400", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/ai/chat",
    headers: auth(normalUser),
    payload: { messages: [{ role: "system", content: "越权提示" }] },
  });
  assert.equal(response.statusCode, 400);

  const tooMany = await app.inject({
    method: "POST",
    url: "/api/v1/ai/chat",
    headers: auth(normalUser),
    payload: { messages: Array.from({ length: 21 }, (_, i) => ({ role: "user", content: `消息${i}` })) },
  });
  assert.equal(tooMany.statusCode, 400);
});

test("上游错误返回 502 且不泄露内部信息", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("upstream exploded", { status: 500 })) as typeof fetch;
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth(normalUser),
      payload: { messages: [{ role: "user", content: "你好" }] },
    });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().code, "AI_UPSTREAM_ERROR");
    assert.ok(!response.body.includes("upstream exploded"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("上游返回空内容时返回 502", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 })) as typeof fetch;
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth(normalUser),
      payload: { messages: [{ role: "user", content: "你好" }] },
    });
    assert.equal(response.statusCode, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("意图分类:返回受控 route,异常输出一律 502", async () => {
  await enableAi(normalUser.id);
  const originalFetch = globalThis.fetch;
  try {
    // 正常:模型输出带代码块包裹的 JSON,应解析出 chat
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"route":"chat"}\n```' } }] }), { status: 200 })) as typeof fetch;
    const chatRoute = await app.inject({
      method: "POST",
      url: "/api/v1/ai/classify",
      headers: auth(normalUser),
      payload: { text: "撤销加班有什么限制吗" },
    });
    assert.equal(chatRoute.statusCode, 200);
    assert.equal(chatRoute.json().route, "chat");

    // 白名单外取值 → 502(客户端将退回规则引擎)
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"route":"banana"}' } }] }), { status: 200 })) as typeof fetch;
    const invalidRoute = await app.inject({
      method: "POST",
      url: "/api/v1/ai/classify",
      headers: auth(normalUser),
      payload: { text: "你好" },
    });
    assert.equal(invalidRoute.statusCode, 502);

    // 非 JSON 输出 → 502
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "抱歉我不明白" } }] }), { status: 200 })) as typeof fetch;
    const garbage = await app.inject({
      method: "POST",
      url: "/api/v1/ai/classify",
      headers: auth(normalUser),
      payload: { text: "你好" },
    });
    assert.equal(garbage.statusCode, 502);

    // 超长文本 → 400
    const tooLong = await app.inject({
      method: "POST",
      url: "/api/v1/ai/classify",
      headers: auth(normalUser),
      payload: { text: "啊".repeat(501) },
    });
    assert.equal(tooLong.statusCode, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("普通用户无权读取 AI 配置,超级管理员可读取且 Key 脱敏", async () => {
  const forbidden = await app.inject({ method: "GET", url: "/api/v1/admin/ai-config", headers: auth(normalUser) });
  assert.equal(forbidden.statusCode, 403);

  const config = await app.inject({ method: "GET", url: "/api/v1/admin/ai-config", headers: auth(superAdmin) });
  assert.equal(config.statusCode, 200);
  const body = config.json();
  // 数据库 Key 为空时回退到进程环境 Key(本文件顶部注入的 test-ai-key-9012)。
  assert.equal(body.hasKey, true);
  assert.equal(body.keyMasked, "***9012");
  assert.equal(body.maxReplyChars, 120);
});

test("超级管理员可更新 AI 配置,空 apiKey 保留现有值", async () => {
  const save = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/ai-config",
    headers: auth(superAdmin),
    payload: { model: "Deepseek-v4-flash", apiKey: "sk-secret-9876", maxReplyChars: 200 },
  });
  assert.equal(save.statusCode, 200);
  assert.equal(save.json().keyMasked, "***9876");
  assert.equal(save.json().model, "Deepseek-v4-flash");
  assert.equal(save.json().maxReplyChars, 200);

  const again = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/ai-config",
    headers: auth(superAdmin),
    payload: { model: "glm-5" },
  });
  assert.equal(again.json().keyMasked, "***9876", "未传 apiKey 时应保留原值");
  assert.equal(again.json().model, "glm-5");

  await db.query("UPDATE ai_config SET api_key = '', model = '' WHERE id = 1");
});
