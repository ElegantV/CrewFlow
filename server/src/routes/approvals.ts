import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { allowRoles, loadActiveActor } from "../authz.js";
import { buildApprovalResult, type ApprovalResultSnapshot } from "../business/approval-result.js";
import { leavePolicies, type LeaveType } from "../business/leave-policy.js";
import { releaseTimeoff } from "../business/timeoff.js";
import { db } from "../db.js";

const decisionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  comment: z.string().trim().max(500).optional(),
}).refine((value) => value.action !== "reject" || Boolean(value.comment), {
  message: "驳回时必须填写原因",
});

export const approvalRoutes: FastifyPluginAsync = async (app) => {
  const approvalHooks = {
    onRequest: [app.authenticate, loadActiveActor, allowRoles("admin", "super_admin")],
  };

  app.get("/pending", approvalHooks, async (request) => {
    const actor = request.actor!;
    const result = await db.query<{
      approval_id: string;
      leave_request_id: string;
      applicant_id: string;
      applicant_name: string | null;
      agent_name: string | null;
      leave_type: LeaveType;
      start_date: string;
      end_date: string;
      requested_days: string;
      requested_hours: string;
      reason: string | null;
      submitted_at: string;
    }>(
      `SELECT a.id AS approval_id, l.id AS leave_request_id,
              l.applicant_id, applicant.name AS applicant_name,
              agent.name AS agent_name, l.leave_type,
              l.start_date::text, l.end_date::text,
              l.requested_days::text, l.requested_hours::text,
              l.reason,
              l.submitted_at::text
       FROM approval_records a
       JOIN leave_requests l ON l.id = a.leave_request_id
       JOIN users applicant ON applicant.id = l.applicant_id
       LEFT JOIN users agent ON agent.id = l.agent_user_id
       WHERE a.status = 'pending'
         AND l.status = 'pending'
         AND ($1 = 'super_admin' OR a.approver_id = $2)
       ORDER BY l.submitted_at`,
      [actor.role, actor.id],
    );

    return {
      approvals: result.rows.map((item) => ({
        id: item.approval_id,
        leaveRequestId: item.leave_request_id,
        applicant: { id: item.applicant_id, name: item.applicant_name },
        agentName: item.agent_name,
        leaveType: item.leave_type,
        leaveTypeLabel: leavePolicies[item.leave_type].label,
        startDate: item.start_date,
        endDate: item.end_date,
        requestedDays: Number(item.requested_days),
        requestedHours: Number(item.requested_hours),
        reason: item.reason,
        submittedAt: item.submitted_at,
      })),
    };
  });

  app.get("/history", approvalHooks, async (request) => {
    const actor = request.actor!;
    const result = await db.query<{
      approval_id: string;
      leave_request_id: string;
      applicant_name: string | null;
      leave_type: LeaveType;
      start_date: string;
      end_date: string;
      requested_days: string;
      requested_hours: string;
      decided_at: string;
    }>(
      `SELECT approval.id AS approval_id, leave.id AS leave_request_id,
              applicant.name AS applicant_name, leave.leave_type,
              leave.start_date::text, leave.end_date::text,
              leave.requested_days::text, leave.requested_hours::text,
              approval.decided_at::text
       FROM approval_records approval
       JOIN leave_requests leave ON leave.id = approval.leave_request_id
       JOIN users applicant ON applicant.id = leave.applicant_id
       WHERE approval.status = 'approved'
         AND leave.status = 'approved'
         AND ($1 = 'super_admin' OR approval.approver_id = $2)
       ORDER BY approval.decided_at DESC
       LIMIT 50`,
      [actor.role, actor.id],
    );
    return {
      approvals: result.rows.map((item) => ({
        id: item.approval_id,
        leaveRequestId: item.leave_request_id,
        applicantName: item.applicant_name,
        leaveType: item.leave_type,
        leaveTypeLabel: leavePolicies[item.leave_type].label,
        startDate: item.start_date,
        endDate: item.end_date,
        requestedDays: Number(item.requested_days),
        requestedHours: Number(item.requested_hours),
        decidedAt: item.decided_at,
      })),
    };
  });

  app.post("/:id/decision", approvalHooks, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
    const body = decisionSchema.safeParse(request.body);
    if (!id.success || !body.success) {
      return reply.code(400).send({ code: "INVALID_DECISION", message: "审批操作无效，驳回时必须填写原因" });
    }

    const actor = request.actor!;
    const client = await db.connect();
    let approvalResult: ApprovalResultSnapshot | null = null;
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        approval_status: string;
        approver_id: string;
        leave_request_id: string;
        leave_status: string;
        leave_type: LeaveType;
        applicant_id: string;
      }>(
        `SELECT a.status AS approval_status, a.approver_id, a.leave_request_id,
                l.status AS leave_status, l.leave_type, l.applicant_id
         FROM approval_records a
         JOIN leave_requests l ON l.id = a.leave_request_id
         WHERE a.id = $1
         FOR UPDATE OF a, l`,
        [id.data],
      );
      const approval = result.rows[0];
      if (!approval) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ code: "APPROVAL_NOT_FOUND", message: "审批任务不存在" });
      }
      if (actor.role !== "super_admin" && approval.approver_id !== actor.id) {
        await client.query("ROLLBACK");
        return reply.code(403).send({ code: "FORBIDDEN", message: "该申请不属于你的审批范围" });
      }
      if (approval.approval_status !== "pending" || approval.leave_status !== "pending") {
        await client.query("ROLLBACK");
        return reply.code(409).send({ code: "APPROVAL_ALREADY_DECIDED", message: "该申请已处理，请勿重复审批" });
      }

      const nextStatus = body.data.action === "approve" ? "approved" : "rejected";
      let signer: { name: string | null; signature_data: Buffer | null; signature_mime_type: string | null } | null = null;
      if (nextStatus === "approved") {
        const signerResult = await client.query<{
          name: string | null;
          signature_data: Buffer | null;
          signature_mime_type: string | null;
        }>(
          `SELECT name, signature_data, signature_mime_type
           FROM users WHERE id = $1 FOR SHARE`,
          [actor.id],
        );
        signer = signerResult.rows[0] ?? null;
        if (!signer?.signature_data || !signer.signature_mime_type) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            code: "SIGNATURE_REQUIRED",
            message: "请先在个人信息中录入审批签名，再通过申请",
          });
        }
      }
      if (nextStatus === "rejected" && approval.leave_type === "comp_time") {
        await releaseTimeoff(
          client,
          approval.applicant_id,
          approval.leave_request_id,
          "请假被驳回，退回原加班记录",
        );
      }

      await client.query(
        `UPDATE approval_records
         SET status = $1, comment = $2, decided_at = now()
         WHERE id = $3`,
        [nextStatus, body.data.comment ?? null, id.data],
      );
      await client.query(
        `UPDATE leave_requests
         SET status = $1, decided_at = now(), updated_at = now()
         WHERE id = $2`,
        [nextStatus, approval.leave_request_id],
      );
      if (nextStatus === "approved" && signer?.signature_data && signer.signature_mime_type) {
        approvalResult = await buildApprovalResult(client, approval.leave_request_id);
        await client.query(
          `UPDATE approval_records
           SET result_snapshot = $1::jsonb, signer_name = $2,
               signature_data = $3, signature_mime_type = $4
           WHERE id = $5`,
          [
            JSON.stringify(approvalResult),
            signer.name ?? "未命名管理员",
            signer.signature_data,
            signer.signature_mime_type,
            id.data,
          ],
        );
      }
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, details)
         VALUES ($1, $2, 'leave_request', $3, $4::jsonb)`,
        [
          actor.id,
          `leave.${body.data.action}`,
          approval.leave_request_id,
          JSON.stringify({ comment: body.data.comment ?? null }),
        ],
      );
      await client.query("COMMIT");
      // 审批结果仅固化到记录中，由申请人查看、复制和下载。
      return { success: true, status: nextStatus };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
};
