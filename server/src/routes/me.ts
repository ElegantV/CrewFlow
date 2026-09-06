import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { loadActiveActor } from "../authz.js";
import { beijingTodayIso } from "../business/beijing-date.js";
import { leavePolicies, type LeaveType } from "../business/leave-policy.js";
import { db } from "../db.js";

const agentSchema = z.object({
  agentUserId: z.string().uuid().nullable(),
});

const signatureSchema = z.object({
  imageData: z.string().max(700_000).nullable(),
});

const nullableText = (max: number) => z.preprocess(
  value => value === "" || value === undefined ? null : value,
  z.string().trim().max(max).nullable(),
);

const profileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  accountName: nullableText(64),
  oaAccount: nullableText(64),
  idCardNo: z.preprocess(value => value === "" || value === undefined ? null : value,
    z.string().trim().regex(/^(\d{15}|\d{17}[\dXx])$/).nullable()),
  personnelType: z.enum(["bank", "digital", "vendor"]),
  digitalEmployeeNo: nullableText(64),
  department: nullableText(120),
  bankProject: nullableText(160),
  agentUserId: z.string().uuid().nullable(),
  attendanceLocation: nullableText(160),
  bankLevel: nullableText(80),
  itlStatus: z.enum(["yes", "no", "ops"]),
  workStartDate: z.preprocess(value => value === "" || value === undefined ? null : value,
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()),
  mobile: nullableText(30),
  address: nullableText(300),
  emergencyContactName: nullableText(80),
  emergencyContactPhone: nullableText(30),
}).refine(value => value.personnelType === "bank" || value.agentUserId !== null, {
  path: ["agentUserId"], message: "非行员必须维护工作代理人",
}).refine(value => !value.workStartDate || value.workStartDate <= beijingTodayIso(), {
  path: ["workStartDate"], message: "工作开始时间不能晚于今天",
});

const avatarSchema = z.object({ imageData: z.string().max(1_000_000) });

// 年假规则：满一年可休；工龄未满 5 年按 5 天；超过 5 年每多一年加一天，上限 15 天。
function annualLeaveDays(workStartDate: string | null) {
  if (!workStartDate) return { workYears: 0, annualLeaveDays: 0 };
  const [year = 0, month = 1, day = 1] = workStartDate.split("-").map(Number);
  const [nowYear = 0, nowMonth = 1, nowDay = 1] = beijingTodayIso().split("-").map(Number);
  let workYears = nowYear - year;
  if (nowMonth < month || (nowMonth === month && nowDay < day)) workYears -= 1;
  workYears = Math.max(0, workYears);
  let annualLeaveDays = 0;
  if (workYears >= 1) {
    annualLeaveDays = workYears < 5 ? 5 : Math.min(workYears, 15);
  }
  return { workYears, annualLeaveDays: Math.floor(annualLeaveDays) };
}

function avatarDataUrl(data: Buffer | null, mimeType: string | null) {
  return data && mimeType ? `data:${mimeType};base64,${data.toString("base64")}` : null;
}

function decodeSignature(imageData: string) {
  const match = imageData.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const data = Buffer.from(match[2]!, "base64");
  if (data.length === 0 || data.length > 500_000) return null;
  const isPng = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if ((match[1] === "image/png" && !isPng) || (match[1] === "image/jpeg" && !isJpeg)) return null;
  // mimeType 不取用户输入,由魔数校验结果推导,杜绝任何污点流入存储字段。
  const mimeType = isPng ? "image/png" : "image/jpeg";
  return { data, mimeType };
}

