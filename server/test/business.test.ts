import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import { calculateWorkingHours } from "../src/business/leave-policy.js";
import { db } from "../src/db.js";

const app = await buildApp();

type TestUser = { id: string; role: "user" | "admin" | "super_admin" };
let normalUser: TestUser;
let agentUser: TestUser;
let adminUser: TestUser;
let superAdmin: TestUser;

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return isoDate(value);
}

function nextWeekday(date: string, offset: number) {
  let value = addDays(date, offset);
  while ([0, 6].includes(new Date(`${value}T00:00:00Z`).getUTCDay())) {
    value = addDays(value, 1);
  }
  return value;
}

function token(user: TestUser) {
  return app.jwt.sign({ sub: user.id, role: user.role, status: "active" });
}

function auth(user: TestUser) {
  return { authorization: `Bearer ${token(user)}` };
}

async function insertUser(openid: string, name: string, role: TestUser["role"]) {
  const result = await db.query<TestUser>(
    `INSERT INTO users (openid, name, role, status)
     VALUES ($1, $2, $3, 'active') RETURNING id, role`,
    [openid, name, role],
  );
  return result.rows[0]!;
}

before(async () => {
  await db.query(`TRUNCATE audit_logs, timeoff_ledger, timeoff_allocations,
    approval_records, leave_requests, duty_records, users CASCADE`);
  superAdmin = await insertUser("test-super", "超级管理员", "super_admin");
  adminUser = await insertUser("test-admin", "审批管理员", "admin");
  agentUser = await insertUser("test-agent", "工作代理人", "user");
  normalUser = await insertUser("test-user", "普通用户", "user");
  await db.query(
    "UPDATE users SET manager_id = $1, agent_user_id = $2 WHERE id = $3",
    [adminUser.id, agentUser.id, normalUser.id],
  );
  await db.query(
    `UPDATE users
     SET signature_data = $1, signature_mime_type = 'image/png', signature_updated_at = now()
     WHERE id = $2`,
    [
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
      adminUser.id,
    ],
  );
});

after(async () => {
  await app.close();
});

