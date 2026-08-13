import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { loadActiveActor } from "../authz.js";
import { buildApprovalResult, type ApprovalResultSnapshot } from "../business/approval-result.js";
import { renderLeavePdf } from "../business/leave-pdf.js";
import {
  addWorkdays,
  calculateWorkingHours,
  isValidDate,
  leavePolicies,
  publicLeavePolicies,
  validatePeriodRange,
  type LeaveType,
} from "../business/leave-policy.js";
import { notifyApproverPending } from "../business/subscribe-notify.js";
import { allocateTimeoff, releaseTimeoff } from "../business/timeoff.js";
import { db } from "../db.js";

const leaveTypeValues = [
  "comp_time",
  "public_out",
  "breastfeeding",
  "annual",
  "sick",
  "personal",
  "prenatal",
  "maternity",
  "parental",
  "bereavement",
  "marriage",
  "paternity",
] as const;

const createSchema = z.object({
  leaveType: z.enum(leaveTypeValues),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startPeriod: z.enum(["morning", "afternoon", "day"]).default("day"),
  endPeriod: z.enum(["morning", "afternoon", "day"]).default("day"),
  reason: z.string().trim().max(500).optional(),
});

export const leaveRoutes: FastifyPluginAsync = async (app) => {
  const protectedHooks = { onRequest: [app.authenticate, loadActiveActor] };

  app.get("/types", protectedHooks, async () => ({ types: publicLeavePolicies() }));

  app.get("/", protectedHooks, async (request) => {
    const result = await db.query<{
      id: string;
      leave_type: LeaveType;
      start_date: string;
      end_date: string;
      start_period: string;
      end_period: string;
      requested_days: string;
      requested_hours: string;
      reason: string | null;
      status: string;
      submitted_at: string;
      agent_name: string | null;
      approver_name: string | null;
      approval_status: string | null;
      approval_comment: string | null;
    }>(
      `SELECT l.id, l.leave_type, l.start_date::text, l.end_date::text,
              l.start_period, l.end_period, l.requested_days::text,
              l.requested_hours::text, l.reason,
              l.status, l.submitted_at::text,
              agent.name AS agent_name, approver.name AS approver_name,
              approval.status AS approval_status, approval.comment AS approval_comment
       FROM leave_requests l
       LEFT JOIN users agent ON agent.id = l.agent_user_id
       LEFT JOIN approval_records approval ON approval.leave_request_id = l.id AND approval.step_no = 1
       LEFT JOIN users approver ON approver.id = approval.approver_id
       WHERE l.applicant_id = $1
       ORDER BY l.submitted_at DESC`,
      [request.actor!.id],
    );

    return {
      requests: result.rows.map((item) => ({
        id: item.id,
        leaveType: item.leave_type,
        leaveTypeLabel: leavePolicies[item.leave_type].label,
        startDate: item.start_date,
        endDate: item.end_date,
        startPeriod: item.start_period,
        endPeriod: item.end_period,
        requestedDays: Number(item.requested_days),
        requestedHours: Number(item.requested_hours),
        reason: item.reason,
        status: item.status,
        submittedAt: item.submitted_at,
        agentName: item.agent_name,
        approval: item.approval_status ? {
          approverName: item.approver_name,
          status: item.approval_status,
          comment: item.approval_comment,
        } : null,
      })),
    };
  });

  app.post("/", protectedHooks, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_LEAVE", message: "请完整填写请假信息" });
    }

    const actor = request.actor!;
    const policy = leavePolicies[parsed.data.leaveType];
    let endDate = parsed.data.endDate ?? parsed.data.startDate;
    let startPeriod = parsed.data.startPeriod;
    let endPeriod = parsed.data.endPeriod;

    if (!isValidDate(parsed.data.startDate) || !isValidDate(endDate)) {
      return reply.code(400).send({ code: "INVALID_DATE", message: "日期格式不正确" });
    }

    if ("fixedWorkdays" in policy) {
      endDate = addWorkdays(parsed.data.startDate, policy.fixedWorkdays);
      startPeriod = "day";
      endPeriod = "day";
    }
    if (endDate < parsed.data.startDate) {
      return reply.code(400).send({ code: "INVALID_DATE_RANGE", message: "结束日期不能早于开始日期" });
    }
    if (!validatePeriodRange(parsed.data.startDate, endDate, startPeriod, endPeriod)) {
      return reply.code(400).send({
        code: "INVALID_PERIOD_RANGE",
        message: startPeriod === "afternoon" && endPeriod === "morning"
          ? "同一天请假时，结束时段不能早于开始时段"
          : "同一天选择全天时，开始和结束时段都必须选择全天",
      });
    }

    const requestedHours = calculateWorkingHours(parsed.data.startDate, endDate, startPeriod, endPeriod);
    if (requestedHours === 0) {
      return reply.code(400).send({
        code: "NO_WORKDAY_IN_RANGE",
        message: "所选日期没有工作日（周一至周五），请重新选择",
      });
    }
    if (requestedHours < policy.minimumHours || requestedHours % policy.incrementHours !== 0) {
      return reply.code(400).send({
        code: "INVALID_LEAVE_DURATION",
        message: `${policy.label}最少${policy.minimumHours}小时，并须按${policy.incrementHours}小时递增`,
      });
    }
    if ("fixedWorkdays" in policy && requestedHours !== policy.fixedWorkdays * 8) {
      return reply.code(400).send({ code: "FIXED_LEAVE_REQUIRED", message: `${policy.label}必须一次性休完` });
    }
    if (!actor.managerId) {
      return reply.code(409).send({ code: "MANAGER_NOT_ASSIGNED", message: "尚未配置审批管理员" });
    }
    if (actor.personnelType !== "bank" && !actor.agentUserId) {
      return reply.code(409).send({ code: "AGENT_NOT_ASSIGNED", message: "请先在个人信息中维护工作代理人" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const manager = await client.query<{ role: string; status: string }>(
        "SELECT role, status FROM users WHERE id = $1 FOR SHARE",
        [actor.managerId],
      );
      if (!manager.rows[0] || manager.rows[0].status !== "active" || !["admin", "super_admin"].includes(manager.rows[0].role)) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ code: "MANAGER_UNAVAILABLE", message: "审批管理员当前不可用" });
      }
      if (actor.agentUserId) {
        const agent = await client.query(
          "SELECT 1 FROM users WHERE id = $1 AND status = 'active' AND personnel_type <> 'bank' FOR SHARE",
          [actor.agentUserId],
        );
        if (!agent.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ code: "AGENT_UNAVAILABLE", message: "工作代理人当前不可用或不是非行员" });
        }
      }

      const overlap = await client.query<{
        id: string;
        start_date: string;
        end_date: string;
      }>(
        `SELECT id, start_date::text, end_date::text
         FROM leave_requests
         WHERE applicant_id = $1
           AND status IN ('pending', 'approved')
           AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
         LIMIT 1
         FOR UPDATE`,
        [actor.id, parsed.data.startDate, endDate],
      );
      if (overlap.rows[0]) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          code: "LEAVE_OVERLAP",
          message: `该时段与已有申请 ${overlap.rows[0].start_date} 至 ${overlap.rows[0].end_date} 重复`,
          conflict: overlap.rows[0],
        });
      }

      if (parsed.data.leaveType === "marriage" || parsed.data.leaveType === "paternity") {
        const used = await client.query(
          `SELECT 1 FROM leave_requests
           WHERE applicant_id = $1 AND leave_type = $2 AND status IN ('pending', 'approved')
           LIMIT 1 FOR UPDATE`,
          [actor.id, parsed.data.leaveType],
        );
        if (used.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ code: "FIXED_LEAVE_ALREADY_USED", message: `${policy.label}只能一次性申请` });
        }
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO leave_requests
           (applicant_id, agent_user_id, leave_type, start_date, end_date,
            start_period, end_period, requested_days, requested_hours, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          actor.id,
          actor.agentUserId,
          parsed.data.leaveType,
          parsed.data.startDate,
          endDate,
          startPeriod,
          endPeriod,
          requestedHours / 8,
          requestedHours,
          parsed.data.reason ?? null,
        ],
      );
      const leaveRequestId = inserted.rows[0]!.id;

      if (parsed.data.leaveType === "comp_time") {
        const allocation = await allocateTimeoff(client, actor.id, leaveRequestId, requestedHours);
        if (!allocation.success) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            code: "INSUFFICIENT_TIMEOFF",
            message: `可用调休仅${allocation.availableHours}小时，不足${requestedHours}小时`,
            availableHours: allocation.availableHours,
          });
        }
      }

      await client.query(
        `INSERT INTO approval_records (leave_request_id, step_no, approver_id)
         VALUES ($1, 1, $2)`,
        [leaveRequestId, actor.managerId],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, details)
         VALUES ($1, 'leave.submit', 'leave_request', $2, $3::jsonb)`,
        [actor.id, leaveRequestId, JSON.stringify({ leaveType: parsed.data.leaveType, requestedHours })],
      );

      // 值日协同：请假日期与已登记值班重叠时给出预警，不阻断申请。
      const dutyOverlap = await client.query<{
        duty_date: string;
        hours: string;
        content: string;
      }>(
        `SELECT duty_date::text, hours::text, content
         FROM duty_records
         WHERE user_id = $1 AND status = 'active'
           AND duty_date BETWEEN $2 AND $3
         ORDER BY duty_date`,
        [actor.id, parsed.data.startDate, endDate],
      );

      await client.query("COMMIT");
      // 事务提交后异步通知审批管理员，不阻塞也不影响本次响应。
      void notifyApproverPending(leaveRequestId);
      return reply.code(201).send({
        id: leaveRequestId,
        requestedHours,
        requestedDays: requestedHours / 8,
        endDate,
        status: "pending",
        warnings: dutyOverlap.rows.map((item) => ({
          code: "DUTY_OVERLAP",
          message: `请假日期与 ${item.duty_date} 已登记值班（${item.hours} 小时 · ${item.content}）重叠，请确认工作安排`,
        })),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/:id/approval-result", protectedHooks, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
    if (!id.success) {
      return reply.code(400).send({ code: "INVALID_ID", message: "请假申请编号无效" });
    }
    const actor = request.actor!;
    const client = await db.connect();
    try {
      const result = await client.query<{
        status: string;
        result_snapshot: ApprovalResultSnapshot | null;
      }>(
        `SELECT leave.status, approval.result_snapshot
         FROM leave_requests leave
         JOIN approval_records approval ON approval.leave_request_id = leave.id AND approval.step_no = 1
         WHERE leave.id = $1 AND leave.applicant_id = $2`,
        [id.data, actor.id],
      );
      const leave = result.rows[0];
      if (!leave) {
        return reply.code(404).send({ code: "LEAVE_NOT_FOUND", message: "请假申请不存在或无权查看" });
      }
      if (leave.status !== "approved") {
        return reply.code(409).send({ code: "LEAVE_NOT_APPROVED", message: "申请通过后才能查看审批结果" });
      }
      return { result: leave.result_snapshot ?? await buildApprovalResult(client, id.data) };
    } finally {
      client.release();
    }
  });

  app.get("/:id/pdf", protectedHooks, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
    if (!id.success) {
      return reply.code(400).send({ code: "INVALID_ID", message: "请假申请编号无效" });
    }
    const actor = request.actor!;
    const client = await db.connect();
    try {
      const result = await client.query<{
        status: string;
        applicant_name: string | null;
        agent_name: string | null;
        leave_type: LeaveType;
        start_date: string;
        end_date: string;
        start_period: "morning" | "afternoon" | "day";
        end_period: "morning" | "afternoon" | "day";
        requested_days: string;
        approval_comment: string | null;
        decided_at: string | null;
        result_snapshot: ApprovalResultSnapshot | null;
        signer_name: string | null;
        signature_data: Buffer | null;
      }>(
        `SELECT leave.status, applicant.name AS applicant_name, agent.name AS agent_name,
                leave.leave_type, leave.start_date::text, leave.end_date::text,
                leave.start_period, leave.end_period, leave.requested_days::text,
                approval.comment AS approval_comment, approval.decided_at::text,
                approval.result_snapshot,
                COALESCE(approval.signer_name, approver.name) AS signer_name,
                COALESCE(approval.signature_data, approver.signature_data) AS signature_data
         FROM leave_requests leave
         JOIN users applicant ON applicant.id = leave.applicant_id
         LEFT JOIN users agent ON agent.id = leave.agent_user_id
         JOIN approval_records approval ON approval.leave_request_id = leave.id AND approval.step_no = 1
         JOIN users approver ON approver.id = approval.approver_id
         WHERE leave.id = $1 AND leave.applicant_id = $2`,
        [id.data, actor.id],
      );
      const leave = result.rows[0];
      if (!leave) {
        return reply.code(404).send({ code: "LEAVE_NOT_FOUND", message: "请假申请不存在或无权下载" });
      }
      if (leave.status !== "approved" || !leave.decided_at) {
        return reply.code(409).send({ code: "LEAVE_NOT_APPROVED", message: "申请通过后才能下载请假单" });
      }
      if (!leave.signature_data) {
        return reply.code(409).send({ code: "SIGNATURE_MISSING", message: "审批记录缺少管理员签名，暂不能生成请假单" });
      }
      const approvalResult = leave.result_snapshot ?? await buildApprovalResult(client, id.data);
      const pdf = await renderLeavePdf({
        applicantName: leave.applicant_name ?? "未命名用户",
        agentName: leave.agent_name ?? "—",
        leaveTypeLabel: leavePolicies[leave.leave_type].label,
        startDate: leave.start_date,
        endDate: leave.end_date,
        startPeriod: leave.start_period,
        endPeriod: leave.end_period,
        requestedDays: Number(leave.requested_days),
        approvalText: approvalResult.text,
        approvalComment: leave.approval_comment,
        approverName: leave.signer_name ?? "未命名管理员",
        decidedAt: leave.decided_at,
        signatureData: leave.signature_data,
      });
      const filename = `${leave.applicant_name ?? "员工"}_${leave.start_date.replaceAll("-", "")}_请假单.pdf`;
      return reply
        .type("application/pdf")
        .header("Content-Disposition", `attachment; filename="leave-request.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .send(pdf);
    } finally {
      client.release();
    }
  });

  app.post("/:id/cancel", protectedHooks, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
    if (!id.success) {
      return reply.code(400).send({ code: "INVALID_ID", message: "请假申请编号无效" });
    }

    const actor = request.actor!;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ status: string; leave_type: LeaveType }>(
        `SELECT status, leave_type FROM leave_requests
         WHERE id = $1 AND applicant_id = $2 FOR UPDATE`,
        [id.data, actor.id],
      );
      const leave = result.rows[0];
      if (!leave) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ code: "LEAVE_NOT_FOUND", message: "请假申请不存在" });
      }
      // 网络重试或连续点击不应把已成功撤销显示成错误。
      if (leave.status === "cancelled") {
        await client.query("COMMIT");
        return { success: true, alreadyCancelled: true };
      }
      if (!["pending", "approved"].includes(leave.status)) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ code: "LEAVE_NOT_CANCELLABLE", message: "该申请当前不能撤销" });
      }

      if (leave.leave_type === "comp_time") {
        await releaseTimeoff(client, actor.id, id.data, "撤销请假，退回原加班记录");
      }
      await client.query(
        "UPDATE leave_requests SET status = 'cancelled', updated_at = now() WHERE id = $1",
        [id.data],
      );
      await client.query(
        `UPDATE approval_records
         SET status = 'cancelled', decided_at = COALESCE(decided_at, now())
         WHERE leave_request_id = $1`,
        [id.data],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
         VALUES ($1, 'leave.cancel', 'leave_request', $2)`,
        [actor.id, id.data],
      );
      await client.query("COMMIT");
      return { success: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
};