export const meRoutes: FastifyPluginAsync = async (app) => {
  const protectedHooks = { onRequest: [app.authenticate, loadActiveActor] };

  app.get("/", protectedHooks, async (request, reply) => {
    const result = await db.query<{
      id: string;
      name: string | null;
      employee_no: string | null;
      role: string;
      status: string;
      manager_id: string | null;
      manager_name: string | null;
      agent_user_id: string | null;
      agent_name: string | null;
      signature_updated_at: string | null;
      account_name: string | null;
      oa_account: string | null;
      id_card_no: string | null;
      avatar_data: Buffer | null;
      avatar_mime_type: string | null;
      personnel_type: "bank" | "digital" | "vendor";
      digital_employee_no: string | null;
      department: string | null;
      bank_project: string | null;
      attendance_location: string | null;
      bank_level: string | null;
      itl_status: "yes" | "no" | "ops";
      work_start_date: string | null;
      mobile: string | null;
      address: string | null;
      emergency_contact_name: string | null;
      emergency_contact_phone: string | null;
      home_menu_config: Array<{ key: string; hidden: boolean }> | null;
      ai_agent_enabled: boolean;
    }>(
      `SELECT u.id, u.name, u.employee_no, u.role, u.status,
              u.manager_id, manager.name AS manager_name,
              u.agent_user_id, agent.name AS agent_name,
              u.signature_updated_at::text, u.account_name, u.oa_account,
              u.id_card_no, u.avatar_data, u.avatar_mime_type,
              u.personnel_type, u.digital_employee_no, u.department,
              u.bank_project, u.attendance_location, u.bank_level,
              u.itl_status, u.work_start_date::text, u.mobile, u.address,
              u.emergency_contact_name, u.emergency_contact_phone,
              u.home_menu_config, u.ai_agent_enabled
       FROM users u
       LEFT JOIN users manager ON manager.id = u.manager_id
       LEFT JOIN users agent ON agent.id = u.agent_user_id
       WHERE u.id = $1`,
      [request.actor!.id],
    );

    const user = result.rows[0];
    if (!user) {
      return reply.code(404).send({ code: "USER_NOT_FOUND", message: "用户不存在" });
    }

    // 系统必填字段完备性：前端据此在登录后引导用户补齐，规则与业务校验保持一致。
    const missingRequired: string[] = [];
    if (!user.name) missingRequired.push("name");
    if (user.personnel_type !== "bank" && !user.agent_user_id) missingRequired.push("agent");
    if ((user.role === "admin" || user.role === "super_admin") && !user.signature_updated_at) {
      missingRequired.push("signature");
    }

    return {
      id: user.id,
      name: user.name,
      employeeNo: user.employee_no,
      accountName: user.account_name,
      oaAccount: user.oa_account,
      idCardNo: user.id_card_no,
      avatar: avatarDataUrl(user.avatar_data, user.avatar_mime_type),
      personnelType: user.personnel_type,
      digitalEmployeeNo: user.digital_employee_no,
      department: user.department,
      bankProject: user.bank_project,
      role: user.role,
      status: user.status,
      manager: user.manager_id ? { id: user.manager_id, name: user.manager_name } : null,
      agent: user.agent_user_id ? { id: user.agent_user_id, name: user.agent_name } : null,
      attendanceLocation: user.attendance_location,
      bankLevel: user.bank_level,
      itlStatus: user.itl_status,
      workStartDate: user.work_start_date,
      annualLeave: annualLeaveDays(user.work_start_date),
      mobile: user.mobile,
      address: user.address,
      emergencyContact: {
        name: user.emergency_contact_name,
        phone: user.emergency_contact_phone,
      },
      signatureConfigured: Boolean(user.signature_updated_at),
      signatureUpdatedAt: user.signature_updated_at,
      missingRequired,
      homeMenuConfig: user.home_menu_config ?? [],
      aiAgentEnabled: user.ai_agent_enabled,
    };
  });

  // 首页菜单个性化:保存菜单项顺序与隐藏状态(按用户)。
  const homeMenuSchema = z.object({
    items: z.array(z.object({
      key: z.enum(["assistant", "duty", "leave", "situation", "contact", "profile", "approval", "admin", "dev"]),
      hidden: z.boolean(),
    })).max(20),
  });

  app.put("/home-menu", protectedHooks, async (request, reply) => {
    const parsed = homeMenuSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_HOME_MENU", message: "菜单配置无效" });
    }
    // 去重:同 key 只保留最后一次设置。
    const seen = new Set<string>();
    const items = parsed.data.items.filter(item => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    });
    await db.query(
      "UPDATE users SET home_menu_config = $1::jsonb, updated_at = now() WHERE id = $2",
      [JSON.stringify(items), request.actor!.id],
    );
    return { success: true, items };
  });

  // AI 深度问答开关:开启后助手在规则未命中时把问题转交大模型,默认关闭。
  const aiAgentSchema = z.object({ enabled: z.boolean() });

  app.put("/ai-agent", protectedHooks, async (request, reply) => {
    const parsed = aiAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_AI_AGENT", message: "参数无效" });
    }
    await db.query(
      "UPDATE users SET ai_agent_enabled = $1, updated_at = now() WHERE id = $2",
      [parsed.data.enabled, request.actor!.id],
    );
    return { success: true, enabled: parsed.data.enabled };
  });

  app.get("/people", protectedHooks, async (request) => {
    const result = await db.query<{ id: string; name: string | null; employee_no: string | null }>(
      `SELECT id, name, employee_no
       FROM users
       WHERE status = 'active' AND id <> $1 AND personnel_type <> 'bank'
       ORDER BY name NULLS LAST, employee_no NULLS LAST`,
      [request.actor!.id],
    );
    return {
      people: result.rows.map((person) => ({
        id: person.id,
        name: person.name,
        employeeNo: person.employee_no,
      })),
    };
  });

  app.put("/agent", protectedHooks, async (request, reply) => {
    const parsed = agentSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.agentUserId === request.actor!.id) {
      return reply.code(400).send({ code: "INVALID_AGENT", message: "代理人设置无效" });
    }

    if (parsed.data.agentUserId) {
      const agent = await db.query("SELECT 1 FROM users WHERE id = $1 AND status = 'active' AND personnel_type <> 'bank'", [parsed.data.agentUserId]);
      if (!agent.rowCount) {
        return reply.code(404).send({ code: "AGENT_NOT_FOUND", message: "代理人不存在或不可用" });
      }
    }

    await db.query("UPDATE users SET agent_user_id = $1, updated_at = now() WHERE id = $2", [
      parsed.data.agentUserId,
      request.actor!.id,
    ]);
    return { success: true };
  });

  app.put("/profile", protectedHooks, async (request, reply) => {
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_PROFILE", message: "个人信息填写不完整或格式不正确" });
    }
    const profile = parsed.data;
    if (profile.personnelType === "bank" && profile.agentUserId !== null) {
      return reply.code(400).send({ code: "INVALID_AGENT", message: "行员无需设置非行员代理人" });
    }
    if (profile.agentUserId) {
      const agent = await db.query(
        "SELECT 1 FROM users WHERE id = $1 AND status = 'active' AND personnel_type <> 'bank' AND id <> $2",
        [profile.agentUserId, request.actor!.id],
      );
      if (!agent.rowCount) return reply.code(400).send({ code: "INVALID_AGENT", message: "工作代理人必须是启用的非行员" });
    }
    try {
      await db.query(
        `UPDATE users SET name = $1, account_name = $2, oa_account = $3, id_card_no = $4,
          personnel_type = $5, digital_employee_no = $6, department = $7, bank_project = $8,
          agent_user_id = $9, attendance_location = $10, bank_level = $11, itl_status = $12,
          work_start_date = $13, mobile = $14, address = $15,
          emergency_contact_name = $16, emergency_contact_phone = $17, updated_at = now()
         WHERE id = $18`,
        [profile.name, profile.accountName, profile.oaAccount, profile.idCardNo?.toUpperCase() ?? null,
          profile.personnelType, profile.digitalEmployeeNo, profile.department, profile.bankProject,
          profile.agentUserId, profile.attendanceLocation, profile.bankLevel, profile.itlStatus,
          profile.workStartDate, profile.mobile, profile.address, profile.emergencyContactName,
          profile.emergencyContactPhone, request.actor!.id],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return reply.code(409).send({ code: "PROFILE_DUPLICATE", message: "账号、内网 OA 账号或身份证号已被使用" });
      }
      throw error;
    }
    return { success: true };
  });

  app.put("/avatar", protectedHooks, async (request, reply) => {
    const parsed = avatarSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: "INVALID_AVATAR", message: "头像文件无效或过大" });
    const match = parsed.data.imageData.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return reply.code(400).send({ code: "INVALID_AVATAR", message: "请上传 PNG、JPEG 或 WebP 图片" });
    const data = Buffer.from(match[2]!, "base64");
    if (!data.length || data.length > 700_000) return reply.code(400).send({ code: "INVALID_AVATAR", message: "头像文件不能超过 700KB" });
    // mimeType 由魔数推导而非用户输入字符串。
    const isPng = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const isWebp = data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
    const mimeType = isPng ? "image/png" : isJpeg ? "image/jpeg" : isWebp ? "image/webp" : null;
    if (!mimeType) return reply.code(400).send({ code: "INVALID_AVATAR", message: "请上传 PNG、JPEG 或 WebP 图片" });
    await db.query("UPDATE users SET avatar_data = $1, avatar_mime_type = $2, updated_at = now() WHERE id = $3", [data, mimeType, request.actor!.id]);
    return { success: true };
  });

  // 月度记录：返回某个月份内当前用户的请假与加班流水，支持月份切换。
  app.get("/ledger", protectedHooks, async (request, reply) => {
    const parsed = z.object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
    }).safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_MONTH", message: "月份格式无效" });
    }
    const month = parsed.data.month ?? beijingTodayIso().slice(0, 7);
    const [year = 0, value = 0] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, value, 0)).getUTCDate();
    const rangeStart = `${month}-01`;
    const rangeEnd = `${month}-${String(lastDay).padStart(2, "0")}`;

    const actor = request.actor!;
    const [leaveResult, overtimeResult] = await Promise.all([
      db.query<{
        id: string;
        leave_type: LeaveType;
        start_date: string;
        end_date: string;
        start_period: string;
        end_period: string;
        requested_days: string;
        requested_hours: string;
        status: string;
        submitted_at: string;
      }>(
        `SELECT id, leave_type, start_date::text, end_date::text,
                start_period, end_period,
                requested_days::text, requested_hours::text, status, submitted_at::text
         FROM leave_requests
         WHERE applicant_id = $1
           AND start_date <= $3 AND end_date >= $2
         ORDER BY start_date DESC, submitted_at DESC`,
        [actor.id, rangeStart, rangeEnd],
      ),
      db.query<{
        id: string;
        duty_date: string;
        hours: string;
        remaining_hours: string;
        content: string;
        status: string;
        expires_at: string;
      }>(
        `SELECT id, duty_date::text, hours::text, remaining_hours::text,
                content, status, expires_at::text
         FROM duty_records
         WHERE user_id = $1 AND duty_date >= $2 AND duty_date <= $3
         ORDER BY duty_date DESC`,
        [actor.id, rangeStart, rangeEnd],
      ),
    ]);

    return {
      month,
      leaves: leaveResult.rows.map((item) => ({
        id: item.id,
        leaveType: item.leave_type,
        leaveTypeLabel: leavePolicies[item.leave_type].label,
        startDate: item.start_date,
        endDate: item.end_date,
        startPeriod: item.start_period,
        endPeriod: item.end_period,
        requestedDays: Number(item.requested_days),
        requestedHours: Number(item.requested_hours),
        status: item.status,
        submittedAt: item.submitted_at,
      })),
      overtime: overtimeResult.rows.map((item) => ({
        id: item.id,
        date: item.duty_date,
        hours: Number(item.hours),
        remainingHours: Number(item.remaining_hours),
        content: item.content,
        status: item.status,
        expiresAt: item.expires_at,
      })),
    };
  });

  app.get("/dashboard", protectedHooks, async (request, reply) => {
    const parsed = z.object({
      expiringDays: z.coerce.number().int().min(1).max(30).default(3),
    }).safeParse(request.query);
    const expiringDays = parsed.success ? parsed.data.expiringDays : 3;
    const actor = request.actor!;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // 先结算已到期额度，与 /overtime/balance 口径一致。
      await client.query(
        `WITH candidates AS (
           SELECT id, user_id, remaining_hours
           FROM duty_records
           WHERE user_id = $1 AND status = 'active' AND expires_at < current_date
           FOR UPDATE
         ), updated AS (
           UPDATE duty_records d
           SET status = 'expired', remaining_hours = 0, updated_at = now(), version = version + 1
           FROM candidates c
           WHERE d.id = c.id
           RETURNING d.id, d.user_id, c.remaining_hours
         )
         INSERT INTO timeoff_ledger (user_id, duty_record_id, entry_type, amount_hours, note)
         SELECT user_id, id, 'expire', -remaining_hours, '加班调休额度到期'
         FROM updated WHERE remaining_hours > 0`,
        [actor.id],
      );

      const overtimeResult = await client.query<{
        available_hours: string;
        nearest_expiry: string | null;
      }>(
        `SELECT COALESCE(SUM(remaining_hours), 0)::text AS available_hours,
                MIN(expires_at)::text AS nearest_expiry
         FROM duty_records
         WHERE user_id = $1 AND status = 'active' AND remaining_hours > 0`,
        [actor.id],
      );

      const expiringResult = await client.query<{
        duty_date: string;
        hours: string;
        remaining_hours: string;
        content: string;
        expires_at: string;
      }>(
        `SELECT duty_date::text, hours::text, remaining_hours::text, content, expires_at::text
         FROM duty_records
         WHERE user_id = $1 AND status = 'active' AND remaining_hours > 0
           AND expires_at >= current_date
           AND expires_at <= current_date + $2::int
         ORDER BY expires_at, duty_date`,
        [actor.id, expiringDays],
      );

      const approvalResult = actor.role === "admin" || actor.role === "super_admin"
        ? await client.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM approval_records a
             JOIN leave_requests l ON l.id = a.leave_request_id
             WHERE a.status = 'pending' AND l.status = 'pending'
               AND ($1 = 'super_admin' OR a.approver_id = $2)`,
            [actor.role, actor.id],
          )
        : null;

      const conflictResult = await client.query<{
        leave_type: LeaveType;
        leave_status: string;
        start_date: string;
        end_date: string;
        date: string;
        duty_content: string;
        duty_hours: string;
      }>(
        `SELECT leave.leave_type, leave.status AS leave_status,
                leave.start_date::text, leave.end_date::text,
                day::date::text AS date,
                duty.content AS duty_content, duty.hours::text AS duty_hours
         FROM leave_requests leave
         CROSS JOIN LATERAL generate_series(leave.start_date, leave.end_date, interval '1 day') AS dates(day)
         JOIN duty_records duty ON duty.user_id = leave.applicant_id
           AND duty.duty_date = day::date
           AND duty.status = 'active'
           AND duty.remaining_hours > 0
         WHERE leave.applicant_id = $1
           AND leave.status IN ('pending', 'approved')
           AND day >= current_date
         ORDER BY day
         LIMIT 20`,
        [actor.id],
      );
      await client.query("COMMIT");

      return {
        overtime: {
          availableHours: Number(overtimeResult.rows[0]?.available_hours ?? 0),
          nearestExpiry: overtimeResult.rows[0]?.nearest_expiry ?? null,
          expiringSoon: expiringResult.rows.map((item) => ({
            date: item.duty_date,
            hours: Number(item.hours),
            remainingHours: Number(item.remaining_hours),
            content: item.content,
            expiresAt: item.expires_at,
          })),
        },
        pendingApprovals: approvalResult ? Number(approvalResult.rows[0]?.count ?? 0) : null,
        dutyConflicts: conflictResult.rows.map((item) => ({
          date: item.date,
          leaveTypeLabel: leavePolicies[item.leave_type].label,
          leaveStatus: item.leave_status,
          startDate: item.start_date,
          endDate: item.end_date,
          dutyContent: item.duty_content,
          dutyHours: Number(item.duty_hours),
        })),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.put("/signature", protectedHooks, async (request, reply) => {
    if (!request.actor || !["admin", "super_admin"].includes(request.actor.role)) {
      return reply.code(403).send({ code: "FORBIDDEN", message: "只有管理员可以维护审批签名" });
    }
    const parsed = signatureSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_SIGNATURE", message: "签名图片无效或文件过大" });
    }

    if (parsed.data.imageData === null) {
      await db.query(
        `UPDATE users
         SET signature_data = NULL, signature_mime_type = NULL,
             signature_updated_at = NULL, updated_at = now()
         WHERE id = $1`,
        [request.actor.id],
      );
      return { success: true, signatureConfigured: false };
    }

    const signature = decodeSignature(parsed.data.imageData);
    if (!signature) {
      return reply.code(400).send({ code: "INVALID_SIGNATURE", message: "请提交有效的 PNG 或 JPEG 签名图片" });
    }
    await db.query(
      `UPDATE users
       SET signature_data = $1, signature_mime_type = $2,
           signature_updated_at = now(), updated_at = now()
       WHERE id = $3`,
      [signature.data, signature.mimeType, request.actor.id],
    );
    return { success: true, signatureConfigured: true };
  });
};
