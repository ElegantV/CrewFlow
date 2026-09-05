import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// /ai/chat 只有在配置了 AI_API_KEY 时才可用,配置在模块加载时读取,
// 因此必须在 import src 之前写入进程环境。
process.env.AI_API_KEY = "test-ai-key";

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");

const app = await buildApp();

type TestUser = { id: string; role: "user" | "admin" | "super_admin" };
let normalUser: TestUser;

function token(user: TestUser) {
  return app.jwt.sign({ sub: user.id, role: user.role, status: "active" });
}

function auth(user: TestUser) {
  return { authorization: `Bearer ${token(user)}` };
}

const upstreamPayload = {
  choices: [{ message: { content: "  这是 AI 的回答文本。 " } }],
};

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
});

after(async () => {
  // 先清数据再关 app:app.close() 会触发 onClose 关闭数据库连接池。
  await db.query("DELETE FROM users WHERE openid LIKE 'ai-test-%'");
  await app.close();
});

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

test("开启后转发大模型,回答仅作为文本返回", async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, options: any) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(upstreamPayload), { status: 200 });
  }) as typeof fetch;
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ai/chat",
      headers: auth(normalUser),
      payload: {
        messages: [
          { role: "user", content: "什么是复式记账" },
          { role: "assistant", content: "复式记账是……" },
          { role: "user", content: "再举个例子" },
        ],
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "这是 AI 的回答文本。");
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.includes("chatapi.weixin.qq.com"));
    const body = JSON.parse(String(calls[0]!.options.body));
    assert.equal(body.model, "Deepseek-v4-flash");
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages.length, 4);
    assert.ok(body.messages[0].content.includes("简序日程助手"));
    assert.ok(!body.messages[0].content.includes("test-ai-key"));
  } finally {
    globalThis.fetch = originalFetch;
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
