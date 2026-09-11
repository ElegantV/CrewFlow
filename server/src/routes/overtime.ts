import type { FastifyPluginAsync } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { loadActiveActor } from "../authz.js";
import { isValidDate } from "../business/leave-policy.js";
import { notifyOvertimeApproverPending, notifyOvertimeApproverCancelled, notifyOvertimeCheckIn } from "../business/notify.js";
import { db } from "../db.js";

const createSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  offTime: z.string().regex(/^\d{2}:\d{2}$/),
  hours: z.coerce.number().int().min(2).max(6),
  content: z.string().trim().min(1).max(200),
});

async function expireOvertime(client: PoolClient, userId: string) {
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
    [userId],
  );
}

export const overtimeRoutes: FastifyPluginAsync = async (app) => {
  const protectedHooks = { onRequest: [app.authenticate, loadActiveActor] };

  app.get("/", protectedHooks, async (request) => {
    const actor = request.actor!;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await expireOvertime(client, actor.id);
      const records = await client.query<{
        id: string;
        duty_date: string;
        off_time: string | null;
        hours: string;
        remaining_hours: string;
        content: string;
        expires_at: string;
        status: string;
        approval_comment: string | null;
      }>(
        `SELECT duty.id, duty.duty_date::text, duty.off_time::text, duty.hours::text,
                duty.remaining_hours::text, duty.content, duty.expires_at::text, duty.status,
                approval.comment AS approval_comment
         FROM duty_records duty
         LEFT JOIN approval_records approval ON approval.duty_record_id = duty.id AND approval.step_no = 1
         WHERE duty.user_id = $1
         ORDER BY duty.duty_date DESC, duty.created_at DESC, duty.id`,
        [actor.id],
      );
      await client.query("COMMIT");

      return {
        records: records.rows.map((record) => ({
          id: record.id,
          date: record.duty_date,
          offTime: record.off_time ? record.off_time.slice(0, 5) : null,
          hours: Number(record.hours),
          remainingHours: Number(record.remaining_hours),
          content: record.content,
          expiresAt: record.expires_at,
          status: record.status,
          approvalComment: record.approval_comment,
          canRevoke: record.status === "pending"
            || (record.status === "active" && Number(record.hours) === Number(record.remaining_hours)),
        })),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/balance", protectedHooks, async (request) => {
    const actor = request.actor!;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await expireOvertime(client, actor.id);
      const result = await client.query<{
        available_hours: string;
        nearest_expiry: string | null;
      }>(
        `SELECT COALESCE(SUM(remaining_hours), 0)::text AS available_hours,
                MIN(expires_at)::text AS nearest_expiry
         FROM duty_records
         WHERE user_id = $1 AND status = 'active' AND remaining_hours > 0`,
        [actor.id],
      );
      await client.query("COMMIT");
      return {
        availableHours: Number(result.rows[0]?.available_hours ?? 0),
        nearestExpiry: result.rows[0]?.nearest_expiry ?? null,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/", protectedHooks, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_OVERTIME", message: "请完整填写加班日期、下班时间、加班时长和工作内容，加班时长须为2至6个整小时" });
    }

    if (!isValidDate(parsed.data.date)) {
      return reply.code(400).send({ code: "INVALID_DATE", message: "日期格式不正确" });
    }

    const dateBounds = await db.query<{ today: string; three_months_ago: string }>(
      `SELECT current_date::text AS today,
              (current_date - interval '3 months')::date::text AS three_months_ago`,
    );
    const bounds = dateBounds.rows[0]!;
    if (parsed.data.date > bounds.today) {
      return reply.code(400).send({ code: "FUTURE_OVERTIME", message: "不能登记未来日期的加班" });
    }
    // 补录窗口与额度有效期一致：加班发生超过三个月即过期，不再接受补录。
    if (parsed.data.date < bounds.three_months_ago) {
      return reply.code(400).send({
        code: "OVERTIME_EXPIRED",
        message: "加班发生超过三个月，额度已过期，无法补录",
      });
    }

    const actor = request.actor!;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // 处室要求审批且已分配审批人才走审批流；未分配审批人一律免审批（直接生效）。
      const deptConfig = await client.query<{ overtime_approval_required: boolean }>(
        "SELECT overtime_approval_required FROM departments WHERE name = $1",
        [actor.department],
      );
      const requiresApproval = Boolean(actor.managerId) && (deptConfig.rows[0]?.overtime_approval_required ?? false);
      if (requiresApproval) {
        const manager = await client.query<{ role: string; status: string }>(
          "SELECT role, status FROM users WHERE id = $1 FOR SHARE",
          [actor.managerId],
        );
        if (!manager.rows[0] || manager.rows[0].status !== "active" || !["admin", "super_admin"].includes(manager.rows[0].role)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ code: "MANAGER_UNAVAILABLE", message: "审批管理员当前不可用" });
        }
      }
      const inserted = await client.query<{
        id: string;
        expires_at: string;
      }>(
        `INSERT INTO duty_records
           (user_id, duty_date, off_time, hours, remaining_hours, content, expires_at, status)
         VALUES ($1, $2, $3::time, $4, $5, $6, ($2::date + interval '3 months')::date,
                 CASE WHEN $7 THEN 'pending' ELSE 'active' END)
         RETURNING id, expires_at::text`,
        [actor.id, parsed.data.date, parsed.data.offTime, parsed.data.hours,
          requiresApproval ? 0 : parsed.data.hours, parsed.data.content, requiresApproval],
      );
      const record = inserted.rows[0]!;
      if (requiresApproval) {
        await client.query(
          `INSERT INTO approval_records (duty_record_id, step_no, approver_id)
           VALUES ($1, 1, $2)`,
          [record.id, actor.managerId],
        );
      } else {
        await client.query(
          `INSERT INTO timeoff_ledger
             (user_id, duty_record_id, entry_type, amount_hours, note)
           VALUES ($1, $2, 'earn', $3, '登记加班产生调休额度')`,
          [actor.id, record.id, parsed.data.hours],
        );
      }
      await client.query("COMMIT");
      if (requiresApproval) {
        // 提交成功后异步提醒审批管理员（wxpusher），不阻塞响应。
        void notifyOvertimeApproverPending(record.id);
      } else {
        // 登记成功后异步推送打卡提醒（wxpusher），不阻塞响应。
        void notifyOvertimeCheckIn(actor.id, parsed.data.date, parsed.data.offTime, parsed.data.hours);
      }
      return reply.code(201).send({
        id: record.id,
        hours: parsed.data.hours,
        expiresAt: record.expires_at,
        status: requiresApproval ? "pending" : "active",
        approvalRequired: requiresApproval,
      });
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      if (typeof error === "object" && error && "code" in error && error.code === "23505") {
        return reply.code(409).send({ code: "OVERTIME_DUPLICATE", message: "该日期已经登记过加班" });
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/:id/revoke", protectedHooks, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
    if (!id.success) {
      return reply.code(400).send({ code: "INVALID_ID", message: "加班记录编号无效" });
    }

    const actor = request.actor!;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        id: string;
        hours: string;
        remaining_hours: string;
        status: string;
      }>(
        `SELECT id, hours::text, remaining_hours::text, status
         FROM duty_records WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id.data, actor.id],
      );
      const record = result.rows[0];
      if (!record) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ code: "OVERTIME_NOT_FOUND", message: "加班记录不存在" });
      }
      // 待审批的加班可撤回：无调休额度产生，同步取消审批任务。
      if (record.status === "pending") {
        await client.query(
          `UPDATE duty_records
           SET status = 'revoked', remaining_hours = 0, updated_at = now(), version = version + 1
           WHERE id = $1`,
          [record.id],
        );
        await client.query(
          `UPDATE approval_records
           SET status = 'cancelled', decided_at = COALESCE(decided_at, now())
           WHERE duty_record_id = $1`,
          [record.id],
        );
        await client.query("COMMIT");
        // 提交成功后异步提醒审批人无需再处理（wxpusher），不阻塞响应。
        void notifyOvertimeApproverCancelled(record.id);
        return { success: true };
      }
      if (record.status !== "active" || Number(record.hours) !== Number(record.remaining_hours)) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          code: "OVERTIME_IN_USE",
          message: "该加班已被调休申请使用，请先撤销对应请假",
        });
      }

      await client.query(
        `UPDATE duty_records
         SET status = 'revoked', remaining_hours = 0, updated_at = now(), version = version + 1
         WHERE id = $1`,
        [record.id],
      );
      await client.query(
        `INSERT INTO timeoff_ledger
           (user_id, duty_record_id, entry_type, amount_hours, note)
         VALUES ($1, $2, 'adjust', $3, '撤销加班记录')`,
        [actor.id, record.id, -Number(record.remaining_hours)],
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
