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

const wechatResponseSchema = z.object({
  openid: z.string().min(1).optional(),
  unionid: z.string().min(1).optional(),
  session_key: z.string().min(1).optional(),
  errcode: z.number().optional(),
  errmsg: z.string().optional(),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/wechat", async (request, reply) => {
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

  app.post("/dev", async (request, reply) => {
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
