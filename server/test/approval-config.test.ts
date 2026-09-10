import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import { isWorkdayDate } from "../src/business/leave-policy.js";
import { db } from "../src/db.js";

const app = await buildApp();

type TestUser = { id: string; role: "user" | "admin" | "super_admin" };

let superAdmin: TestUser;
let manager: TestUser;
let agentUser: TestUser;
let assignedUser: TestUser;
let unassignedUser: TestUser;
let departmentId = "";
let leaveDates: string[] = [];

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return isoDate(value);
}

function workdaysFrom(date: string, count: number) {
  const days: string[] = [];
  let cursor = date;
  while (days.length < count) {
    cursor = addDays(cursor, 1);
    if (isWorkdayDate(cursor)) days.push(cursor);
  }
  return days;
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

async function today() {
  const result = await db.query<{ today: string }>("SELECT current_date::text AS today");
  return result.rows[0]!.today;
}

async function setDepartmentFlags(leaveApprovalRequired: boolean, overtimeApprovalRequired: boolean) {
  const response = await app.inject({
    method: "PUT",
    url: `/api/v1/admin/dicts/departments/${departmentId}`,
    headers: auth(superAdmin),
    payload: { name: "审批测试处室", leaveApprovalRequired, overtimeApprovalRequired },
  });
  assert.equal(response.statusCode, 200, response.body);
}

before(async () => {
  await db.query(`TRUNCATE audit_logs, timeoff_ledger, timeoff_allocations,
    approval_records, leave_requests, duty_records, users CASCADE`);
  leaveDates = workdaysFrom(await today(), 6);
  superAdmin = await insertUser("test-approval-super", "审批超管", "super_admin");
  manager = await insertUser("test-approval-manager", "审批管理员", "admin");
  agentUser = await insertUser("test-approval-agent", "工作代理人", "user");
  assignedUser = await insertUser("test-approval-assigned", "已分配用户", "user");
  unassignedUser = await insertUser("test-approval-unassigned", "未分配用户", "user");

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/admin/dicts/departments",
    headers: auth(superAdmin),
    payload: { name: "审批测试处室", leaveApprovalRequired: true, overtimeApprovalRequired: true },
  });
  assert.equal(created.statusCode, 200, created.body);
  departmentId = created.json().item.id;

  await db.query(
    `UPDATE users SET department = '审批测试处室', manager_id = $1, agent_user_id = $2 WHERE id = $3`,
    [manager.id, agentUser.id, assignedUser.id],
  );
  await db.query(
    `UPDATE users SET department = '审批测试处室', agent_user_id = $1 WHERE id = $2`,
    [agentUser.id, unassignedUser.id],
  );
  await db.query(
    `UPDATE users
     SET signature_data = $1, signature_mime_type = 'image/png', signature_updated_at = now()
     WHERE id = $2`,
    [
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
      manager.id,
    ],
  );
});

after(async () => {
  await db.query(`TRUNCATE users CASCADE`);
  await db.query(`DELETE FROM departments WHERE id = $1`, [departmentId]);
  await app.close();
});

test("字段维护：处室审批开关可读取与更新", async () => {
  const list = await app.inject({ method: "GET", url: "/api/v1/dicts", headers: auth(unassignedUser) });
  assert.equal(list.statusCode, 200, list.body);
  const department = list.json().departments.find((item: { id: string }) => item.id === departmentId);
  assert.equal(department.leaveApprovalRequired, true);
  assert.equal(department.overtimeApprovalRequired, true);

  const updated = await app.inject({
    method: "PUT",
    url: `/api/v1/admin/dicts/departments/${departmentId}`,
    headers: auth(superAdmin),
    payload: { name: "审批测试处室", overtimeApprovalRequired: false },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().item.leaveApprovalRequired, true);
  assert.equal(updated.json().item.overtimeApprovalRequired, false);
  await setDepartmentFlags(true, true);
});

test("未分配审批人：请假直接通过且不生成审批记录", async () => {
  const date = leaveDates[0]!;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(unassignedUser),
    payload: { leaveType: "personal", startDate: date, endDate: date, startPeriod: "day", endPeriod: "day", reason: "免审批测试" },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().status, "approved");
  assert.equal(response.json().approvalRequired, false);

  const approvals = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM approval_records WHERE leave_request_id = $1",
    [response.json().id],
  );
  assert.equal(approvals.rows[0]!.count, 0);
});

