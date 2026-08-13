import { config } from "../config.js";
import { db } from "../db.js";
import { sendSubscribeMessage } from "../wechat.js";
import { leavePolicies, type LeaveType } from "./leave-policy.js";

// 请假提交后，给审批管理员发送“待审批”订阅消息。
// 一次性订阅：发送成功后（或用户已拒收/未订阅）移除授权记录，管理员需再次点击开启。
export async function notifyApproverPending(leaveRequestId: string) {
  if (!config.WECHAT_SUBSCRIBE_TEMPLATE_ID) return;

  const result = await db.query<{
    approver_id: string;
    manager_openid: string | null;
    applicant_name: string | null;
    leave_type: LeaveType;
    start_date: string;
    end_date: string;
  }>(
    `SELECT approval.approver_id, manager.openid AS manager_openid,
            applicant.name AS applicant_name,
            leave.leave_type, leave.start_date::text, leave.end_date::text
     FROM leave_requests leave
     JOIN users applicant ON applicant.id = leave.applicant_id
     JOIN approval_records approval ON approval.leave_request_id = leave.id AND approval.step_no = 1
     JOIN users manager ON manager.id = approval.approver_id
     WHERE leave.id = $1`,
    [leaveRequestId],
  );
  const row = result.rows[0];
  if (!row) return;

  const subscription = await db.query<{ user_id: string }>(
    `SELECT user_id FROM notification_subscriptions
     WHERE user_id = $1 AND template_id = $2`,
    [row.approver_id, config.WECHAT_SUBSCRIBE_TEMPLATE_ID],
  );
  const subscriber = subscription.rows[0];
  if (!subscriber || !row.manager_openid) return;

  const templateId = config.WECHAT_SUBSCRIBE_TEMPLATE_ID;
  try {
    const body = await sendSubscribeMessage(
      row.manager_openid,
      templateId,
      {
        name1: { value: (row.applicant_name ?? "员工").slice(0, 8) },
        thing7: { value: leavePolicies[row.leave_type].label.slice(0, 20) },
        date3: { value: row.start_date },
        date4: { value: row.end_date },
        phrase11: { value: "待审批" },
      },
      "pages/approval/index",
    );
    const ok = body.errcode === 0;
    await db.query(
      `INSERT INTO notification_send_log (user_id, template_id, leave_request_id, status, errcode)
       VALUES ($1, $2, $3, $4, $5)`,
      [subscriber.user_id, templateId, leaveRequestId, ok ? "sent" : "failed", body.errcode ?? null],
    );
    // 一次性订阅已消费；43101/43104 表示用户未订阅或拒收，同样移除授权记录。
    if (ok || body.errcode === 43101 || body.errcode === 43104) {
      await db.query(
        `DELETE FROM notification_subscriptions WHERE user_id = $1 AND template_id = $2`,
        [subscriber.user_id, templateId],
      );
    }
    if (!ok) {
      console.error(`考勤审批提醒发送失败 errcode=${body.errcode} errmsg=${body.errmsg}`);
    }
  } catch (error) {
    console.error("考勤审批提醒发送异常", error);
  }
}
