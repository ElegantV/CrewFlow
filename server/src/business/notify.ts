import { config } from "../config.js";
import { db } from "../db.js";
import { sendWxPusherMessage } from "../wxpusher.js";
import { leavePolicies, type LeaveType } from "./leave-policy.js";

async function findUid(userId: string) {
  if (!config.WXPUSHER_APP_TOKEN) return null;
  const result = await db.query<{ uid: string | null }>(
    "SELECT uid FROM wxpusher_bindings WHERE user_id = $1",
    [userId],
  );
  return result.rows[0]?.uid || null;
}

// 请假提交后，给审批管理员推送"待审批"消息（wxpusher）。
// 调用方以 void 丢弃 Promise,而 Node 15+ 的 unhandledRejection 会直接打崩进程,
// 因此整个函数体(含 DB 查询)都必须在兜底 try/catch 内,通知失败绝不影响主流程。
export async function notifyApproverPending(leaveRequestId: string) {
  if (!config.WXPUSHER_APP_TOKEN) return;
  try {
    const result = await db.query<{
      approver_id: string;
      approver_name: string | null;
      applicant_name: string | null;
      leave_type: LeaveType;
      start_date: string;
      end_date: string;
      requested_days: string;
    }>(
      `SELECT approval.approver_id, approver.name AS approver_name,
              applicant.name AS applicant_name,
              leave.leave_type, leave.start_date::text, leave.end_date::text,
              leave.requested_days::text
       FROM leave_requests leave
       JOIN users applicant ON applicant.id = leave.applicant_id
       JOIN approval_records approval ON approval.leave_request_id = leave.id AND approval.step_no = 1
       JOIN users approver ON approver.id = approval.approver_id
       WHERE leave.id = $1`,
      [leaveRequestId],
    );
    const row = result.rows[0];
    if (!row) return;

    const uid = await findUid(row.approver_id);
    if (!uid) {
      console.warn(
        `wxpusher 待审批提醒跳过:审批管理员「${row.approver_name ?? row.approver_id}」未绑定微信推送`,
      );
      return;
    }

    const label = leavePolicies[row.leave_type].label;
    const range = row.start_date === row.end_date ? row.start_date : `${row.start_date} 至 ${row.end_date}`;
    const content =
      `【审批提醒】${row.applicant_name ?? "员工"}申请${label}（${range}，共${row.requested_days}天），` +
      `请及时在简序日程小程序中审批。`;
    // 标题简短展示申请概要,避免长内容被推送卡片截断。
    const summary = `${row.applicant_name ?? "员工"}申请${row.requested_days}天${label}`;
    const sent = await sendWxPusherMessage(content, [uid], summary);
    if (sent.code !== 1000) {
      console.error("wxpusher 待审批提醒发送失败", sent.code, sent.msg);
    }
  } catch (error) {
    console.error("wxpusher 待审批提醒发送异常", error);
  }
}

// 审批通过/驳回后，给申请人推送审批结果消息（wxpusher）。异常处理口径同上。
export async function notifyApplicantDecision(leaveRequestId: string, status: "approved" | "rejected") {
  if (!config.WXPUSHER_APP_TOKEN) return;
  try {
    const result = await db.query<{
      applicant_id: string;
      applicant_name: string | null;
      leave_type: LeaveType;
      start_date: string;
      end_date: string;
      requested_days: string;
    }>(
      `SELECT applicant.id AS applicant_id, applicant.name AS applicant_name,
              leave.leave_type, leave.start_date::text, leave.end_date::text,
              leave.requested_days::text
       FROM leave_requests leave
       JOIN users applicant ON applicant.id = leave.applicant_id
       WHERE leave.id = $1`,
      [leaveRequestId],
    );
    const row = result.rows[0];
    if (!row) return;

    const uid = await findUid(row.applicant_id);
    if (!uid) {
      console.warn(`wxpusher 审批结果提醒跳过:申请人「${row.applicant_name ?? row.applicant_id}」未绑定微信推送`);
      return;
    }

    const label = leavePolicies[row.leave_type].label;
    const range = row.start_date === row.end_date ? row.start_date : `${row.start_date} 至 ${row.end_date}`;
    const phrase = status === "approved" ? "已审批通过" : "未通过（已被驳回）";
    const content =
      `【审批结果】${row.applicant_name ?? "你"}申请的${label}（${range}，共${row.requested_days}天）${phrase}，` +
      `可到简序日程小程序查看详情。`;
    // 标题简短展示结果概要,避免长内容被推送卡片截断。
    const summary = `你的${label}申请${status === "approved" ? "已通过" : "未通过"}`;
    const sent = await sendWxPusherMessage(content, [uid], summary);
    if (sent.code !== 1000) {
      console.error("wxpusher 审批结果提醒发送失败", sent.code, sent.msg);
    }
  } catch (error) {
    console.error("wxpusher 审批结果提醒发送异常", error);
  }
}

// 加班登记后给本人推送"工作日加班打卡提醒"（wxpusher）。异常处理口径同上。
export async function notifyOvertimeCheckIn(
  userId: string,
  date: string,
  hours: number,
  endTime: string,
) {
  if (!config.WXPUSHER_APP_TOKEN) return;
  try {
    const uid = await findUid(userId);
    if (!uid) {
      console.warn(`wxpusher 加班打卡提醒跳过:用户「${userId}」未绑定微信推送`);
      return;
    }
    const content =
      `📋工作日加班打卡提醒\n\n` +
      `日期：${date}\n` +
      `时长：${hours}小时\n` +
      `打卡要求：🕢${endTime}:00之后打卡\n` +
      `备注：加班无需审批，随时可提，请保证打卡时长大于申请时长！`;
    const sent = await sendWxPusherMessage(content, [uid], "工作日加班打卡提醒");
    if (sent.code !== 1000) {
      console.error("wxpusher 加班打卡提醒发送失败", sent.code, sent.msg);
    }
  } catch (error) {
    console.error("wxpusher 加班打卡提醒发送异常", error);
  }
}
