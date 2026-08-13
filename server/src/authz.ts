import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "./db.js";

export type Role = "user" | "admin" | "super_admin";

export async function loadActiveActor(request: FastifyRequest, reply: FastifyReply) {
  const result = await db.query<{
    id: string;
    role: Role;
    status: "pending" | "active" | "disabled";
    manager_id: string | null;
    agent_user_id: string | null;
    personnel_type: "bank" | "digital" | "vendor";
  }>(
    `SELECT id, role, status, manager_id, agent_user_id, personnel_type
     FROM users WHERE id = $1`,
    [request.user.sub],
  );

  const user = result.rows[0];
  if (!user || user.status !== "active") {
    await reply.code(403).send({
      code: user?.status === "pending" ? "ACCOUNT_PENDING" : "ACCOUNT_DISABLED",
      message: user?.status === "pending" ? "账号等待超级管理员激活" : "账号不可用",
    });
    return;
  }

  request.actor = {
    id: user.id,
    role: user.role,
    status: user.status,
    managerId: user.manager_id,
    agentUserId: user.agent_user_id,
    personnelType: user.personnel_type,
  };
}

export function allowRoles(...roles: Role[]) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply) {
    if (!request.actor || !roles.includes(request.actor.role)) {
      await reply.code(403).send({ code: "FORBIDDEN", message: "没有执行此操作的权限" });
    }
  };
}