test("overtime, FIFO timeoff, duplicate leave, cancellation and permissions", async () => {
  const hiddenDevUsers = await app.inject({ method: "GET", url: "/api/v1/auth/dev/users" });
  assert.equal(hiddenDevUsers.statusCode, 404);

  const todayResult = await db.query<{ today: string }>("SELECT current_date::text AS today");
  const today = todayResult.rows[0]!.today;
  const olderDate = addDays(today, -2);
  const newerDate = today;

  const rounded = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(agentUser),
    payload: { date: today, endTime: "20:00", content: "两小时半按两小时计算" },
  });
  assert.equal(rounded.statusCode, 201, rounded.body);
  assert.equal(rounded.json().hours, 2);

  const directHours = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(adminUser),
    payload: { date: today, hours: 3, content: "直接填写三小时" },
  });
  assert.equal(directHours.statusCode, 201, directHours.body);
  assert.equal(directHours.json().hours, 3);

  const invalidDirectHours = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(superAdmin),
    payload: { date: today, hours: 2.5, content: "非整小时" },
  });
  assert.equal(invalidDirectHours.statusCode, 400);
  assert.equal(invalidDirectHours.json().code, "INVALID_OVERTIME");

  const tooShort = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(superAdmin),
    payload: { date: today, endTime: "19:29", content: "不足两小时" },
  });
  assert.equal(tooShort.statusCode, 400);
  assert.equal(tooShort.json().code, "INVALID_OVERTIME_TIME");

  const oldBackfill = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(superAdmin),
    payload: { date: addDays(today, -8), endTime: "19:30", content: "补录任意过去日期" },
  });
  assert.equal(oldBackfill.statusCode, 201, oldBackfill.body);
  assert.equal(oldBackfill.json().hours, 2);

  const older = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(normalUser),
    payload: { date: olderDate, endTime: "19:30", content: "较早加班" },
  });
  assert.equal(older.statusCode, 201, older.body);
  assert.equal(older.json().hours, 2);

  const newer = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(normalUser),
    payload: { date: newerDate, endTime: "21:30", content: "较新加班" },
  });
  assert.equal(newer.statusCode, 201, newer.body);
  assert.equal(newer.json().hours, 4);

  const duplicateOvertime = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(normalUser),
    payload: { date: newerDate, endTime: "20:30", content: "重复加班" },
  });
  assert.equal(duplicateOvertime.statusCode, 409);
  assert.equal(duplicateOvertime.json().code, "OVERTIME_DUPLICATE");

  const leaveDate = nextWeekday(today, 1);
  const leave = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(normalUser),
    payload: {
      leaveType: "comp_time",
      startDate: leaveDate,
      endDate: leaveDate,
      startPeriod: "morning",
      endPeriod: "morning",
      reason: "调休半天",
    },
  });
  assert.equal(leave.statusCode, 201, leave.body);
  assert.equal(leave.json().requestedHours, 4);
  const leaveId = leave.json().id;

  const allocations = await db.query<{ content: string; hours: string }>(
    `SELECT d.content, a.hours::text
     FROM timeoff_allocations a JOIN duty_records d ON d.id = a.duty_record_id
     WHERE a.leave_request_id = $1 ORDER BY d.expires_at, d.duty_date`,
    [leaveId],
  );
  assert.deepEqual(allocations.rows, [
    { content: "较早加班", hours: "2.00" },
    { content: "较新加班", hours: "2.00" },
  ]);

  const duplicateLeave = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(normalUser),
    payload: {
      leaveType: "annual",
      startDate: leaveDate,
      endDate: leaveDate,
      startPeriod: "day",
      endPeriod: "day",
    },
  });
  assert.equal(duplicateLeave.statusCode, 409);
  assert.equal(duplicateLeave.json().code, "LEAVE_OVERLAP");

  const revokeInUse = await app.inject({
    method: "POST",
    url: `/api/v1/overtime/${older.json().id}/revoke`,
    headers: auth(normalUser),
  });
  assert.equal(revokeInUse.statusCode, 409);
  assert.equal(revokeInUse.json().code, "OVERTIME_IN_USE");

  const pending = await app.inject({ method: "GET", url: "/api/v1/approvals/pending", headers: auth(adminUser) });
  assert.equal(pending.statusCode, 200, pending.body);
  assert.equal(pending.json().approvals.length, 1);

  const userAdminAccess = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: auth(normalUser) });
  assert.equal(userAdminAccess.statusCode, 403);
  const superAdminAccess = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: auth(superAdmin) });
  assert.equal(superAdminAccess.statusCode, 200, superAdminAccess.body);

  const cancelled = await app.inject({
    method: "POST",
    url: `/api/v1/leaves/${leaveId}/cancel`,
    headers: auth(normalUser),
    payload: {},
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);

  const cancelledAgain = await app.inject({
    method: "POST",
    url: `/api/v1/leaves/${leaveId}/cancel`,
    headers: auth(normalUser),
    payload: {},
  });
  assert.equal(cancelledAgain.statusCode, 200, cancelledAgain.body);
  assert.equal(cancelledAgain.json().alreadyCancelled, true);

  const restored = await db.query<{ content: string; remaining_hours: string }>(
    `SELECT content, remaining_hours::text FROM duty_records
     WHERE user_id = $1 ORDER BY duty_date`,
    [normalUser.id],
  );
  assert.deepEqual(restored.rows, [
    { content: "较早加班", remaining_hours: "2.00" },
    { content: "较新加班", remaining_hours: "4.00" },
  ]);

  const revokeAfterCancel = await app.inject({
    method: "POST",
    url: `/api/v1/overtime/${older.json().id}/revoke`,
    headers: auth(normalUser),
  });
  assert.equal(revokeAfterCancel.statusCode, 200, revokeAfterCancel.body);

  const sickWithNoticeOnly = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(normalUser),
    payload: {
      leaveType: "sick",
      startDate: nextWeekday(today, 4),
      endDate: nextWeekday(today, 4),
      startPeriod: "day",
      endPeriod: "day",
    },
  });
  assert.equal(sickWithNoticeOnly.statusCode, 201, sickWithNoticeOnly.body);

  const annualHalfDay = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(normalUser),
    payload: {
      leaveType: "annual",
      startDate: nextWeekday(today, 5),
      endDate: nextWeekday(today, 5),
      startPeriod: "morning",
      endPeriod: "morning",
    },
  });
  assert.equal(annualHalfDay.statusCode, 400);
  assert.equal(annualHalfDay.json().code, "INVALID_LEAVE_DURATION");

  const reversedSameDayPeriod = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(normalUser),
    payload: {
      leaveType: "public_out",
      startDate: nextWeekday(today, 6),
      endDate: nextWeekday(today, 6),
      startPeriod: "afternoon",
      endPeriod: "morning",
    },
  });
  assert.equal(reversedSameDayPeriod.statusCode, 400, reversedSameDayPeriod.body);
  assert.equal(reversedSameDayPeriod.json().code, "INVALID_PERIOD_RANGE");

  const extraOvertime = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(normalUser),
    payload: { date: addDays(today, -1), endTime: "19:30", content: "审批退回测试" },
  });
  assert.equal(extraOvertime.statusCode, 201, extraOvertime.body);

  const rejectDate = nextWeekday(today, 7);
  const leaveToReject = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(normalUser),
    payload: {
      leaveType: "comp_time",
      startDate: rejectDate,
      endDate: rejectDate,
      startPeriod: "afternoon",
      endPeriod: "afternoon",
      reason: "审批退回测试",
    },
  });
  assert.equal(leaveToReject.statusCode, 201, leaveToReject.body);

  const pendingForReject = await app.inject({ method: "GET", url: "/api/v1/approvals/pending", headers: auth(adminUser) });
  const rejectApproval = pendingForReject.json().approvals.find(
    (item: { leaveRequestId: string }) => item.leaveRequestId === leaveToReject.json().id,
  );
  assert.ok(rejectApproval);
  const rejected = await app.inject({
    method: "POST",
    url: `/api/v1/approvals/${rejectApproval.id}/decision`,
    headers: auth(adminUser),
    payload: { action: "reject", comment: "人员安排冲突" },
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal(rejected.json().status, "rejected");

  const balanceAfterReject = await app.inject({
    method: "GET",
    url: "/api/v1/overtime/balance",
    headers: auth(normalUser),
  });
  assert.equal(balanceAfterReject.statusCode, 200, balanceAfterReject.body);
  assert.equal(balanceAfterReject.json().availableHours, 6);

  const approveDate = nextWeekday(today, 9);
  const leaveToApprove = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(normalUser),
    payload: {
      leaveType: "annual",
      startDate: approveDate,
      endDate: approveDate,
      startPeriod: "day",
      endPeriod: "day",
      reason: "年假审批测试",
    },
  });
  assert.equal(leaveToApprove.statusCode, 201, leaveToApprove.body);
  const pendingForApprove = await app.inject({ method: "GET", url: "/api/v1/approvals/pending", headers: auth(adminUser) });
  const approveTask = pendingForApprove.json().approvals.find(
    (item: { leaveRequestId: string }) => item.leaveRequestId === leaveToApprove.json().id,
  );
  assert.ok(approveTask);
  const missingSignature = await app.inject({
    method: "POST",
    url: `/api/v1/approvals/${approveTask.id}/decision`,
    headers: auth(superAdmin),
    payload: { action: "approve", comment: "超级管理员代审" },
  });
  assert.equal(missingSignature.statusCode, 409, missingSignature.body);
  assert.equal(missingSignature.json().code, "SIGNATURE_REQUIRED");
  const approved = await app.inject({
    method: "POST",
    url: `/api/v1/approvals/${approveTask.id}/decision`,
    headers: auth(adminUser),
    payload: { action: "approve", comment: "同意" },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().status, "approved");
  assert.equal("approvalResult" in approved.json(), false);

  const resultView = await app.inject({
    method: "GET",
    url: `/api/v1/leaves/${leaveToApprove.json().id}/approval-result`,
    headers: auth(normalUser),
  });
  assert.equal(resultView.statusCode, 200, resultView.body);
  assert.equal(resultView.json().result.text, "本次申请【1天】年假；");

  const forbiddenResult = await app.inject({
    method: "GET",
    url: `/api/v1/leaves/${leaveToApprove.json().id}/approval-result`,
    headers: auth(agentUser),
  });
  assert.equal(forbiddenResult.statusCode, 404);

  const forbiddenAdminResult = await app.inject({
    method: "GET",
    url: `/api/v1/leaves/${leaveToApprove.json().id}/approval-result`,
    headers: auth(adminUser),
  });
  assert.equal(forbiddenAdminResult.statusCode, 404);

  const pdf = await app.inject({
    method: "GET",
    url: `/api/v1/leaves/${leaveToApprove.json().id}/pdf`,
    headers: auth(normalUser),
  });
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.equal(pdf.rawPayload.subarray(0, 4).toString(), "%PDF");

  const compApprovalDate = nextWeekday(today, 12);
  const compToApprove = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(normalUser),
    payload: {
      leaveType: "comp_time",
      startDate: compApprovalDate,
      endDate: compApprovalDate,
      startPeriod: "morning",
      endPeriod: "morning",
      reason: "调休审批结果测试",
    },
  });
  assert.equal(compToApprove.statusCode, 201, compToApprove.body);
  const pendingComp = await app.inject({ method: "GET", url: "/api/v1/approvals/pending", headers: auth(adminUser) });
  const compTask = pendingComp.json().approvals.find(
    (item: { leaveRequestId: string }) => item.leaveRequestId === compToApprove.json().id,
  );
  assert.ok(compTask);
  const approvedComp = await app.inject({
    method: "POST",
    url: `/api/v1/approvals/${compTask.id}/decision`,
    headers: auth(adminUser),
    payload: { action: "approve", comment: "同意调休" },
  });
  assert.equal(approvedComp.statusCode, 200, approvedComp.body);
  assert.equal("approvalResult" in approvedComp.json(), false);
  const compResultView = await app.inject({
    method: "GET",
    url: `/api/v1/leaves/${compToApprove.json().id}/approval-result`,
    headers: auth(normalUser),
  });
  assert.equal(compResultView.statusCode, 200, compResultView.body);
  const compResult = compResultView.json().result;
  assert.equal(compResult.allocations.length, 2);
  assert.deepEqual(compResult.annualSummary, {
    totalHours: 6,
    usedHours: 4,
    remainingHours: 2,
    expiredHours: 0,
  });
  assert.match(compResult.text, /^本次申请【0.5天】调休；/);
  assert.match(compResult.text, /本次使用2小时，剩余0小时；/);
  assert.match(compResult.text, /今年截至目前可用调休总计6小时，已使用4小时，剩余2小时，过期0小时$/);

  const approvalHistory = await app.inject({
    method: "GET",
    url: "/api/v1/approvals/history",
    headers: auth(adminUser),
  });
  assert.equal(approvalHistory.statusCode, 200, approvalHistory.body);
  assert.ok(approvalHistory.json().approvals.some(
    (item: { leaveRequestId: string }) => item.leaveRequestId === compToApprove.json().id,
  ));

  const compPdf = await app.inject({
    method: "GET",
    url: `/api/v1/leaves/${compToApprove.json().id}/pdf`,
    headers: auth(normalUser),
  });
  assert.equal(compPdf.statusCode, 200, compPdf.body);
  assert.equal(compPdf.rawPayload.subarray(0, 4).toString(), "%PDF");

  const forbiddenAdminPdf = await app.inject({
    method: "GET",
    url: `/api/v1/leaves/${compToApprove.json().id}/pdf`,
    headers: auth(adminUser),
  });
  assert.equal(forbiddenAdminPdf.statusCode, 404);

  // --- 值日协同预警 + 首页提醒数据 ---
  const conflictDate = nextWeekday(today, 14);
  await db.query(
    `INSERT INTO duty_records
       (user_id, duty_date, start_time, end_time, hours, remaining_hours, content, expires_at)
     VALUES ($1, $2, '17:30', '20:30', 3, 3, '临期值班测试', $3)`,
    [normalUser.id, conflictDate, addDays(today, 2)],
  );

  const conflictLeave = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(normalUser),
    payload: {
      leaveType: "annual",
      startDate: conflictDate,
      endDate: conflictDate,
      startPeriod: "day",
      endPeriod: "day",
      reason: "值班重叠预警",
    },
  });
  assert.equal(conflictLeave.statusCode, 201, conflictLeave.body);
  assert.equal(conflictLeave.json().warnings.length, 1, conflictLeave.body);
  assert.equal(conflictLeave.json().warnings[0].code, "DUTY_OVERLAP");

  const userDashboard = await app.inject({
    method: "GET",
    url: "/api/v1/me/dashboard",
    headers: auth(normalUser),
  });
  assert.equal(userDashboard.statusCode, 200, userDashboard.body);
  const userDashboardBody = userDashboard.json();
  assert.equal(userDashboardBody.pendingApprovals, null);
  assert.ok(
    userDashboardBody.overtime.expiringSoon.some(
      (item: { content: string }) => item.content === "临期值班测试",
    ),
    userDashboardBody,
  );
  assert.ok(
    userDashboardBody.dutyConflicts.some(
      (item: { date: string }) => item.date === conflictDate,
    ),
    userDashboardBody,
  );

  const adminDashboard = await app.inject({
    method: "GET",
    url: "/api/v1/me/dashboard",
    headers: auth(adminUser),
  });
  assert.equal(adminDashboard.statusCode, 200, adminDashboard.body);
  assert.ok(Number(adminDashboard.json().pendingApprovals) >= 1, adminDashboard.body);
});

