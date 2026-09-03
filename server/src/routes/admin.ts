import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { allowRoles, loadActiveActor } from "../authz.js";
import { db } from "../db.js";
import {
  buildRecordsWorkbook,
  type LeaveRow,
  type OvertimeRow,
} from "../business/export-records.js";

const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  employeeNo: z.string().trim().min(1).max(64).nullable().optional(),
  role: z.enum(["user", "admin", "super_admin"]).optional(),
  status: z.enum(["pending", "active", "disabled"]).optional(),
  managerId: z.string().uuid().nullable().optional(),
}).refine((value) => Object.keys(value).length > 0);

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const superAdminHooks = {
    onRequest: [app.authenticate, loadActiveActor, allowRoles("super_admin")],
  };

  app.get("/users", superAdminHooks, async () => {
    const result = await db.query<{
      id: string;
      openid: string;
      name: string | null;
      employee_no: string | null;
      role: string;
      status: string;
      manager_id: string | null;
      manager_name: string | null;
    }>(
      `SELECT u.id, u.openid, u.name, u.employee_no, u.role, u.status,
              u.manager_id, manager.name AS manager_name
       FROM users u
       LEFT JOIN users manager ON manager.id = u.manager_id
       ORDER BY u.created_at`,
    );
    return {
      users: result.rows.map((user) => ({
        id: user.id,
        openid: user.openid,
        name: user.name,
        employeeNo: user.employee_no,
        role: user.role,
        status: user.status,
        manager: user.manager_id ? { id: user.manager_id, name: user.manager_name } : null,
      })),
    };
  });

  app.put("/users/:id", superAdminHooks, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
    const body = updateUserSchema.safeParse(request.body);
    if (!id.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_USER_UPDATE", message: "用户配置无效" });
    }
    if (id.data === request.actor!.id && (body.data.status === "disabled" || (body.data.role && body.data.role !== "super_admin"))) {
      return reply.code(400).send({ code: "CANNOT_DEMOTE_SELF", message: "不能停用自己或移除自己的超级管理员权限" });
    }

    if (body.data.managerId) {
      const manager = await db.query<{ role: string; status: string }>(
        "SELECT role, status FROM users WHERE id = $1",
        [body.data.managerId],
      );
      const candidate = manager.rows[0];
      if (!candidate || candidate.status !== "active" || !["admin", "super_admin"].includes(candidate.role)) {
        return reply.code(400).send({ code: "INVALID_MANAGER", message: "负责人必须是启用的管理员或超级管理员" });
      }
      if (body.data.managerId === id.data) {
        return reply.code(400).send({ code: "INVALID_MANAGER", message: "用户不能负责审批自己" });
      }
    }

    const current = await db.query<{ name: string | null; employee_no: string | null; role: string; status: string; manager_id: string | null }>(
      "SELECT name, employee_no, role, status, manager_id FROM users WHERE id = $1",
      [id.data],
    );
    const existing = current.rows[0];
    if (!existing) {
      return reply.code(404).send({ code: "USER_NOT_FOUND", message: "用户不存在" });
    }

    const next = {
      name: body.data.name ?? existing.name,
      employeeNo: body.data.employeeNo === undefined ? existing.employee_no : body.data.employeeNo,
      role: body.data.role ?? existing.role,
      status: body.data.status ?? existing.status,
      managerId: body.data.managerId === undefined ? existing.manager_id : body.data.managerId,
    };
    if (next.role === "user" && next.status === "active" && !next.managerId) {
      return reply.code(400).send({ code: "MANAGER_REQUIRED", message: "启用普通用户前必须指定审批管理员" });
    }

    await db.query(
      `UPDATE users
       SET name = $1, employee_no = $2, role = $3, status = $4, manager_id = $5, updated_at = now()
       WHERE id = $6`,
      [next.name, next.employeeNo, next.role, next.status, next.managerId, id.data],
    );
    return { success: true };
  });

  // 按日期区间导出全部加班/请假记录为 Excel(仅超级管理员),可通过 userId 筛选单个用户。
  app.get("/records/export", superAdminHooks, async (request, reply) => {
    const parsed = z.object({
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      userId: z.string().uuid().optional(),
    }).safeParse(request.query);
    if (!parsed.success || parsed.data.start > parsed.data.end) {
      return reply.code(400).send({ code: "INVALID_RANGE", message: "请选择有效的起止日期" });
    }
    if (parsed.data.end < parsed.data.start || Date.parse(parsed.data.end) - Date.parse(parsed.data.start) > 366 * 86400_000) {
      return reply.code(400).send({ code: "INVALID_RANGE", message: "导出区间不能超过一年" });
    }
    const { start, end, userId } = parsed.data;

    let exportUserName: string | null = null;
    if (userId) {
      const userResult = await db.query<{ name: string | null }>(
        "SELECT name FROM users WHERE id = $1",
        [userId],
      );
      const user = userResult.rows[0];
      if (!user) {
        return reply.code(404).send({ code: "USER_NOT_FOUND", message: "用户不存在" });
      }
      exportUserName = user.name;
    }

    const [leaveResult, overtimeResult] = await Promise.all([
      db.query<LeaveRow>(
        `SELECT applicant.name AS applicant_name,
                leave.leave_type, leave.start_date::text, leave.end_date::text,
                leave.start_period::text, leave.end_period::text,
                leave.requested_days::text, leave.status, leave.reason,
                approver.name AS approver_name, leave.submitted_at::text AS created_at
         FROM leave_requests leave
         JOIN users applicant ON applicant.id = leave.applicant_id
         LEFT JOIN approval_records approval ON approval.leave_request_id = leave.id AND approval.step_no = 1
         LEFT JOIN users approver ON approver.id = approval.approver_id
         WHERE leave.start_date <= $2::date AND leave.end_date >= $1::date
         ${userId ? "AND leave.applicant_id = $3::uuid" : ""}
         ORDER BY leave.start_date, applicant.name NULLS LAST`,
        userId ? [start, end, userId] : [start, end],
      ),
      db.query<OvertimeRow>(
        `SELECT person.name, duty.duty_date::text, duty.hours::text,
                duty.content, duty.status, duty.created_at::text
         FROM duty_records duty
         JOIN users person ON person.id = duty.user_id
         WHERE duty.duty_date >= $1::date AND duty.duty_date <= $2::date
         ${userId ? "AND duty.user_id = $3::uuid" : ""}
         ORDER BY duty.duty_date, person.name NULLS LAST`,
        userId ? [start, end, userId] : [start, end],
      ),
    ]);

    const workbook = buildRecordsWorkbook(leaveResult.rows, overtimeResult.rows);
    const buffer = await workbook.xlsx.writeBuffer();
    const userSuffix = exportUserName
      ? `_${exportUserName.replace(/[\\/:*?"<>|]/g, "_")}`
      : "";
    const filename = `考勤记录${userSuffix}_${start.replaceAll("-", "")}_${end.replaceAll("-", "")}.xlsx`;
    return reply
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="records.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .send(Buffer.from(buffer));
  });
};

