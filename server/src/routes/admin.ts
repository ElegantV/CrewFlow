import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { allowRoles, loadActiveActor } from "../authz.js";
import { db } from "../db.js";
import { isValidDate } from "../business/leave-policy.js";
import { beijingTodayIso } from "../business/beijing-date.js";
import { listCalendarDays, loadCalendarCache, syncCalendar } from "../business/calendar.js";
import {
  buildRecordsWorkbook,
  type LeaveRow,
  type OvertimeRow,
} from "../business/export-records.js";
import { adminAiConfigSchema, readAdminAiConfig } from "./ai.js";

const bankLevelOptions = ["初级", "中级", "高级", "主管", "高级主管"] as const;

const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  employeeNo: z.string().trim().min(1).max(64).nullable().optional(),
  role: z.enum(["user", "admin", "super_admin"]).optional(),
  status: z.enum(["pending", "active", "disabled"]).optional(),
  managerId: z.string().uuid().nullable().optional(),
  bankLevel: z.enum(bankLevelOptions).nullable().optional(),
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
      bank_level: string | null;
      manager_id: string | null;
      manager_name: string | null;
    }>(
      `SELECT u.id, u.openid, u.name, u.employee_no, u.role, u.status, u.bank_level,
              u.manager_id, manager.name AS manager_name
       FROM users u
       LEFT JOIN users manager ON manager.id = u.manager_id
       ORDER BY u.created_at, u.id`,
    );
    return {
      users: result.rows.map((user) => ({
        id: user.id,
        openid: user.openid,
        name: user.name,
        employeeNo: user.employee_no,
        role: user.role,
        status: user.status,
        bankLevel: user.bank_level,
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

    const current = await db.query<{ name: string | null; employee_no: string | null; role: string; status: string; manager_id: string | null; bank_level: string | null }>(
      "SELECT name, employee_no, role, status, manager_id, bank_level FROM users WHERE id = $1",
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
      bankLevel: body.data.bankLevel === undefined ? existing.bank_level : body.data.bankLevel,
    };
    if (next.role === "user" && next.status === "active" && !next.managerId) {
      return reply.code(400).send({ code: "MANAGER_REQUIRED", message: "启用普通用户前必须指定审批管理员" });
    }

    await db.query(
      `UPDATE users
       SET name = $1, employee_no = $2, role = $3, status = $4, manager_id = $5, bank_level = $6, updated_at = now()
       WHERE id = $7`,
      [next.name, next.employeeNo, next.role, next.status, next.managerId, next.bankLevel, id.data],
    );
    return { success: true };
  });

  // 销毁用户:删除其全部业务数据并解绑微信,使该微信号下次登录走全新注册流程(用于重置/测试)。
  app.delete("/users/:id", superAdminHooks, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
    if (!id.success) {
      return reply.code(400).send({ code: "INVALID_USER", message: "用户参数无效" });
    }
    if (id.data === request.actor!.id) {
      return reply.code(400).send({ code: "CANNOT_DELETE_SELF", message: "不能删除当前登录的超级管理员账号" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query<{ name: string | null; openid: string }>(
        "SELECT name, openid FROM users WHERE id = $1 FOR UPDATE",
        [id.data],
      );
      const user = target.rows[0];
      if (!user) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ code: "USER_NOT_FOUND", message: "用户不存在" });
      }

      // 该用户已被他人引用(他人审批单、负责人、代理人、他人请假单代理人)时拒绝删除,避免破坏他人数据。
      const entangled = await client.query(
        `SELECT 1 FROM (
           SELECT approval.approver_id AS uid
           FROM approval_records approval JOIN leave_requests leave ON leave.id = approval.leave_request_id
           WHERE approval.approver_id = $1 AND leave.applicant_id <> $1
           UNION SELECT approval.approver_id
           FROM approval_records approval JOIN duty_records duty ON duty.id = approval.duty_record_id
           WHERE approval.approver_id = $1 AND duty.user_id <> $1
           UNION SELECT manager_id FROM users WHERE manager_id = $1
           UNION SELECT agent_user_id FROM users WHERE agent_user_id = $1
           UNION SELECT agent_user_id FROM leave_requests WHERE agent_user_id = $1
         ) refs LIMIT 1`,
        [id.data],
      );
      if (entangled.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          code: "USER_ENTANGLED",
          message: "该用户已作为审批人/负责人/代理人与其他用户关联，无法删除。请先在用户管理中解除其关联。",
        });
      }

      // 按外键依赖自子表向父表删除,最后删除用户本身。
      await client.query("DELETE FROM wxpusher_bindings WHERE user_id = $1", [id.data]);
      await client.query(
        "DELETE FROM timeoff_allocations WHERE leave_request_id IN (SELECT id FROM leave_requests WHERE applicant_id = $1) OR duty_record_id IN (SELECT id FROM duty_records WHERE user_id = $1)",
        [id.data],
      );
      await client.query(
        "DELETE FROM timeoff_ledger WHERE user_id = $1 OR duty_record_id IN (SELECT id FROM duty_records WHERE user_id = $1) OR leave_request_id IN (SELECT id FROM leave_requests WHERE applicant_id = $1)",
        [id.data],
      );
      await client.query(
        "DELETE FROM approval_records WHERE leave_request_id IN (SELECT id FROM leave_requests WHERE applicant_id = $1) OR duty_record_id IN (SELECT id FROM duty_records WHERE user_id = $1)",
        [id.data],
      );
      await client.query("DELETE FROM leave_requests WHERE applicant_id = $1", [id.data]);
      await client.query("DELETE FROM duty_records WHERE user_id = $1", [id.data]);
      await client.query("UPDATE audit_logs SET actor_id = NULL WHERE actor_id = $1", [id.data]);
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, details)
         VALUES ($1, 'user.delete', 'user', $2, $3::jsonb)`,
        [request.actor!.id, id.data, JSON.stringify({ name: user.name, openid: user.openid })],
      );
      await client.query("DELETE FROM users WHERE id = $1", [id.data]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { success: true };
  });

  // 按日期区间导出全部加班/请假记录为 Excel(仅超级管理员),可通过 userId 筛选单个用户。
  app.get("/records/export", superAdminHooks, async (request, reply) => {
    const parsed = z.object({
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      userId: z.string().uuid().optional(),
    }).safeParse(request.query);
    // isValidDate 做 round-trip 校验:regex 放得过宽,2026-02-30 之类的日期
    // 会穿到这里,最终 Postgres ::date 转换直接 500。
    if (!parsed.success || !isValidDate(parsed.data.start) || !isValidDate(parsed.data.end) || parsed.data.start > parsed.data.end) {
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
         ORDER BY leave.start_date, applicant.name NULLS LAST, leave.id`,
        userId ? [start, end, userId] : [start, end],
      ),
      db.query<OvertimeRow>(
        `SELECT person.name, duty.duty_date::text, duty.hours::text,
                duty.content, duty.status, duty.created_at::text
         FROM duty_records duty
         JOIN users person ON person.id = duty.user_id
         WHERE duty.duty_date >= $1::date AND duty.duty_date <= $2::date
         ${userId ? "AND duty.user_id = $3::uuid" : ""}
         ORDER BY duty.duty_date, person.name NULLS LAST, duty.id`,
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

  // AI 深度问答配置:模型/Key/回复字数/提示词,Key 只返回脱敏形式,空 Key 表示沿用 .env 默认值。
  app.get("/ai-config", superAdminHooks, async () => readAdminAiConfig());

  app.put("/ai-config", superAdminHooks, async (request, reply) => {
    const parsed = adminAiConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_AI_CONFIG", message: "AI 配置无效" });
    }
    const value = parsed.data;
    // 未传 apiKey(或传空)表示保留现有 Key,避免每次保存都要重新粘贴。
    if (value.apiKey !== undefined && value.apiKey !== "") {
      await db.query("UPDATE ai_config SET api_key = $1, updated_at = now() WHERE id = 1", [value.apiKey]);
    }
    if (value.model !== undefined) {
      await db.query("UPDATE ai_config SET model = $1, updated_at = now() WHERE id = 1", [value.model]);
    }
    if (value.apiUrl !== undefined) {
      await db.query("UPDATE ai_config SET api_url = $1, updated_at = now() WHERE id = 1", [value.apiUrl]);
    }
    if (value.maxTokens !== undefined) {
      await db.query("UPDATE ai_config SET max_tokens = $1, updated_at = now() WHERE id = 1", [value.maxTokens]);
    }
    if (value.maxReplyChars !== undefined) {
      await db.query("UPDATE ai_config SET max_reply_chars = $1, updated_at = now() WHERE id = 1", [value.maxReplyChars]);
    }
    if (value.systemPrompt !== undefined) {
      await db.query("UPDATE ai_config SET system_prompt = $1, updated_at = now() WHERE id = 1", [value.systemPrompt]);
    }
    return readAdminAiConfig();
  });

  // 法定节假日日历维护:手工覆盖优先级最高(同步永不覆盖 manual 行)。
  const calendarDaySchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dayType: z.enum(["holiday", "makeup"]),
    name: z.string().trim().max(50).optional(),
  });

  app.get("/calendar", superAdminHooks, async (request) => {
    const parsed = z.object({
      year: z.string().regex(/^\d{4}$/).optional(),
    }).safeParse(request.query);
    const year = parsed.success && parsed.data.year
      ? Number(parsed.data.year)
      : Number(beijingTodayIso().slice(0, 4));
    const days = await listCalendarDays(year);
    return { year, days };
  });

  app.put("/calendar/day", superAdminHooks, async (request, reply) => {
    const parsed = calendarDaySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_CALENDAR_DAY", message: "日历数据无效" });
    }
    const { date, dayType, name } = parsed.data;
    await db.query(
      `INSERT INTO calendar_days (date, day_type, name, source)
       VALUES ($1, $2, $3, 'manual')
       ON CONFLICT (date) DO UPDATE
       SET day_type = EXCLUDED.day_type, name = EXCLUDED.name, source = 'manual', updated_at = now()`,
      [date, dayType, name ?? ""],
    );
    await loadCalendarCache();
    return { success: true, date, dayType, name: name ?? "" };
  });

  app.delete("/calendar/day", superAdminHooks, async (request, reply) => {
    const parsed = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_CALENDAR_DAY", message: "日历数据无效" });
    }
    const result = await db.query("DELETE FROM calendar_days WHERE date = $1 RETURNING date", [parsed.data.date]);
    await loadCalendarCache();
    return { success: true, removed: result.rowCount ?? 0 };
  });

  // 公告发布后可手动触发拉取(平时由每日定时任务维护)。
  app.post("/calendar/sync", superAdminHooks, async () => syncCalendar(app.log));

  // ===== 行内字典维护(处室/打卡地点/行内项目) =====
  // 用户表仍存字典名称文本;删除前检查用户是否引用,被引用则拒绝。

  const dictNameSchema = z.object({ name: z.string().trim().min(1).max(160) });

  async function dictNameTaken(table: string, name: string, excludeId?: string) {
    const result = await db.query(
      `SELECT 1 FROM ${table} WHERE name = $1 ${excludeId ? "AND id <> $2" : ""} LIMIT 1`,
      excludeId ? [name, excludeId] : [name],
    );
    return Boolean(result.rowCount);
  }

  async function dictRefCheck(reply: FastifyReply, table: string, id: string, userColumn: string, label: string) {
    const used = await db.query(
      `SELECT 1 FROM users WHERE ${userColumn} = (SELECT name FROM ${table} WHERE id = $1) LIMIT 1`,
      [id],
    );
    if (used.rowCount) {
      reply.code(409).send({ code: "DICT_IN_USE", message: `该${label}已被用户引用，无法删除` });
      return true;
    }
    return false;
  }

  function registerDictDelete(path: string, table: string, userColumn: string, label: string) {
    app.delete(`/dicts/${path}/:id`, superAdminHooks, async (request, reply) => {
      const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
      if (!id.success) return reply.code(400).send({ code: "INVALID_DICT", message: "参数无效" });
      if (await dictRefCheck(reply, table, id.data, userColumn, label)) return;
      const result = await db.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [id.data]);
      if (!result.rowCount) return reply.code(404).send({ code: "DICT_NOT_FOUND", message: "字典项不存在" });
      return { success: true };
    });
  }

  function registerDictCrud(path: string, table: string, userColumn: string, label: string) {
    app.post(`/dicts/${path}`, superAdminHooks, async (request, reply) => {
      const parsed = dictNameSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ code: "INVALID_DICT", message: "名称无效" });
      if (await dictNameTaken(table, parsed.data.name)) {
        return reply.code(409).send({ code: "DICT_DUPLICATE", message: "该名称已存在" });
      }
      const result = await db.query(`INSERT INTO ${table} (name) VALUES ($1) RETURNING id, name`, [parsed.data.name]);
      return { item: result.rows[0] };
    });

    app.put(`/dicts/${path}/:id`, superAdminHooks, async (request, reply) => {
      const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
      const parsed = dictNameSchema.safeParse(request.body);
      if (!id.success || !parsed.success) return reply.code(400).send({ code: "INVALID_DICT", message: "名称无效" });
      if (await dictNameTaken(table, parsed.data.name, id.data)) {
        return reply.code(409).send({ code: "DICT_DUPLICATE", message: "该名称已存在" });
      }
      const result = await db.query(
        `UPDATE ${table} SET name = $1, updated_at = now() WHERE id = $2 RETURNING id, name`,
        [parsed.data.name, id.data],
      );
      if (!result.rowCount) return reply.code(404).send({ code: "DICT_NOT_FOUND", message: "字典项不存在" });
      return { item: result.rows[0] };
    });

    registerDictDelete(path, table, userColumn, label);
  }

  // 处室额外维护请假/加班审批开关,单独实现 POST/PUT;删除复用通用逻辑。
  const departmentSchema = z.object({
    name: z.string().trim().min(1).max(160),
    leaveApprovalRequired: z.boolean().optional(),
    overtimeApprovalRequired: z.boolean().optional(),
  });

  type DepartmentRow = {
    id: string;
    name: string;
    leave_approval_required: boolean;
    overtime_approval_required: boolean;
  };

  function departmentItem(row: DepartmentRow) {
    return {
      id: row.id,
      name: row.name,
      leaveApprovalRequired: row.leave_approval_required,
      overtimeApprovalRequired: row.overtime_approval_required,
    };
  }

  app.post("/dicts/departments", superAdminHooks, async (request, reply) => {
    const parsed = departmentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_DICT", message: "名称或审批配置无效" });
    if (await dictNameTaken("departments", parsed.data.name)) {
      return reply.code(409).send({ code: "DICT_DUPLICATE", message: "该名称已存在" });
    }
    const result = await db.query<DepartmentRow>(
      `INSERT INTO departments (name, leave_approval_required, overtime_approval_required)
       VALUES ($1, $2, $3)
       RETURNING id, name, leave_approval_required, overtime_approval_required`,
      [parsed.data.name, parsed.data.leaveApprovalRequired ?? true, parsed.data.overtimeApprovalRequired ?? false],
    );
    return { item: departmentItem(result.rows[0]!) };
  });

  app.put("/dicts/departments/:id", superAdminHooks, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
    const parsed = departmentSchema.safeParse(request.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ code: "INVALID_DICT", message: "名称或审批配置无效" });
    if (await dictNameTaken("departments", parsed.data.name, id.data)) {
      return reply.code(409).send({ code: "DICT_DUPLICATE", message: "该名称已存在" });
    }
    const result = await db.query<DepartmentRow>(
      `UPDATE departments
       SET name = $1, updated_at = now(),
           leave_approval_required = COALESCE($2, leave_approval_required),
           overtime_approval_required = COALESCE($3, overtime_approval_required)
       WHERE id = $4
       RETURNING id, name, leave_approval_required, overtime_approval_required`,
      [parsed.data.name, parsed.data.leaveApprovalRequired ?? null, parsed.data.overtimeApprovalRequired ?? null, id.data],
    );
    if (!result.rowCount) return reply.code(404).send({ code: "DICT_NOT_FOUND", message: "字典项不存在" });
    return { item: departmentItem(result.rows[0]!) };
  });

  registerDictDelete("departments", "departments", "department", "行内处室");
  registerDictCrud("attendance-locations", "attendance_locations", "attendance_location", "打卡地点");

  // 行内项目:名称 + 所属处室(处室被删时项目级联删除)。
  const bankProjectSchema = z.object({
    name: z.string().trim().min(1).max(160),
    departmentId: z.string().uuid(),
  });

  app.post("/dicts/bank-projects", superAdminHooks, async (request, reply) => {
    const parsed = bankProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_DICT", message: "项目或处室无效" });
    const dep = await db.query("SELECT 1 FROM departments WHERE id = $1", [parsed.data.departmentId]);
    if (!dep.rowCount) return reply.code(404).send({ code: "DEPARTMENT_NOT_FOUND", message: "所属处室不存在" });
    if (await dictNameTaken("bank_projects", parsed.data.name)) {
      return reply.code(409).send({ code: "DICT_DUPLICATE", message: "该名称已存在" });
    }
    const result = await db.query(
      `INSERT INTO bank_projects (department_id, name) VALUES ($1, $2)
       RETURNING id, department_id, name`,
      [parsed.data.departmentId, parsed.data.name],
    );
    return { item: result.rows[0] };
  });

  app.put("/dicts/bank-projects/:id", superAdminHooks, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
    const parsed = bankProjectSchema.safeParse(request.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ code: "INVALID_DICT", message: "项目或处室无效" });
    const dep = await db.query("SELECT 1 FROM departments WHERE id = $1", [parsed.data.departmentId]);
    if (!dep.rowCount) return reply.code(404).send({ code: "DEPARTMENT_NOT_FOUND", message: "所属处室不存在" });
    const result = await db.query(
      `UPDATE bank_projects SET name = $1, department_id = $2, updated_at = now()
       WHERE id = $3 RETURNING id, department_id, name`,
      [parsed.data.name, parsed.data.departmentId, id.data],
    );
    if (!result.rowCount) return reply.code(404).send({ code: "DICT_NOT_FOUND", message: "字典项不存在" });
    return { item: result.rows[0] };
  });

  app.delete("/dicts/bank-projects/:id", superAdminHooks, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
    if (!id.success) return reply.code(400).send({ code: "INVALID_DICT", message: "参数无效" });
    if (await dictRefCheck(reply, "bank_projects", id.data, "bank_project", "行内项目")) return;
    const result = await db.query("DELETE FROM bank_projects WHERE id = $1 RETURNING id", [id.data]);
    if (!result.rowCount) return reply.code(404).send({ code: "DICT_NOT_FOUND", message: "字典项不存在" });
    return { success: true };
  });
};