test("处室请假免审批开关：已分配审批人也直接通过", async () => {
  await setDepartmentFlags(false, true);
  const date = leaveDates[1]!;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(assignedUser),
    payload: { leaveType: "personal", startDate: date, endDate: date, startPeriod: "day", endPeriod: "day", reason: "处室免审批" },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().status, "approved");
  assert.equal(response.json().approvalRequired, false);
  await setDepartmentFlags(true, true);
});

test("处室需审批且已分配审批人：请假待审批并可由审批人通过", async () => {
  const date = leaveDates[2]!;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(assignedUser),
    payload: { leaveType: "personal", startDate: date, endDate: date, startPeriod: "day", endPeriod: "day", reason: "需审批测试" },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().status, "pending");
  assert.equal(response.json().approvalRequired, true);

  const approval = await db.query<{ id: string }>(
    "SELECT id FROM approval_records WHERE leave_request_id = $1 AND step_no = 1",
    [response.json().id],
  );
  assert.equal(approval.rowCount, 1);

  const pending = await app.inject({ method: "GET", url: "/api/v1/approvals/pending", headers: auth(manager) });
  const item = pending.json().approvals.find((entry: { id: string }) => entry.id === approval.rows[0]!.id);
  assert.ok(item, "审批人应看到待审批请假");
  assert.equal(item.bizType, "leave");

  const decision = await app.inject({
    method: "POST",
    url: `/api/v1/approvals/${approval.rows[0]!.id}/decision`,
    headers: auth(manager),
    payload: { action: "approve" },
  });
  assert.equal(decision.statusCode, 200, decision.body);
  assert.equal(decision.json().bizType, "leave");

  const leave = await db.query<{ status: string }>("SELECT status FROM leave_requests WHERE id = $1", [response.json().id]);
  assert.equal(leave.rows[0]!.status, "approved");
});

test("未分配审批人：加班登记直接生效并产生调休额度", async () => {
  const date = addDays(await today(), -1);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(unassignedUser),
    payload: { date, offTime: "18:00", hours: 2, content: "免审批加班" },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().status, "active");
  assert.equal(response.json().approvalRequired, false);

  const balance = await app.inject({ method: "GET", url: "/api/v1/overtime/balance", headers: auth(unassignedUser) });
  assert.equal(balance.json().availableHours, 2);
});

test("加班审批：待审批不产生额度，通过后记账，驳回不记账", async () => {
  const todayDate = await today();
  const first = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(assignedUser),
    payload: { date: addDays(todayDate, -1), offTime: "18:00", hours: 2, content: "待审批加班" },
  });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().status, "pending");
  assert.equal(first.json().approvalRequired, true);

  const balanceBefore = await app.inject({ method: "GET", url: "/api/v1/overtime/balance", headers: auth(assignedUser) });
  assert.equal(balanceBefore.json().availableHours, 0);
  const ledgerBefore = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM timeoff_ledger WHERE duty_record_id = $1",
    [first.json().id],
  );
  assert.equal(ledgerBefore.rows[0]!.count, 0);

  const pending = await app.inject({ method: "GET", url: "/api/v1/approvals/pending", headers: auth(manager) });
  const item = pending.json().approvals.find((entry: { dutyRecordId: string }) => entry.dutyRecordId === first.json().id);
  assert.ok(item, "审批人应看到待审批加班");
  assert.equal(item.bizType, "overtime");
  assert.equal(item.hours, 2);

  const decision = await app.inject({
    method: "POST",
    url: `/api/v1/approvals/${item.id}/decision`,
    headers: auth(manager),
    payload: { action: "approve" },
  });
  assert.equal(decision.statusCode, 200, decision.body);
  assert.equal(decision.json().bizType, "overtime");

  const balanceAfter = await app.inject({ method: "GET", url: "/api/v1/overtime/balance", headers: auth(assignedUser) });
  assert.equal(balanceAfter.json().availableHours, 2);
  const ledgerAfter = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM timeoff_ledger WHERE duty_record_id = $1 AND entry_type = 'earn'",
    [first.json().id],
  );
  assert.equal(ledgerAfter.rows[0]!.count, 1);

  const second = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(assignedUser),
    payload: { date: addDays(todayDate, -2), offTime: "18:00", hours: 3, content: "待驳回加班" },
  });
  assert.equal(second.statusCode, 201, second.body);
  const pendingAgain = await app.inject({ method: "GET", url: "/api/v1/approvals/pending", headers: auth(manager) });
  const rejectItem = pendingAgain.json().approvals.find((entry: { dutyRecordId: string }) => entry.dutyRecordId === second.json().id);
  assert.ok(rejectItem);

  const rejected = await app.inject({
    method: "POST",
    url: `/api/v1/approvals/${rejectItem.id}/decision`,
    headers: auth(manager),
    payload: { action: "reject", comment: "材料不全" },
  });
  assert.equal(rejected.statusCode, 200, rejected.body);

  const record = await db.query<{ status: string; remaining_hours: string }>(
    "SELECT status, remaining_hours::text FROM duty_records WHERE id = $1",
    [second.json().id],
  );
  assert.equal(record.rows[0]!.status, "rejected");
  assert.equal(Number(record.rows[0]!.remaining_hours), 0);
  const rejectedLedger = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM timeoff_ledger WHERE duty_record_id = $1",
    [second.json().id],
  );
  assert.equal(rejectedLedger.rows[0]!.count, 0);

  // 驳回后同日允许重新登记（唯一索引排除 rejected）。
  const retry = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(assignedUser),
    payload: { date: addDays(todayDate, -2), offTime: "18:00", hours: 3, content: "驳回后重提" },
  });
  assert.equal(retry.statusCode, 201, retry.body);
  assert.equal(retry.json().status, "pending");
});

