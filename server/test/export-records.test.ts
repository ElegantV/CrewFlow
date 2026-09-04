// 集成测试:验证 /admin/records/export 的按用户筛选。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import ExcelJS from "exceljs";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

const app = await buildApp();

let superAdmin: { id: string; role: "super_admin" };
let userA: { id: string; role: "user" };
let userB: { id: string; role: "user" };

function token(user: typeof superAdmin) {
  return app.jwt.sign({ sub: user.id, role: user.role, status: "active" });
}

async function insertUser(openid: string, name: string, role: "super_admin" | "user") {
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (openid, name, role, status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [openid, name, role],
  );
  return result.rows[0]!;
}

before(async () => {
  await db.query(`TRUNCATE audit_logs, timeoff_ledger, timeoff_allocations,
    approval_records, leave_requests, duty_records, users CASCADE`);
  superAdmin = await insertUser("test-export-super", "测试超管", "super_admin");
  userA = await insertUser("smoke-a", "用户甲", "user");
  userB = await insertUser("smoke-b", "用户乙", "user");
  await db.query(
    `INSERT INTO leave_requests (applicant_id, leave_type, start_date, end_date, requested_days, reason, status)
     VALUES ($1, 'annual', '2026-08-10', '2026-08-11', 2, '甲的请假', 'approved'),
            ($2, 'sick',   '2026-08-12', '2026-08-12', 1, '乙的请假', 'approved')`,
    [userA.id, userB.id],
  );
  await db.query(
    `INSERT INTO duty_records (user_id, duty_date, start_time, end_time, hours, remaining_hours, content, expires_at)
     VALUES ($1, '2026-08-15', '17:30', '20:30', 3, 3, '甲的加班', now() + interval '30 days'),
            ($2, '2026-08-16', '17:30', '20:30', 2, 2, '乙的加班', now() + interval '30 days')`,
    [userA.id, userB.id],
  );
});

after(async () => {
  await app.close();
});

async function exportSheet(url: string) {
  const response = await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token(superAdmin)}` },
  });
  return response;
}

test("不传 userId 时导出全部用户记录", async () => {
  const response = await exportSheet("/api/v1/admin/records/export?start=2026-08-01&end=2026-08-31");
  assert.equal(response.statusCode, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.rawPayload);
  assert.equal(workbook.getWorksheet("请假记录").rowCount, 3); // 表头 + 2 行
  assert.equal(workbook.getWorksheet("加班记录").rowCount, 3);
});

test("传 userId 时只导出该用户记录", async () => {
  const response = await exportSheet(
    `/api/v1/admin/records/export?start=2026-08-01&end=2026-08-31&userId=${userB.id}`,
  );
  assert.equal(response.statusCode, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.rawPayload);
  const leaves = workbook.getWorksheet("请假记录");
  assert.equal(leaves.rowCount, 2); // 表头 + 1 行
  assert.equal(leaves.getRow(2).getCell(1).value, "用户乙");
  const overtime = workbook.getWorksheet("加班记录");
  assert.equal(overtime.rowCount, 2);
  assert.equal(overtime.getRow(2).getCell(1).value, "用户乙");
  const disposition = String(response.headers["content-disposition"]);
  assert.ok(disposition.includes(encodeURIComponent("考勤记录_用户乙_")));
});

test("userId 不存在时返回 404", async () => {
  const response = await exportSheet(
    "/api/v1/admin/records/export?start=2026-08-01&end=2026-08-31&userId=00000000-0000-4000-8000-000000000000",
  );
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().code, "USER_NOT_FOUND");
});

test("userId 格式非法时返回 400", async () => {
  const response = await exportSheet(
    "/api/v1/admin/records/export?start=2026-08-01&end=2026-08-31&userId=not-a-uuid",
  );
  assert.equal(response.statusCode, 400);
});
