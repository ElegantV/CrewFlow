export const leavePolicies = {
  comp_time: { label: "调休", minimumHours: 4, incrementHours: 4, consumesTimeoff: true },
  public_out: { label: "公出", minimumHours: 4, incrementHours: 4 },
  breastfeeding: { label: "哺乳假", minimumHours: 4, incrementHours: 4 },
  annual: { label: "年假", minimumHours: 8, incrementHours: 8 },
  sick: { label: "病假", minimumHours: 8, incrementHours: 8, proof: "病例或诊断材料" },
  personal: { label: "事假", minimumHours: 8, incrementHours: 8 },
  prenatal: { label: "产检假", minimumHours: 8, incrementHours: 8 },
  maternity: { label: "产假", minimumHours: 8, incrementHours: 8 },
  parental: { label: "育儿假", minimumHours: 8, incrementHours: 8 },
  bereavement: { label: "丧假", minimumHours: 8, incrementHours: 8, proof: "死亡证明" },
  marriage: { label: "婚假", minimumHours: 80, incrementHours: 80, fixedWorkdays: 10, proof: "结婚证" },
  paternity: { label: "陪产假", minimumHours: 120, incrementHours: 120, fixedWorkdays: 15, proof: "出生证明" },
} as const;

export type LeaveType = keyof typeof leavePolicies;
export type DayPeriod = "morning" | "afternoon" | "day";

export function validatePeriodRange(
  startDate: string,
  endDate: string,
  startPeriod: DayPeriod,
  endPeriod: DayPeriod,
) {
  if (startDate !== endDate) return true;
  if (startPeriod === "day" || endPeriod === "day") {
    return startPeriod === "day" && endPeriod === "day";
  }
  return !(startPeriod === "afternoon" && endPeriod === "morning");
}

function parseDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function isValidDate(value: string) {
  const date = parseDate(value);
  return !Number.isNaN(date.getTime()) && formatDate(date) === value;
}

function isWorkday(value: Date) {
  const day = value.getUTCDay();
  return day !== 0 && day !== 6;
}

export function addWorkdays(startDate: string, workdays: number) {
  const cursor = parseDate(startDate);
  let counted = 0;
  while (counted < workdays) {
    if (isWorkday(cursor)) {
      counted += 1;
      if (counted === workdays) {
        break;
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return formatDate(cursor);
}

export function calculateWorkingHours(
  startDate: string,
  endDate: string,
  startPeriod: DayPeriod,
  endPeriod: DayPeriod,
) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  let total = 0;
  const cursor = new Date(start);

  while (cursor <= end) {
    if (isWorkday(cursor)) {
      const current = formatDate(cursor);
      if (startDate === endDate) {
        // 同一天：全天 8 小时；上午+下午（时段不同）也按全天；单一上/下午按 4 小时。
        total += startPeriod === "day" || startPeriod !== endPeriod ? 8 : 4;
      } else if (current === startDate) {
        // 多天范围的开始日：全天 8 小时，仅上午或仅下午按 4 小时。
        total += startPeriod === "day" ? 8 : 4;
      } else if (current === endDate) {
        // 多天范围的结束日：全天 8 小时，仅上午或仅下午按 4 小时。
        total += endPeriod === "day" ? 8 : 4;
      } else {
        total += 8;
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return total;
}

export function publicLeavePolicies() {
  return Object.entries(leavePolicies).map(([value, policy]) => ({
    value,
    label: policy.label,
    minimumHours: policy.minimumHours,
    incrementHours: policy.incrementHours,
    fixedWorkdays: "fixedWorkdays" in policy ? policy.fixedWorkdays : null,
    proofNotice: "proof" in policy ? `申请时请准备${policy.proof}` : null,
    consumesTimeoff: "consumesTimeoff" in policy && policy.consumesTimeoff,
  }));
}