test("待审批加班可撤回并同步取消审批任务", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/overtime",
    headers: auth(assignedUser),
    payload: { date: addDays(await today(), -3), offTime: "18:00", hours: 2, content: "待撤回加班" },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().status, "pending");

  const revoke = await app.inject({
    method: "POST",
    url: `/api/v1/overtime/${response.json().id}/revoke`,
    headers: auth(assignedUser),
  });
  assert.equal(revoke.statusCode, 200, revoke.body);

  const record = await db.query<{ status: string }>("SELECT status FROM duty_records WHERE id = $1", [response.json().id]);
  assert.equal(record.rows[0]!.status, "revoked");
  const approval = await db.query<{ status: string }>(
    "SELECT status FROM approval_records WHERE duty_record_id = $1",
    [response.json().id],
  );
  assert.equal(approval.rows[0]!.status, "cancelled");
});

test("撤销请假：待审批任务同步取消", async () => {
  const date = leaveDates[3]!;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(assignedUser),
    payload: { leaveType: "personal", startDate: date, endDate: date, startPeriod: "day", endPeriod: "day", reason: "待撤销请假" },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().status, "pending");

  const cancel = await app.inject({
    method: "POST",
    url: `/api/v1/leaves/${response.json().id}/cancel`,
    headers: auth(assignedUser),
  });
  assert.equal(cancel.statusCode, 200, cancel.body);

  const approval = await db.query<{ status: string }>(
    "SELECT status FROM approval_records WHERE leave_request_id = $1",
    [response.json().id],
  );
  assert.equal(approval.rows[0]!.status, "cancelled");
});

test("请假时工作代理人在同区间也请假会给出提醒", async () => {
  const date = leaveDates[4]!;
  // 代理人已通过的请假：直接落库，避免依赖代理人的代理人与审批配置。
  await db.query(
    `INSERT INTO leave_requests
       (applicant_id, leave_type, start_date, end_date, start_period, end_period,
        requested_days, requested_hours, status, decided_at)
     VALUES ($1, 'personal', $2, $2, 'day', 'day', 1, 8, 'approved', now())`,
    [agentUser.id, date],
  );

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/leaves",
    headers: auth(assignedUser),
    payload: { leaveType: "personal", startDate: date, endDate: date, startPeriod: "day", endPeriod: "day", reason: "代理人冲突测试" },
  });
  assert.equal(response.statusCode, 201, response.body);
  const warnings = response.json().warnings as Array<{ code: string; message: string }>;
  assert.ok(
    warnings.some((item) => item.code === "AGENT_LEAVE_OVERLAP"),
    `应包含代理人请假提醒: ${JSON.stringify(warnings)}`,
  );
  assert.ok(warnings.some((item) => item.message.includes("工作代理人")));
});