test("calculateWorkingHours 多天半天语义与单天一致", () => {
  // 2026-08-17(周一) 18(周二) 19(周三)；2026-08-16(周日)。
  // 语义：边界日按所选时段计 4h（仅上午或仅下午）或 8h（全天），与单天规则一致。
  assert.equal(calculateWorkingHours("2026-08-17", "2026-08-18", "morning", "morning"), 8);
  assert.equal(calculateWorkingHours("2026-08-17", "2026-08-18", "morning", "afternoon"), 8);
  assert.equal(calculateWorkingHours("2026-08-17", "2026-08-18", "afternoon", "morning"), 8);
  assert.equal(calculateWorkingHours("2026-08-17", "2026-08-19", "afternoon", "afternoon"), 16);
  assert.equal(calculateWorkingHours("2026-08-17", "2026-08-18", "day", "day"), 16);
  assert.equal(calculateWorkingHours("2026-08-17", "2026-08-17", "morning", "morning"), 4);
  assert.equal(calculateWorkingHours("2026-08-17", "2026-08-17", "day", "day"), 8);
  assert.equal(calculateWorkingHours("2026-08-17", "2026-08-17", "morning", "afternoon"), 8);
  assert.equal(calculateWorkingHours("2026-08-16", "2026-08-16", "day", "day"), 0);
});

test("周末请假返回明确的 NO_WORKDAY_IN_RANGE", async () => {
  const todayResult = await db.query<{ today: string }>("SELECT current_date::text AS today");
  const today = todayResult.rows[0]!.today;
  let weekend = addDays(today, 1);
  while (![0, 6].includes(new Date(`${weekend}T00:00:00Z`).getUTCDay())) {
    weekend = addDays(weekend, 1);
  }
  const result = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(normalUser),
    payload: {
      leaveType: "annual",
      startDate: weekend,
      endDate: weekend,
      startPeriod: "day",
      endPeriod: "day",
    },
  });
  assert.equal(result.statusCode, 400, result.body);
  assert.equal(result.json().code, "NO_WORKDAY_IN_RANGE");
});
