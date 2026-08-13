import type { PoolClient } from "pg";

export async function allocateTimeoff(
  client: PoolClient,
  userId: string,
  leaveRequestId: string,
  requestedHours: number,
) {
  const overtime = await client.query<{
    id: string;
    remaining_hours: string;
  }>(
    `SELECT id, remaining_hours::text
     FROM duty_records
     WHERE user_id = $1
       AND status = 'active'
       AND remaining_hours > 0
       AND expires_at >= current_date
     ORDER BY expires_at ASC, duty_date ASC, created_at ASC
     FOR UPDATE`,
    [userId],
  );

  const availableHours = overtime.rows.reduce((sum, item) => sum + Number(item.remaining_hours), 0);
  if (availableHours < requestedHours) {
    return { success: false as const, availableHours };
  }

  let remaining = requestedHours;
  for (const record of overtime.rows) {
    if (remaining <= 0) break;
    const remainingBefore = Number(record.remaining_hours);
    const used = Math.min(remaining, remainingBefore);
    const remainingAfter = remainingBefore - used;
    await client.query(
      `UPDATE duty_records
       SET remaining_hours = remaining_hours - $1,
           status = CASE WHEN remaining_hours - $1 = 0 THEN 'consumed' ELSE 'active' END,
           updated_at = now(), version = version + 1
       WHERE id = $2`,
      [used, record.id],
    );
    await client.query(
      `INSERT INTO timeoff_allocations
         (leave_request_id, duty_record_id, hours, remaining_before, remaining_after)
       VALUES ($1, $2, $3, $4, $5)`,
      [leaveRequestId, record.id, used, remainingBefore, remainingAfter],
    );
    await client.query(
      `INSERT INTO timeoff_ledger
         (user_id, duty_record_id, leave_request_id, entry_type, amount_hours, note)
       VALUES ($1, $2, $3, 'use', $4, '请假申请预占调休')`,
      [userId, record.id, leaveRequestId, -used],
    );
    remaining -= used;
  }

  return { success: true as const, availableHours };
}

export async function releaseTimeoff(
  client: PoolClient,
  userId: string,
  leaveRequestId: string,
  reason: string,
) {
  const allocations = await client.query<{
    id: string;
    duty_record_id: string;
    hours: string;
    remaining_hours: string;
    expires_at: string;
  }>(
    `SELECT a.id, a.duty_record_id, a.hours::text,
            d.remaining_hours::text, d.expires_at::text
     FROM timeoff_allocations a
     JOIN duty_records d ON d.id = a.duty_record_id
     WHERE a.leave_request_id = $1 AND a.status = 'allocated'
     ORDER BY d.expires_at, d.duty_date
     FOR UPDATE OF a, d`,
    [leaveRequestId],
  );

  for (const allocation of allocations.rows) {
    const hours = Number(allocation.hours);
    const expired = await client.query<{ expired: boolean }>(
      "SELECT $1::date < current_date AS expired",
      [allocation.expires_at],
    );

    await client.query(
      `UPDATE timeoff_allocations SET status = 'released', released_at = now() WHERE id = $1`,
      [allocation.id],
    );
    await client.query(
      `INSERT INTO timeoff_ledger
         (user_id, duty_record_id, leave_request_id, entry_type, amount_hours, note)
       VALUES ($1, $2, $3, 'refund', $4, $5)`,
      [userId, allocation.duty_record_id, leaveRequestId, hours, reason],
    );

    if (expired.rows[0]?.expired) {
      const expiredHours = Number(allocation.remaining_hours) + hours;
      await client.query(
        `UPDATE duty_records
         SET status = 'expired', remaining_hours = 0,
             updated_at = now(), version = version + 1
         WHERE id = $1`,
        [allocation.duty_record_id],
      );
      await client.query(
        `INSERT INTO timeoff_ledger
           (user_id, duty_record_id, leave_request_id, entry_type, amount_hours, note)
         VALUES ($1, $2, $3, 'expire', $4, '退回时原加班记录已到期')`,
        [userId, allocation.duty_record_id, leaveRequestId, -expiredHours],
      );
    } else {
      await client.query(
        `UPDATE duty_records
         SET remaining_hours = remaining_hours + $1, status = 'active',
             updated_at = now(), version = version + 1
         WHERE id = $2`,
        [hours, allocation.duty_record_id],
      );
    }
  }
}
