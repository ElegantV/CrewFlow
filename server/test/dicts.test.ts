import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

const app = await buildApp();

type TestUser = { id: string; role: "user" | "admin" | "super_admin" };
let normalUser: TestUser;
let superAdmin: TestUser;

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
  await db.query(`TRUNCATE users CASCADE`);
  superAdmin = await insertUser("test-dict-super", "字典超管", "super_admin");
  normalUser = await insertUser("test-dict-user", "字典普通用户", "user");
});

after(async () => {
  await db.query(`TRUNCATE users CASCADE`);
});

test("GET /api/v1/dicts 返回三类字典数据", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1/dicts", headers: auth(normalUser) });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.ok(body.departments.length > 0);
  assert.ok(body.attendanceLocations.length > 0);
  assert.ok(body.bankProjects.length > 0);
});

test("超管可新增/编辑/删除处室、打卡地点与项目,普通用户禁止维护", async () => {
  const denied = await app.inject({
    method: "POST", url: "/api/v1/admin/dicts/departments",
    headers: auth(normalUser), payload: { name: "测试处室" },
  });
  assert.equal(denied.statusCode, 403);

  const createDep = await app.inject({
    method: "POST", url: "/api/v1/admin/dicts/departments",
    headers: auth(superAdmin), payload: { name: "测试处室" },
  });
  assert.equal(createDep.statusCode, 200, createDep.body);
  const depId = createDep.json().item.id;

  const duplicate = await app.inject({
    method: "POST", url: "/api/v1/admin/dicts/departments",
    headers: auth(superAdmin), payload: { name: "测试处室" },
  });
  assert.equal(duplicate.statusCode, 409);

  const createLocation = await app.inject({
    method: "POST", url: "/api/v1/admin/dicts/attendance-locations",
    headers: auth(superAdmin), payload: { name: "测试地点" },
  });
  assert.equal(createLocation.statusCode, 200, createLocation.body);
  const locationId = createLocation.json().item.id;

  const createProject = await app.inject({
    method: "POST", url: "/api/v1/admin/dicts/bank-projects",
    headers: auth(superAdmin), payload: { name: "测试项目", departmentId: depId },
  });
  assert.equal(createProject.statusCode, 200, createProject.body);
  const projectId = createProject.json().item.id;

  const badProject = await app.inject({
    method: "POST", url: "/api/v1/admin/dicts/bank-projects",
    headers: auth(superAdmin), payload: { name: "悬空项目", departmentId: "00000000-0000-4000-8000-000000000000" },
  });
  assert.equal(badProject.statusCode, 404);

  const rename = await app.inject({
    method: "PUT", url: `/api/v1/admin/dicts/departments/${depId}`,
    headers: auth(superAdmin), payload: { name: "测试处室改" },
  });
  assert.equal(rename.statusCode, 200, rename.body);
  assert.equal(rename.json().item.name, "测试处室改");

  // 项目被用户引用时禁止删除。
  await db.query("UPDATE users SET bank_project = '测试项目' WHERE id = $1", [normalUser.id]);
  const projectInUse = await app.inject({
    method: "DELETE", url: `/api/v1/admin/dicts/bank-projects/${projectId}`,
    headers: auth(superAdmin),
  });
  assert.equal(projectInUse.statusCode, 409);

  await db.query("UPDATE users SET bank_project = NULL WHERE id = $1", [normalUser.id]);
  const deleteProject = await app.inject({
    method: "DELETE", url: `/api/v1/admin/dicts/bank-projects/${projectId}`,
    headers: auth(superAdmin),
  });
  assert.equal(deleteProject.statusCode, 200, deleteProject.body);

  const deleteDep = await app.inject({
    method: "DELETE", url: `/api/v1/admin/dicts/departments/${depId}`,
    headers: auth(superAdmin),
  });
  assert.equal(deleteDep.statusCode, 200, deleteDep.body);

  const deleteLocation = await app.inject({
    method: "DELETE", url: `/api/v1/admin/dicts/attendance-locations/${locationId}`,
    headers: auth(superAdmin),
  });
  assert.equal(deleteLocation.statusCode, 200, deleteLocation.body);
});

