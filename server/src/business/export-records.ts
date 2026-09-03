import ExcelJS from "exceljs";
import { leavePolicies, type LeaveType } from "./leave-policy.js";

export type LeaveRow = {
  applicant_name: string | null;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  start_period: string;
  end_period: string;
  requested_days: string;
  status: string;
  reason: string | null;
  approver_name: string | null;
  created_at: string;
};

export type OvertimeRow = {
  name: string | null;
  duty_date: string;
  hours: string;
  content: string;
  status: string;
  created_at: string;
};

const LEAVE_STATUS_LABELS: Record<string, string> = {
  pending: "待审批",
  approved: "已通过",
  rejected: "已驳回",
  cancelled: "已撤销",
};

const OVERTIME_STATUS_LABELS: Record<string, string> = {
  active: "可用",
  consumed: "已用完",
  revoked: "已撤销",
  expired: "已到期",
};

function periodLabel(period: string) {
  return period === "morning" ? "上午" : period === "afternoon" ? "下午" : "全天";
}

function styleHeader(sheet: ExcelJS.Worksheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
}

export function buildRecordsWorkbook(leaves: LeaveRow[], overtime: OvertimeRow[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "CrewFlow";

  const leaveSheet = workbook.addWorksheet("请假记录");
  leaveSheet.columns = [
    { header: "姓名", key: "name", width: 12 },
    { header: "假别", key: "type", width: 10 },
    { header: "开始日期", key: "startDate", width: 12 },
    { header: "开始时段", key: "startPeriod", width: 10 },
    { header: "结束日期", key: "endDate", width: 12 },
    { header: "结束时段", key: "endPeriod", width: 10 },
    { header: "天数", key: "days", width: 8 },
    { header: "状态", key: "status", width: 10 },
    { header: "事由", key: "reason", width: 32 },
    { header: "审批人", key: "approver", width: 12 },
    { header: "提交时间", key: "createdAt", width: 20 },
  ];
  for (const row of leaves) {
    leaveSheet.addRow({
      name: row.applicant_name ?? "未命名用户",
      type: leavePolicies[row.leave_type]?.label ?? row.leave_type,
      startDate: row.start_date,
      startPeriod: periodLabel(row.start_period),
      endDate: row.end_date,
      endPeriod: periodLabel(row.end_period),
      days: Number(row.requested_days),
      status: LEAVE_STATUS_LABELS[row.status] ?? row.status,
      reason: row.reason ?? "",
      approver: row.approver_name ?? "",
      createdAt: row.created_at,
    });
  }
  styleHeader(leaveSheet);

  const overtimeSheet = workbook.addWorksheet("加班记录");
  overtimeSheet.columns = [
    { header: "姓名", key: "name", width: 12 },
    { header: "加班日期", key: "date", width: 12 },
    { header: "小时数", key: "hours", width: 10 },
    { header: "工作内容", key: "content", width: 32 },
    { header: "状态", key: "status", width: 10 },
    { header: "登记时间", key: "createdAt", width: 20 },
  ];
  for (const row of overtime) {
    overtimeSheet.addRow({
      name: row.name ?? "未命名用户",
      date: row.duty_date,
      hours: Number(row.hours),
      content: row.content,
      status: OVERTIME_STATUS_LABELS[row.status] ?? row.status,
      createdAt: row.created_at,
    });
  }
  styleHeader(overtimeSheet);

  return workbook;
}
