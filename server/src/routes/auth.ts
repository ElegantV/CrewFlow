import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db.js";

const bodySchema = z.object({
  code: z.string().min(1).max(128),
});

const devLoginSchema = z.object({
  userId: z.string().uuid(),
});

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  mobile: z.string().trim().min(1).max(30),
});

const bindSchema = z.object({
  name: z.string().trim().min(1).max(80),
  mobile: z.string().trim().min(1).max(30),
});

const wechatResponseSchema = z.object({
  openid: z.string().min(1).optional(),
  unionid: z.string().min(1).optional(),
  session_key: z.string().min(1).optional(),
  errcode: z.number().optional(),
  errmsg: z.string().optional(),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  // 登录入口专项限流:同一 IP 每分钟最多 10 次,防暴力刷接口。
  const loginRateLimit = {
    config: { rateLimit: { max: 10, timeWindow: "1 minute", groupId: "auth-login" } },
  };

  app.post("/wechat", loginRateLimit, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "登录凭证无效" });
    }

    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.searchParams.set("appid", config.WECHAT_APP_ID);
    url.searchParams.set("secret", config.WECHAT_APP_SECRET);
    url.searchParams.set("js_code", parsed.data.code);
    url.searchParams.set("grant_type", "authorization_code");

    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    } catch (error) {
      request.log.error({ err: error }, "WeChat login request failed");
      return reply.code(502).send({ code: "WECHAT_UNAVAILABLE", message: "微信登录服务暂不可用" });
    }
    if (!response.ok) {
      request.log.error({ status: response.status }, "WeChat login request failed");
      return reply.code(502).send({ code: "WECHAT_UNAVAILABLE", message: "微信登录服务暂不可用" });
    }

    const wechat = wechatResponseSchema.parse(await response.json());
    if (!wechat.openid || wechat.errcode) {
      request.log.warn({ errcode: wechat.errcode }, "WeChat rejected login code");
      return reply.code(401).send({ code: "WECHAT_LOGIN_FAILED", message: "微信登录失败，请重试" });
    }

    const result = await db.query<{
      id: string;
      name: string | null;
      employee_no: string | null;
      role: "user" | "admin" | "super_admin";
      status: "pending" | "active" | "disabled";
    }>(
      `INSERT INTO users (openid, unionid, role, status)
       VALUES ($1, $2,
         CASE WHEN $3 OR ($4 AND NOT EXISTS (SELECT 1 FROM users)) THEN 'super_admin' ELSE 'user' END,
         CASE WHEN $3 OR ($4 AND NOT EXISTS (SELECT 1 FROM users)) THEN 'active' ELSE 'pending' END)
       ON CONFLICT (openid) DO UPDATE
       SET unionid = COALESCE(EXCLUDED.unionid, users.unionid),
           role = CASE WHEN $3 THEN 'super_admin' ELSE users.role END,
           status = CASE WHEN $3 THEN 'active' ELSE users.status END,
           updated_at = now()
       RETURNING id, name, employee_no, role, status`,
      [
        wechat.openid,
        wechat.unionid ?? null,
        Boolean(config.BOOTSTRAP_SUPER_ADMIN_OPENID && wechat.openid === config.BOOTSTRAP_SUPER_ADMIN_OPENID),
        config.NODE_ENV === "development" && !config.BOOTSTRAP_SUPER_ADMIN_OPENID,
      ],
    );

    const user = result.rows[0];
    if (!user) {
      throw new Error("User upsert returned no row");
    }

    if (user.status === "disabled") {
      return reply.code(403).send({ code: "ACCOUNT_DISABLED", message: "账号已停用" });
    }

    const token = await reply.jwtSign(
      { sub: user.id, role: user.role, status: user.status },
      { sign: { expiresIn: "2h" } },
    );

    return {
      token,
      expiresIn: 7_200,
      user: {
        id: user.id,
        name: user.name,
        employeeNo: user.employee_no,
        role: user.role,
        status: user.status,
      },
    };
  });

  // 首次登录（未完善资料账号）注册：填写姓名、手机号，提交即激活，无需管理员操作。
  app.post("/register", { onRequest: [app.authenticate] }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REGISTER", message: "请完整填写姓名和手机号" });
    }
    const current = await db.query<{ id: string; openid: string; status: string }>(
      "SELECT id, openid, status FROM users WHERE id = $1",
      [request.user.sub],
    );
    const user = current.rows[0];
    if (!user) {
      return reply.code(404).send({ code: "USER_NOT_FOUND", message: "用户不存在" });
    }
    if (user.status !== "pending") {
      return reply.code(409).send({ code: "ACCOUNT_NOT_PENDING", message: "该账号已完善资料，无需重复注册" });
    }
    const duplicate = await db.query(
      "SELECT 1 FROM users WHERE name = $1 AND mobile = $2 AND id <> $3",
      [parsed.data.name, parsed.data.mobile, user.id],
    );
    if (duplicate.rowCount) {
      return reply.code(409).send({
        code: "ACCOUNT_ALREADY_EXISTS",
        message: "该姓名和手机号已有账号，请使用“绑定已有用户”",
      });
    }
    await db.query(
      "UPDATE users SET name = $1, mobile = $2, status = 'active', updated_at = now() WHERE id = $3",
      [parsed.data.name, parsed.data.mobile, user.id],
    );
    return { success: true, status: "active" };
  });

  // 首次登录绑定已有用户：按 姓名+手机号 匹配，把当前 openid 挂到匹配账号上。
  // 安全约束：姓名+手机号可从通讯录零成本获得，不构成身份证明，因此——
  //   1. 停用账号禁止绑定（否则可借未过期 token 绑到他人账号逃逸封禁）；
  //   2. 只能绑定普通用户账号，禁止借绑定接管 admin/super_admin 权限；
  // 管理员目标与未匹配到一律返回 404，避免泄露“该手机号对应管理员账号”。
  // 管理员更换微信号需由超级管理员在服务端处理，不走此接口。
  app.post("/bind", { onRequest: [app.authenticate], ...loginRateLimit }, async (request, reply) => {
    const parsed = bindSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_BIND", message: "请完整填写姓名和手机号" });
    }
    const current = await db.query<{ id: string; openid: string; status: string }>(
      "SELECT id, openid, status FROM users WHERE id = $1",
      [request.user.sub],
    );
    const user = current.rows[0];
    if (!user) {
      return reply.code(404).send({ code: "USER_NOT_FOUND", message: "用户不存在" });
    }
    if (user.status === "active") {
      return { success: true, alreadyBound: true };
    }
    if (user.status === "disabled") {
      return reply.code(403).send({ code: "ACCOUNT_DISABLED", message: "账号已停用" });
    }
    const match = await db.query<{
      id: string;
      role: "user" | "admin" | "super_admin";
      status: "pending" | "active" | "disabled";
      name: string | null;
      employee_no: string | null;
    }>(
      `SELECT id, role, status, name, employee_no
       FROM users
       WHERE name = $1 AND mobile = $2 AND id <> $3
         AND status = 'active' AND role = 'user'
       ORDER BY created_at
       LIMIT 1`,
      [parsed.data.name, parsed.data.mobile, user.id],
    );
    const target = match.rows[0];
    if (!target) {
      return reply.code(404).send({
        code: "BIND_NOT_FOUND",
        message: "未找到匹配的用户，请确认姓名和手机号，或选择注册",
      });
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM users WHERE id = $1", [user.id]);
      await client.query(
        "UPDATE users SET openid = $1, updated_at = now() WHERE id = $2",
        [user.openid, target.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const token = await reply.jwtSign(
      { sub: target.id, role: target.role, status: target.status },
      { sign: { expiresIn: "8h" } },
    );
    return {
      token,
      expiresIn: 28_800,
      user: {
        id: target.id,
        name: target.name,
        employeeNo: target.employee_no,
        role: target.role,
        status: target.status,
      },
      bound: true,
    };
  });

  app.get("/dev/users", async (_request, reply) => {
    if (config.NODE_ENV !== "development") {
      return reply.code(404).send({ code: "NOT_FOUND", message: "接口不存在" });
    }

    const result = await db.query<{
      id: string;
      name: string | null;
      employee_no: string | null;
      role: "user" | "admin" | "super_admin";
      status: "pending" | "active" | "disabled";
      manager_name: string | null;
    }>(
      `SELECT u.id, u.name, u.employee_no, u.role, u.status, manager.name AS manager_name
       FROM users u
       LEFT JOIN users manager ON manager.id = u.manager_id
       WHERE u.openid LIKE 'crewflow-test-%'
       ORDER BY CASE u.role WHEN 'super_admin' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
                u.employee_no NULLS LAST`,
    );
    return {
      users: result.rows.map((user) => ({
        id: user.id,
        name: user.name,
        employeeNo: user.employee_no,
        role: user.role,
        status: user.status,
        managerName: user.manager_name,
      })),
    };
  });

  app.post("/dev", loginRateLimit, async (request, reply) => {
    if (config.NODE_ENV !== "development") {
      return reply.code(404).send({ code: "NOT_FOUND", message: "接口不存在" });
    }
    const parsed = devLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_DEV_USER", message: "测试用户无效" });
    }

    const result = await db.query<{
      id: string;
      name: string | null;
      employee_no: string | null;
      role: "user" | "admin" | "super_admin";
      status: "pending" | "active" | "disabled";
    }>(
      `SELECT id, name, employee_no, role, status
       FROM users
       WHERE id = $1 AND openid LIKE 'crewflow-test-%'`,
      [parsed.data.userId],
    );
    const user = result.rows[0];
    if (!user) {
      return reply.code(404).send({ code: "DEV_USER_NOT_FOUND", message: "测试用户不存在" });
    }

    const token = await reply.jwtSign(
      { sub: user.id, role: user.role, status: user.status },
      { sign: { expiresIn: "8h" } },
    );
    return {
      token,
      expiresIn: 28_800,
      user: {
        id: user.id,
        name: user.name,
        employeeNo: user.employee_no,
        role: user.role,
        status: user.status,
      },
      developmentOnly: true,
    };
  });
};
