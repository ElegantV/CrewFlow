// Playwright API 集成测试:法定节假日日历(查询 / 管理员覆盖 / 删除 / 权限)。
// calendar_days 表由 015 迁移播种 2026 数据,这里不 TRUNCATE 该表。
import { expect, request as pwRequest, test, type APIRequestContext } from "@playwright/test";
import type { FastifyInstance } from "fastify";
import { db } from "../../src/db.js";
import { getBaseUrl, getTestApp } from "./helper.js";

let app: FastifyInstance;
let baseURL = "";

type SeededUser = { id: string; role: string };

async function insertUser(openid: string, name: string, role: "user" | "super_admin") {
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (openid, name, role, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
    [openid, name, role],
  );
  return result.rows[0]!;
}

let normalUser: SeededUser;
let superAdmin: SeededUser;

test.beforeAll(async () => {
  app = await getTestApp();
  baseURL = getBaseUrl(app);
  await db.query(`TRUNCATE audit_logs, timeoff_ledger, timeoff_allocations,
    approval_records, leave_requests, duty_records, users CASCADE`);
  normalUser = await insertUser("pw-cal-user", "日历用户", "user");
  superAdmin = await insertUser("pw-cal-super", "日历超管", "super_admin");
});

let api: APIRequestContext;

test.beforeEach(async () => {
  api = await pwRequest.newContext({ baseURL });
});

test.afterEach(async () => {
  await api.dispose();
});

function auth(user: SeededUser) {
  return { authorization: `Bearer ${app.jwt.sign({ sub: user.id, role: user.role, status: "active" })}` };
}

type CalendarDay = { date: string; dayType: string; name: string; source: string };

async function listDays(user: SeededUser, year: number) {
  const response = await api.get(`/api/v1/calendar?year=${year}`, { headers: auth(user) });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { year: number; days: CalendarDay[] };
  return body;
}

test("迁移播种的 2026 春节假期与调休上班日可查询", async () => {
  const body = await listDays(normalUser, 2026);
  expect(body.year).toBe(2026);
  const spring = body.days.find((day) => day.date === "2026-02-16");
  expect(spring?.dayType).toBe("holiday");
  expect(spring?.name).toContain("春节");
  const makeup = body.days.find((day) => day.date === "2026-02-14");
  expect(makeup?.dayType).toBe("makeup");
});

test("管理员手工覆盖后可查询且标记 manual,删除后恢复", async () => {
  const put = await api.put("/api/v1/admin/calendar/day", {
    headers: auth(superAdmin),
    data: { date: "2026-12-31", dayType: "holiday", name: "公司额外放假" },
  });
  expect(put.ok()).toBeTruthy();

  const afterPut = await listDays(superAdmin, 2026);
  const added = afterPut.days.find((day) => day.date === "2026-12-31");
  expect(added?.dayType).toBe("holiday");
  expect(added?.source).toBe("manual");

  const removed = await api.delete("/api/v1/admin/calendar/day?date=2026-12-31", {
    headers: auth(superAdmin),
  });
  expect(removed.ok()).toBeTruthy();

  const afterDelete = await listDays(superAdmin, 2026);
  expect(afterDelete.days.find((day) => day.date === "2026-12-31")).toBeUndefined();
});

test("普通用户不可维护日历", async () => {
  const forbidden = await api.put("/api/v1/admin/calendar/day", {
    headers: auth(normalUser),
    data: { date: "2026-12-31", dayType: "holiday" },
  });
  expect(forbidden.status()).toBe(403);
});
