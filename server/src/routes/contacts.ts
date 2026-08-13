import type { FastifyPluginAsync } from "fastify";
import { loadActiveActor } from "../authz.js";
import { db } from "../db.js";

const personnelTypeLabels = {
  bank: "行员",
  digital: "数科",
  vendor: "厂商",
} as const;

export const contactRoutes: FastifyPluginAsync = async (app) => {
  const protectedHooks = { onRequest: [app.authenticate, loadActiveActor] };

  app.get("/", protectedHooks, async () => {
    const result = await db.query<{
      id: string;
      name: string | null;
      account_name: string | null;
      personnel_type: keyof typeof personnelTypeLabels;
      bank_project: string | null;
      department: string | null;
      mobile: string | null;
    }>(
      `SELECT id, name, account_name, personnel_type, bank_project, department, mobile
       FROM users
       WHERE status = 'active'
       ORDER BY COALESCE(bank_project, department, '未配置系统'), name NULLS LAST, account_name NULLS LAST`,
    );
    const contacts = result.rows.map(item => {
      const systemName = item.bank_project ?? item.department ?? "未配置系统";
      const name = item.name ?? item.account_name ?? "未命名用户";
      const personnelTypeLabel = personnelTypeLabels[item.personnel_type];
      return {
        id: item.id,
        systemName,
        name,
        accountName: item.account_name,
        personnelType: item.personnel_type,
        personnelTypeLabel,
        mobile: item.mobile,
        copyText: `系统：${systemName}\n用户名：${name}\n人员类型：${personnelTypeLabel}\n电话：${item.mobile ?? "未配置"}`,
      };
    });
    return {
      systems: Array.from(new Set(contacts.map(item => item.systemName))),
      contacts,
    };
  });
};
