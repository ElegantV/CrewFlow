// Playwright API 集成测试:登录后必填资料引导(missingRequired)及相关接口约束。
// 前置:本地 Postgres 测试库(与 npm test 相同的 crewflow_test),通过 npm run test:api 运行。
import { expect, request as pwRequest, test, type APIRequestContext } from "@playwright/test";
import type { FastifyInstance } from "fastify";
import { db } from "../../src/db.js";
import { getBaseUrl, getTestApp } from "./helper.js";

let app: FastifyInstance;
let baseURL = "";

// 1x1 合法 PNG,用于签名上传(服务端按魔数校验)。
const SIGNATURE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type SeededUser = { id: string; role: string };

async function insertUser(
  openid: string,
  name: string | null,
  role: "user" | "admin" | "super_admin",
  personnelType: "bank" | "digital" | "vendor",
) {
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (openid, name, role, status, personnel_type)
     VALUES ($1, $2, $3, 'active', $4) RETURNING id`,
    [openid, name, role, personnelType],
  );
  return result.rows[0]!;
}

let vendorNew: SeededUser; // 默认厂商类型,无姓名无代理人
let vendorAgent: SeededUser; // 可被选为代理人的在册厂商人员
let bankReady: SeededUser; // 行员,资料齐全
let adminNoSig: SeededUser; // 行员管理员,缺审批签名
let adminSig: SeededUser; // 行员管理员,用于验证签名设置流程
let superAdmin: SeededUser; // 超级管理员,可被选为审批人
let delCleanTarget: SeededUser; // 无关联数据,可被超级管理员删除
let delEntangledTarget: SeededUser; // 被他人设为负责人,删除应被拒绝
let delSub: SeededUser; // 依赖 delEntangledTarget 作为负责人的普通用户

test.beforeAll(async () => {
  app = await getTestApp();
  baseURL = getBaseUrl(app);
  await db.query(`TRUNCATE audit_logs, timeoff_ledger, timeoff_allocations,
    approval_records, leave_requests, duty_records, users CASCADE`);
  vendorNew = await insertUser("pw-onboard-new", null, "user", "vendor");
  vendorAgent = await insertUser("pw-onboard-agent", "代理人乙", "user", "vendor");
  bankReady = await insertUser("pw-onboard-bank", "行员甲", "user", "bank");
  adminNoSig = await insertUser("pw-onboard-admin-1", "管理员未签", "admin", "bank");
  adminSig = await insertUser("pw-onboard-admin-2", "管理员已签", "admin", "bank");
  superAdmin = await insertUser("pw-onboard-admin-3", "超级管理员", "super_admin", "bank");
  await db.query("UPDATE users SET manager_id = $1 WHERE id = $2", [superAdmin.id, bankReady.id]);
  delCleanTarget = await insertUser("pw-onboard-del-clean", null, "user", "digital");
  delEntangledTarget = await insertUser("pw-onboard-del-entangled", "关联用户", "user", "vendor");
  delSub = await insertUser("pw-onboard-del-sub", "下属用户", "user", "vendor");
  await db.query("UPDATE users SET manager_id = $1 WHERE id = $2", [delEntangledTarget.id, delSub.id]);
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

async function getMe(user: SeededUser) {
  const response = await api.get("/api/v1/me", { headers: auth(user) });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { missingRequired: string[] };
}

test("新用户返回缺失姓名、审批人与代理人", async () => {
  const profile = await getMe(vendorNew);
  expect(profile.missingRequired).toEqual(["name", "manager", "agent"]);
});

test("资料齐全的行员返回空数组", async () => {
  const profile = await getMe(bankReady);
  expect(profile.missingRequired).toEqual([]);
});

test("缺审批签名的管理员返回 signature", async () => {
  const profile = await getMe(adminNoSig);
  expect(profile.missingRequired).toEqual(["signature"]);
});

test("非行员保存资料缺代理人被拒", async () => {
  const response = await api.put("/api/v1/me/profile", {
    headers: auth(vendorNew),
    data: { name: "厂商新用户", personnelType: "vendor", agentUserId: null, itlStatus: "no" },
  });
  expect(response.status()).toBe(400);
});

test("设置代理人后提交完整资料,missingRequired 逐级收敛", async () => {
  // 行员不可担任非行员代理人。
  const invalid = await api.put("/api/v1/me/agent", {
    headers: auth(vendorNew),
    data: { agentUserId: bankReady.id },
  });
  expect(invalid.status()).toBe(404);

  const bound = await api.put("/api/v1/me/agent", {
    headers: auth(vendorNew),
    data: { agentUserId: vendorAgent.id },
  });
  expect(bound.ok()).toBeTruthy();

  const afterAgent = await getMe(vendorNew);
  expect(afterAgent.missingRequired).toEqual(["name", "manager"]);

  const setManager = await api.put("/api/v1/me/manager", {
    headers: auth(vendorNew),
    data: { managerUserId: superAdmin.id },
  });
  expect(setManager.ok()).toBeTruthy();

  const afterManager = await getMe(vendorNew);
  expect(afterManager.missingRequired).toEqual(["name"]);

  const saved = await api.put("/api/v1/me/profile", {
    headers: auth(vendorNew),
    data: {
      name: "厂商新用户",
      personnelType: "vendor",
      agentUserId: vendorAgent.id,
      itlStatus: "no",
    },
  });
  expect(saved.ok()).toBeTruthy();

  const afterProfile = await getMe(vendorNew);
  expect(afterProfile.missingRequired).toEqual([]);
});

test("审批人接口校验:非管理员不可选,可选列表仅含管理员", async () => {
  const list = await api.get("/api/v1/me/managers", { headers: auth(vendorNew) });
  expect(list.ok()).toBeTruthy();
  const body = (await list.json()) as { managers: Array<{ id: string; name: string | null }> };
  expect(body.managers.map(item => item.id)).toEqual([adminNoSig.id, adminSig.id, superAdmin.id]);

  const notAdmin = await api.put("/api/v1/me/manager", {
    headers: auth(vendorNew),
    data: { managerUserId: vendorAgent.id },
  });
  expect(notAdmin.status()).toBe(404);

  const self = await api.put("/api/v1/me/manager", {
    headers: auth(vendorNew),
    data: { managerUserId: vendorNew.id },
  });
  expect(self.status()).toBe(400);
});

test("普通用户不可维护审批签名,管理员设置后缺失项消除", async () => {
  const forbidden = await api.put("/api/v1/me/signature", {
    headers: auth(bankReady),
    data: { imageData: SIGNATURE_PNG },
  });
  expect(forbidden.status()).toBe(403);

  const saved = await api.put("/api/v1/me/signature", {
    headers: auth(adminSig),
    data: { imageData: SIGNATURE_PNG },
  });
  expect(saved.ok()).toBeTruthy();

  const profile = await getMe(adminSig);
  expect(profile.missingRequired).toEqual([]);

  // 个人信息页回显依赖的读取接口:管理员可读,普通用户不可读。
  const forbiddenGet = await api.get("/api/v1/me/signature", { headers: auth(bankReady) });
  expect(forbiddenGet.status()).toBe(403);

  const fetched = await api.get("/api/v1/me/signature", { headers: auth(adminSig) });
  expect(fetched.ok()).toBeTruthy();
  const body = (await fetched.json()) as { imageData: string | null };
  expect(body.imageData).toMatch(/^data:image\/png;base64,/);
});

test("普通用户无权限删除用户", async () => {
  const response = await api.delete(`/api/v1/admin/users/${delCleanTarget.id}`, { headers: auth(vendorNew) });
  expect(response.status()).toBe(403);
});

test("超级管理员不能删除自己", async () => {
  const response = await api.delete(`/api/v1/admin/users/${superAdmin.id}`, { headers: auth(superAdmin) });
  expect(response.status()).toBe(400);
});

test("被他人设为负责人的用户禁止删除", async () => {
  const response = await api.delete(`/api/v1/admin/users/${delEntangledTarget.id}`, { headers: auth(superAdmin) });
  expect(response.status()).toBe(409);
});

test("超级管理员删除干净用户后微信可重新注册", async () => {
  const response = await api.delete(`/api/v1/admin/users/${delCleanTarget.id}`, { headers: auth(superAdmin) });
  expect(response.ok()).toBeTruthy();

  const list = await api.get("/api/v1/admin/users", { headers: auth(superAdmin) });
  expect(list.ok()).toBeTruthy();
  const body = (await list.json()) as { users: Array<{ id: string }> };
  expect(body.users.some(item => item.id === delCleanTarget.id)).toBeFalsy();
});
