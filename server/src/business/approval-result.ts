import type { PoolClient } from "pg";
import { leavePolicies, type LeaveType } from "./leave-policy.js";

export type ApprovalResultSnapshot = {
  leaveRequestId: string;
  leaveType: LeaveType;
  leaveTypeLabel: string;
  requestedDays: number;
  requestedHours: number;
  asOfDate: string;
  allocations: Array<{
    dutyDate: string;
    earnedHours: number;
    balanceBefore: number;
    usedHours: number;
    balanceAfter: number;
    reusedRemainder: boolean;
  }>;
  annualSummary: null | {
    totalHours: number;
    usedHours: number;
    remainingHours: number;
    expiredHours: number;
  };
  text: string;
};

function numberText(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function formatText(snapshot: Omit<ApprovalResultSnapshot, "text">) {
  const lines = [
    `本次申请【${numberText(snapshot.requestedDays)}天】${snapshot.leaveTypeLabel}；`,
  ];

  for (const item of snapshot.allocations) {
    const balance = item.reusedRemainder
      ? `使用上次调休剩余${numberText(item.balanceBefore)}小时`
      : `可用调休${numberText(item.balanceBefore)}小时`;
    lines.push(
      `${item.dutyDate} ${balance}，本次使用${numberText(item.usedHours)}小时，剩余${numberText(item.balanceAfter)}小时；`,
    );
  }

  if (snapshot.annualSummary) {
    const summary = snapshot.annualSummary;
    lines.push("");
    lines.push(
      `今年截至目前可用调休总计${numberText(summary.totalHours)}小时，已使用${numberText(summary.usedHours)}小时，剩余${numberText(summary.remainingHours)}小时，过期${numberText(summary.expiredHours)}小时`,
    );
  }

  return lines.join("\n");
}

export async function buildApprovalResult(
  client: PoolClient,
  leaveRequestId: string,
): Promise<ApprovalResultSnapshot> {
  const leaveResult = await client.query<{
    leave_type: LeaveType;
    requested_days: string;
    requested_hours: string;
    applicant_id: string;
    as_of_date: string;
  }>(
    `SELECT leave_type, requested_days::text, requested_hours::text,
            applicant_id, current_date::text AS as_of_date
     FROM leave_requests
     WHERE id = $1`,
    [leaveRequestId],
  );
  const leave = leaveResult.rows[0];
  if (!leave) throw new Error("Leave request not found while building approval result");

  const allocationResult = leave.leave_type === "comp_time"
    ? await client.query<{
        duty_date: string;
        earned_hours: string;
        remaining_before: string;
        used_hours: string;
        remaining_after: string;
      }>(
        `SELECT duty.duty_date::text, duty.hours::text AS earned_hours,
                allocation.remaining_before::text,
                allocation.hours::text AS used_hours,
                allocation.remaining_after::text
         FROM timeoff_allocations allocation
         JOIN duty_records duty ON duty.id = allocation.duty_record_id
         WHERE allocation.leave_request_id = $1
         ORDER BY duty.expires_at, duty.duty_date, duty.created_at`,
        [leaveRequestId],
      )
    : { rows: [] };

  let annualSummary: ApprovalResultSnapshot["annualSummary"] = null;
  if (leave.leave_type === "comp_time") {
    const summaryResult = await client.query<{
      total_hours: string;
      remaining_hours: string;
      expired_hours: string;
    }>(
      `SELECT
         COALESCE(SUM(duty.hours) FILTER (WHERE duty.status <> 'revoked'), 0)::text AS total_hours,
         COALESCE(SUM(duty.remaining_hours) FILTER (
           WHERE duty.status = 'active' AND duty.expires_at >= current_date
         ), 0)::text AS remaining_hours,
         (
           COALESCE(SUM(duty.remaining_hours) FILTER (
             WHERE duty.status = 'active' AND duty.expires_at < current_date
           ), 0)
           + COALESCE((
             SELECT SUM(-ledger.amount_hours)
             FROM timeoff_ledger ledger
             JOIN duty_records expired_duty ON expired_duty.id = ledger.duty_record_id
             WHERE ledger.user_id = $1
               AND ledger.entry_type = 'expire'
               AND expired_duty.duty_date >= date_trunc('year', current_date)::date
               AND expired_duty.duty_date <= current_date
           ), 0)
         )::text AS expired_hours
       FROM duty_records duty
       WHERE duty.user_id = $1
         AND duty.duty_date >= date_trunc('year', current_date)::date
         AND duty.duty_date <= current_date`,
      [leave.applicant_id],
    );
    const summary = summaryResult.rows[0]!;
    const totalHours = Number(summary.total_hours);
    const remainingHours = Number(summary.remaining_hours);
    const expiredHours = Number(summary.expired_hours);
    annualSummary = {
      totalHours,
      usedHours: Math.max(0, totalHours - remainingHours - expiredHours),
      remainingHours,
      expiredHours,
    };
  }

  const withoutText: Omit<ApprovalResultSnapshot, "text"> = {
    leaveRequestId,
    leaveType: leave.leave_type,
    leaveTypeLabel: leavePolicies[leave.leave_type].label,
    requestedDays: Number(leave.requested_days),
    requestedHours: Number(leave.requested_hours),
    asOfDate: leave.as_of_date,
    allocations: allocationResult.rows.map((item) => ({
      dutyDate: item.duty_date,
      earnedHours: Number(item.earned_hours),
      balanceBefore: Number(item.remaining_before),
      usedHours: Number(item.used_hours),
      balanceAfter: Number(item.remaining_after),
      reusedRemainder: Number(item.remaining_before) < Number(item.earned_hours),
    })),
    annualSummary,
  };

  return { ...withoutText, text: formatText(withoutText) };
}