test("项目重名校验按处室维度:同处室同名 409,不同处室同名允许", async () => {
  const depA = await app.inject({
    method: "POST", url: "/api/v1/admin/dicts/departments",
    headers: auth(superAdmin), payload: { name: "重名测试处室A" },
  });
  assert.equal(depA.statusCode, 200, depA.body);
  const depAId = depA.json().item.id;
  const depB = await app.inject({
    method: "POST", url: "/api/v1/admin/dicts/departments",
    headers: auth(superAdmin), payload: { name: "重名测试处室B" },
  });
  assert.equal(depB.statusCode, 200, depB.body);
  const depBId = depB.json().item.id;

  const createA = await app.inject({
    method: "POST", url: "/api/v1/admin/dicts/bank-projects",
    headers: auth(superAdmin), payload: { name: "同名项目", departmentId: depAId },
  });
  assert.equal(createA.statusCode, 200, createA.body);
  const projectAId = createA.json().item.id;

  // 同处室下创建同名项目 → 409
  const duplicateInA = await app.inject({
    method: "POST", url: "/api/v1/admin/dicts/bank-projects",
    headers: auth(superAdmin), payload: { name: "同名项目", departmentId: depAId },
  });
  assert.equal(duplicateInA.statusCode, 409, duplicateInA.body);

  // 不同处室下同名项目 → 允许
  const createB = await app.inject({
    method: "POST", url: "/api/v1/admin/dicts/bank-projects",
    headers: auth(superAdmin), payload: { name: "同名项目", departmentId: depBId },
  });
  assert.equal(createB.statusCode, 200, createB.body);

  // 把 B 处室的同名项目改到 A 处室 → 409,且不是 500
  const moveToA = await app.inject({
    method: "PUT", url: `/api/v1/admin/dicts/bank-projects/${createB.json().item.id}`,
    headers: auth(superAdmin), payload: { name: "同名项目", departmentId: depAId },
  });
  assert.equal(moveToA.statusCode, 409, moveToA.body);

  // 改名后可移入 A 处室
  const renameMove = await app.inject({
    method: "PUT", url: `/api/v1/admin/dicts/bank-projects/${createB.json().item.id}`,
    headers: auth(superAdmin), payload: { name: "同名项目二", departmentId: depAId },
  });
  assert.equal(renameMove.statusCode, 200, renameMove.body);

  await app.inject({
    method: "DELETE", url: `/api/v1/admin/dicts/bank-projects/${projectAId}`, headers: auth(superAdmin),
  });
  await app.inject({
    method: "DELETE", url: `/api/v1/admin/dicts/bank-projects/${createB.json().item.id}`, headers: auth(superAdmin),
  });
  await app.inject({ method: "DELETE", url: `/api/v1/admin/dicts/departments/${depAId}`, headers: auth(superAdmin) });
  await app.inject({ method: "DELETE", url: `/api/v1/admin/dicts/departments/${depBId}`, headers: auth(superAdmin) });
});

test("people/managers 接口返回 department 字段", async () => {
  const people = await app.inject({ method: "GET", url: "/api/v1/me/people", headers: auth(normalUser) });
  assert.equal(people.statusCode, 200, people.body);
  for (const person of people.json().people) {
    assert.ok("department" in person, "people 应带 department 字段");
  }
  const managers = await app.inject({ method: "GET", url: "/api/v1/me/managers", headers: auth(normalUser) });
  assert.equal(managers.statusCode, 200, managers.body);
  for (const manager of managers.json().managers) {
    assert.ok("department" in manager, "managers 应带 department 字段");
  }
});

test("超管更新用户行内级别仅接受五档选项", async () => {
  // 启用普通用户必须已有审批人，避免命中 MANAGER_REQUIRED。
  await db.query("UPDATE users SET manager_id = $1 WHERE id = $2", [superAdmin.id, normalUser.id]);

  const valid = await app.inject({
    method: "PUT", url: `/api/v1/admin/users/${normalUser.id}`,
    headers: auth(superAdmin), payload: { bankLevel: "高级主管" },
  });
  assert.equal(valid.statusCode, 200, valid.body);
  const stored = await db.query<{ bank_level: string }>("SELECT bank_level FROM users WHERE id = $1", [normalUser.id]);
  assert.equal(stored.rows[0]!.bank_level, "高级主管");

  const invalid = await app.inject({
    method: "PUT", url: `/api/v1/admin/users/${normalUser.id}`,
    headers: auth(superAdmin), payload: { bankLevel: "1级" },
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
});