import type { FastifyPluginAsync } from "fastify";
import { loadActiveActor } from "../authz.js";
import { db } from "../db.js";

// 行内字典只读接口:登录用户即可读取,供个人信息页下拉选择。
// 字典维护在 /api/v1/admin/dicts/* (仅超级管理员)。
export const dictRoutes: FastifyPluginAsync = async (app) => {
  const protectedHooks = { onRequest: [app.authenticate, loadActiveActor] };

  app.get("/", protectedHooks, async () => {
    const [departments, locations, projects] = await Promise.all([
      db.query<{ id: string; name: string; sort_order: number }>(
        "SELECT id, name, sort_order FROM departments ORDER BY sort_order, name",
      ),
      db.query<{ id: string; name: string; sort_order: number }>(
        "SELECT id, name, sort_order FROM attendance_locations ORDER BY sort_order, name",
      ),
      db.query<{ id: string; department_id: string; name: string; sort_order: number }>(
        "SELECT id, department_id, name, sort_order FROM bank_projects ORDER BY sort_order, name",
      ),
    ]);
    return {
      departments: departments.rows.map((item) => ({ id: item.id, name: item.name, sortOrder: item.sort_order })),
      attendanceLocations: locations.rows.map((item) => ({ id: item.id, name: item.name, sortOrder: item.sort_order })),
      bankProjects: projects.rows.map((item) => ({
        id: item.id,
        departmentId: item.department_id,
        name: item.name,
        sortOrder: item.sort_order,
      })),
    };
  });
};