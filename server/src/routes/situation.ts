import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { loadActiveActor } from "../authz.js";
import { leavePolicies, isWorkdayDate, type LeaveType } from "../business/leave-policy.js";
import { db } from "../db.js";

const querySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  startMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  endMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
}).refine(value => Boolean(value.month || (value.startMonth && value.endMonth)));

function monthNumber(month: string) {
  const [year = 0, value = 0] = month.split("-").map(Number);
  return year * 12 + value;
}

function avatarDataUrl(data: Buffer | null, mimeType: string | null) {
  return data && mimeType ? `data:${mimeType};base64,${data.toString("base64")}` : null;
}

function leavePeriodLabel(item: {
  date: string;
  start_date: string;
  end_date: string;
  start_period: string;
  end_period: string;
}) {
  if (item.start_date === item.end_date) {
    if (item.start_period === "morning" && item.end_period === "morning") return "上午";
    if (item.start_period === "afternoon" && item.end_period === "afternoon") return "下午";
    return "全天";
  }
  if (item.date === item.start_date && item.start_period === "afternoon") return "下午";
  if (item.date === item.end_date && item.end_period === "morning") return "上午";
  return "全天";
}

export const situationRoutes: FastifyPluginAsync = async (app) => {
  const protectedHooks = { onRequest: [app.authenticate, loadActiveActor] };

  app.get("/", protectedHooks, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_MONTH", message: "月份格式无效" });
    }
    const startMonth = parsed.data.month ?? parsed.data.startMonth!;
    const endMonth = parsed.data.month ?? parsed.data.endMonth!;
    if (startMonth > endMonth || monthNumber(endMonth) - monthNumber(startMonth) > 24) {
      return reply.code(400).send({ code: "INVALID_MONTH_RANGE", message: "月份范围无效或超过25个月" });
    }
    const rangeStart = `${startMonth}-01`;
    const rangeEndMonth = `${endMonth}-01`;
    const [leaveResult, overtimeResult, peopleResult] = await Promise.all([
      db.query<{
        id: string;
        date: string;
        person_id: string;
        name: string | null;
        system_name: string | null;
        department: string | null;
        leave_type: LeaveType;
        start_date: string;
        end_date: string;
        start_period: string;
        end_period: string;
        requested_hours: string;
        status: string;
      }>(
        `SELECT leave.id, day::date::text AS date, leave.applicant_id AS person_id, person.name,
                person.bank_project AS system_name, person.department,
                leave.leave_type, leave.start_date::text, leave.end_date::text,
                leave.start_period, leave.end_period, leave.requested_hours::text,
                leave.status
         FROM leave_requests leave
         JOIN users person ON person.id = leave.applicant_id
         CROSS JOIN LATERAL generate_series(leave.start_date, leave.end_date, interval '1 day') AS dates(day)
         WHERE leave.status IN ('pending', 'approved')
           AND day >= $1::date AND day < ($2::date + interval '1 month')
         ORDER BY day, person.name NULLS LAST`,
        [rangeStart, rangeEndMonth],
      ),
      db.query<{
        id: string;
        date: string;
        person_id: string;
        name: string | null;
        system_name: string | null;
        department: string | null;
        hours: string;
        content: string;
      }>(
        `SELECT duty.id, duty.duty_date::text AS date, duty.user_id AS person_id, person.name,
                person.bank_project AS system_name, person.department,
                duty.hours::text, duty.content
         FROM duty_records duty
         JOIN users person ON person.id = duty.user_id
         WHERE duty.duty_date >= $1::date
           AND duty.duty_date < ($2::date + interval '1 month')
           AND duty.status <> 'revoked'
         ORDER BY duty.duty_date, person.name NULLS LAST`,
        [rangeStart, rangeEndMonth],
      ),
      // 头像按人去重单独返回:此前每行展开记录都重复携带头像 bytea(单张可达数百 KB),
      // 跨 25 个月、多行长假时响应体积会爆炸;行上只带 person_id,前端按 id 取头像。
      db.query<{
        id: string;
        name: string | null;
        avatar_data: Buffer | null;
        avatar_mime_type: string | null;
      }>(
        `SELECT DISTINCT person.id, person.name, person.avatar_data, person.avatar_mime_type
         FROM users person
         WHERE person.id IN (
           SELECT applicant_id FROM leave_requests
           WHERE status IN ('pending', 'approved')
             AND start_date < ($2::date + interval '1 month') AND end_date >= $1::date
           UNION
           SELECT user_id FROM duty_records
           WHERE duty_date >= $1::date AND duty_date < ($2::date + interval '1 month')
             AND status <> 'revoked'
         )`,
        [rangeStart, rangeEndMonth],
      ),
    ]);

    // 口径与请假计算一致:法定节假日不计入展示,调休上班日计入。
    const leaves = leaveResult.rows
      .filter(item => isWorkdayDate(item.date))
      .map(item => ({
      id: item.id,
      date: item.date,
      personId: item.person_id,
      name: item.name ?? "未命名用户",
      systemName: item.system_name ?? item.department ?? "未配置所属系统",
      leaveType: item.leave_type,
      leaveTypeLabel: leavePolicies[item.leave_type].label,
      periodLabel: leavePeriodLabel(item),
      requestedHours: Number(item.requested_hours),
      status: item.status,
    }));
    const overtime = overtimeResult.rows.map(item => ({
      id: item.id,
      date: item.date,
      personId: item.person_id,
      name: item.name ?? "未命名用户",
      systemName: item.system_name ?? item.department ?? "未配置所属系统",
      hours: Number(item.hours),
      content: item.content,
    }));
    const people = peopleResult.rows.map(item => ({
      id: item.id,
      name: item.name ?? "未命名用户",
      avatar: avatarDataUrl(item.avatar_data, item.avatar_mime_type),
    }));
    const dayMap = new Map<string, { date: string; leaveCount: number; overtimeCount: number }>();
    for (const item of leaves) {
      const day = dayMap.get(item.date) ?? { date: item.date, leaveCount: 0, overtimeCount: 0 };
      day.leaveCount += 1;
      dayMap.set(item.date, day);
    }
    for (const item of overtime) {
      const day = dayMap.get(item.date) ?? { date: item.date, leaveCount: 0, overtimeCount: 0 };
      day.overtimeCount += 1;
      dayMap.set(item.date, day);
    }
    return {
      startMonth,
      endMonth,
      days: Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
      people,
      leaves,
      overtime,
    };
  });
};
