import { config } from "../config.js";
import { db } from "../db.js";
import { sendWxPusherMessage } from "../wxpusher.js";
import { leavePolicies, type LeaveType } from "./leave-policy.js";

type StaleApproval = {
  id: string;
  approver_id: string;
  approver_name: string | null;
  applicant_name: string | null;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  requested_days: string;
  submitted_at: string;
};

type StaleOvertimeApproval = {
  id: string;
  approver_id: string;
  approver_name: string | null;
  applicant_name: string | null;
  duty_date: string;
  hours: string;
  content: string;
};

type ReminderLog = {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
};

// 审批超时催办：找出已待审批超过 24 小时、且近 24 小时内未再催办过的申请，
// 给审批管理员推送催办提醒（wxpusher）。同一条申请每满 24 小时仍无人处理会再次提醒。
export async function remindStaleApprovals() {
  if (!config.WXPUSHER_APP_TOKEN) return;
  const [leaveResult, overtimeResult] = await Promise.all([
    db.query<StaleApproval>(
      `SELECT approval.id, approval.approver_id, approver.name AS approver_name,
              applicant.name AS applicant_name,
              leave.leave_type, leave.start_date::text, leave.end_date::text,
              leave.requested_days::text, leave.submitted_at::text
       FROM approval_records approval
       JOIN leave_requests leave ON leave.id = approval.leave_request_id
       JOIN users applicant ON applicant.id = leave.applicant_id
       JOIN users approver ON approver.id = approval.approver_id
       WHERE approval.status = 'pending'
         AND leave.status = 'pending'
         AND approval.created_at < now() - interval '24 hours'
         AND (approval.last_reminded_at IS NULL
              OR approval.last_reminded_at < now() - interval '24 hours')
       ORDER BY approval.created_at
       LIMIT 20`,
    ),
    db.query<StaleOvertimeApproval>(
      `SELECT approval.id, approval.approver_id, approver.name AS approver_name,
              applicant.name AS applicant_name,
              duty.duty_date::text, duty.hours::text, duty.content
       FROM approval_records approval
       JOIN duty_records duty ON duty.id = approval.duty_record_id
       JOIN users applicant ON applicant.id = duty.user_id
       JOIN users approver ON approver.id = approval.approver_id
       WHERE approval.status = 'pending'
         AND duty.status = 'pending'
         AND approval.created_at < now() - interval '24 hours'
         AND (approval.last_reminded_at IS NULL
              OR approval.last_reminded_at < now() - interval '24 hours')
       ORDER BY approval.created_at
       LIMIT 20`,
    ),
  ]);
  for (const row of leaveResult.rows) {
    await remindOne(row);
  }
  for (const row of overtimeResult.rows) {
    await remindOvertimeOne(row);
  }
}

async function remindOne(row: StaleApproval) {
  // 无论是否推送成功都记录提醒时间，避免未绑定推送的用户每轮调度重复告警刷屏；
  // 下次提醒会按 24 小时窗口再次触发，直至该申请被处理。
  const markReminded = () =>
    db.query("UPDATE approval_records SET last_reminded_at = now() WHERE id = $1", [row.id]);
  try {
    const uidResult = await db.query<{ uid: string | null }>(
      "SELECT uid FROM wxpusher_bindings WHERE user_id = $1",
      [row.approver_id],
    );
    const uid = uidResult.rows[0]?.uid || null;
    if (!uid) {
      console.warn(
        `wxpusher 审批超时催办跳过:审批管理员「${row.approver_name ?? row.approver_id}」未绑定微信推送`,
      );
      await markReminded();
      return;
    }
    const label = leavePolicies[row.leave_type].label;
    const range = row.start_date === row.end_date ? row.start_date : `${row.start_date} 至 ${row.end_date}`;
    const submitted = row.submitted_at.slice(0, 16).replace("T", " ");
    const content =
      `【审批催办】${row.applicant_name ?? "员工"}于 ${submitted} 提交的${label}申请` +
      `（${range}，共${row.requested_days}天）已超过24小时未处理，请尽快登录简序日程审批。`;
    const summary = `${row.applicant_name ?? "员工"}申请${row.requested_days}天${label}待审批超24小时`;
    const sent = await sendWxPusherMessage(content, [uid], summary);
    if (sent.code !== 1000) {
      console.error("wxpusher 审批超时催办发送失败", sent.code, sent.msg);
    }
    await markReminded();
  } catch (error) {
    console.error("wxpusher 审批超时催办发送异常", error);
  }
}

async function remindOvertimeOne(row: StaleOvertimeApproval) {
  // 与请假催办一致：无论推送是否成功都记录提醒时间，避免重复告警。
  const markReminded = () =>
    db.query("UPDATE approval_records SET last_reminded_at = now() WHERE id = $1", [row.id]);
  try {
    const uidResult = await db.query<{ uid: string | null }>(
      "SELECT uid FROM wxpusher_bindings WHERE user_id = $1",
      [row.approver_id],
    );
    const uid = uidResult.rows[0]?.uid || null;
    if (!uid) {
      console.warn(
        `wxpusher 加班审批超时催办跳过:审批管理员「${row.approver_name ?? row.approver_id}」未绑定微信推送`,
      );
      await markReminded();
      return;
    }
    const hours = Number(row.hours);
    const content =
      `【审批催办】${row.applicant_name ?? "员工"}登记的加班（${row.duty_date}，${hours}小时：${row.content}）` +
      `已超过24小时未处理，请尽快登录简序日程审批。`;
    const summary = `${row.applicant_name ?? "员工"}加班${hours}小时待审批超24小时`;
    const sent = await sendWxPusherMessage(content, [uid], summary);
    if (sent.code !== 1000) {
      console.error("wxpusher 加班审批超时催办发送失败", sent.code, sent.msg);
    }
    await markReminded();
  } catch (error) {
    console.error("wxpusher 加班审批超时催办发送异常", error);
  }
}

// 生产入口（index.ts）调用：启动先扫一次，之后每 15 分钟检查。依赖单实例调度。
export function startApprovalReminderLoop(log?: ReminderLog) {
  if (!config.WXPUSHER_APP_TOKEN) {
    log?.info?.({}, "未配置 WXPUSHER_APP_TOKEN，审批超时催办未启用");
    return;
  }
  const run = () => {
    void remindStaleApprovals().catch((error) =>
      log?.warn?.({ err: error }, "approval timeout reminder failed"),
    );
  };
  run();
  const timer = setInterval(run, 15 * 60 * 1000);
  timer.unref?.();
}
