import type { FastifyPluginAsync } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { loadActiveActor } from "../authz.js";
import { isValidDate } from "../business/leave-policy.js";
import { db } from "../db.js";

const createSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hours: z.coerce.number().int().min(2).max(6).optional(),
  // 暂时兼容仍提交结束时间的旧版小程序。
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  content: z.string().trim().min(1).max(200),
}).refine((data) => data.hours !== undefined || data.endTime !== undefined, {
  message: "hours or endTime is required",
});

function minutes(time: string) {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return hour * 60 + minute;
}

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
        start_time: string;
        end_time: string;
        hours: string;
        remaining_hours: string;
        content: string;
        expires_at: string;
        status: string;
      }>(
        `SELECT id, duty_date::text, start_time::text, end_time::text, hours::text,
                remaining_hours::text, content, expires_at::text, status
         FROM duty_records
         WHERE user_id = $1
         ORDER BY duty_date DESC, created_at DESC`,
        [actor.id],
      );
      await client.query("COMMIT");

      return {
        records: records.rows.map((record) => ({
          id: record.id,
          date: record.duty_date,
          startTime: record.start_time.slice(0, 5),
          endTime: record.end_time.slice(0, 5),
          hours: Number(record.hours),
          remainingHours: Number(record.remaining_hours),
          content: record.content,
          expiresAt: record.expires_at,
          status: record.status,
          canRevoke: record.status === "active" && Number(record.hours) === Number(record.remaining_hours),
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
      return reply.code(400).send({ code: "INVALID_OVERTIME", message: "请完整填写加班日期、加班时长和工作内容，加班时长须为2至6个整小时" });
    }

    if (!isValidDate(parsed.data.date)) {
      return reply.code(400).send({ code: "INVALID_DATE", message: "日期格式不正确" });
    }

    const startMinutes = minutes("17:30");
    const endMinutes = parsed.data.hours !== undefined
      ? startMinutes + parsed.data.hours * 60
      : minutes(parsed.data.endTime!);
    if (endMinutes < minutes("19:30") || endMinutes > minutes("23:30")) {
      return reply.code(400).send({
        code: "INVALID_OVERTIME_TIME",
        message: "加班从17:30开始，至少2小时，结束时间须在19:30至23:30之间",
      });
    }

    const dateBounds = await db.query<{ today: string }>(
      `SELECT current_date::text AS today`,
    );
    const bounds = dateBounds.rows[0]!;
    if (parsed.data.date > bounds.today) {
      return reply.code(400).send({ code: "FUTURE_OVERTIME", message: "不能登记未来日期的加班" });
    }

    const hours = parsed.data.hours ?? Math.floor((endMinutes - startMinutes) / 60);
    const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
    const actor = request.actor!;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{
        id: string;
        expires_at: string;
      }>(
        `INSERT INTO duty_records
           (user_id, duty_date, start_time, end_time, hours, remaining_hours, content, expires_at)
         VALUES ($1, $2, '17:30', $3, $4, $4, $5, ($2::date + interval '3 months')::date)
         RETURNING id, expires_at::text`,
        [actor.id, parsed.data.date, endTime, hours, parsed.data.content],
      );
      const record = inserted.rows[0]!;
      await client.query(
        `INSERT INTO timeoff_ledger
           (user_id, duty_record_id, entry_type, amount_hours, note)
         VALUES ($1, $2, 'earn', $3, '登记加班产生调休额度')`,
        [actor.id, record.id, hours],
      );
      await client.query("COMMIT");
      return reply.code(201).send({ id: record.id, hours, expiresAt: record.expires_at });
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
