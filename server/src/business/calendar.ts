// 法定节假日日历：数据存 calendar_days 表（只存法定假与调休补班日），
// 内存缓存供 isWorkdayDate 等同步函数高频查询。
// 数据来源 NateScarlet/holiday-cn（每日自动抓取国务院公告的 JSON），
// 管理员手工覆盖（source='manual'）优先级最高，同步永不覆盖。
import { z } from "zod";
import { db } from "../db.js";
import { beijingTodayIso } from "./beijing-date.js";

export type CalendarDayType = "holiday" | "makeup";

// jsDelivr 镜像为主（国内服务器可达），GitHub raw 兜底。
const SOURCE_URLS = (year: number) => [
  `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
  `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
];

const holidayCnPayloadSchema = z.object({
  days: z.array(z.object({
    name: z.string().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    isOffDay: z.boolean(),
  })).optional(),
});

const cache = new Map<string, CalendarDayType>();

export async function loadCalendarCache() {
  const result = await db.query<{ date: string; day_type: CalendarDayType }>(
    "SELECT date::text, day_type FROM calendar_days",
  );
  cache.clear();
  for (const row of result.rows) {
    cache.set(row.date, row.day_type);
  }
}

export function calendarDayType(isoDate: string): CalendarDayType | undefined {
  return cache.get(isoDate);
}

// AI 提示词等场景需要全量异常日快照。
export function calendarExceptions() {
  const holidays: string[] = [];
  const makeups: string[] = [];
  for (const [date, dayType] of cache) {
    (dayType === "holiday" ? holidays : makeups).push(date);
  }
  return { holidays: holidays.sort(), makeups: makeups.sort() };
}

export async function listCalendarDays(year: number) {
  const result = await db.query<{
    date: string;
    day_type: CalendarDayType;
    name: string;
    source: string;
  }>(
    `SELECT date::text, day_type, name, source
     FROM calendar_days
     WHERE date >= $1 AND date <= $2
     ORDER BY date`,
    [`${year}-01-01`, `${year}-12-31`],
  );
  return result.rows;
}

async function fetchYearPayload(year: number, log?: { warn: (obj: unknown, msg: string) => void }) {
  for (const url of SOURCE_URLS(year)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      const parsed = holidayCnPayloadSchema.safeParse(await response.json());
      if (!parsed.success) continue;
      return parsed.data.days ?? [];
    } catch (error) {
      log?.warn({ err: error, url }, "holiday-cn source fetch failed");
    }
  }
  return null;
}

// isOffDay=true 为法定假，false 为调休补班；manual 行不被覆盖。
export async function syncCalendarYear(
  year: number,
  log?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void },
) {
  const days = await fetchYearPayload(year, log);
  if (!days) {
    log?.warn({ year }, "holiday-cn sync skipped: all sources unavailable");
    return { ok: false as const, year };
  }
  for (const day of days) {
    const dayType: CalendarDayType = day.isOffDay ? "holiday" : "makeup";
    await db.query(
      `INSERT INTO calendar_days (date, day_type, name, source)
       VALUES ($1, $2, $3, 'auto')
       ON CONFLICT (date) DO UPDATE
       SET day_type = EXCLUDED.day_type,
           name = EXCLUDED.name,
           updated_at = now()
       WHERE calendar_days.source <> 'manual'`,
      [day.date, dayType, day.name ?? ""],
    );
  }
  await loadCalendarCache();
  log?.info({ year, imported: days.length }, "holiday-cn sync done");
  return { ok: true as const, year, imported: days.length };
}

// 同步当年与次年（次年公告通常 11 月底发布，同步失败无副作用，次日重试）。
export async function syncCalendar(
  log?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void },
) {
  const year = Number(beijingTodayIso().slice(0, 4));
  const current = await syncCalendarYear(year, log);
  const next = await syncCalendarYear(year + 1, log);
  return { current, next };
}

// 生产入口（index.ts）调用：启动先同步一次，之后每 24 小时重试。
export function startCalendarSync(
  log: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void },
) {
  void syncCalendar(log).catch((error) => log.warn({ err: error }, "calendar sync failed"));
  const timer = setInterval(() => {
    void syncCalendar(log).catch((error) => log.warn({ err: error }, "calendar sync failed"));
  }, 24 * 60 * 60 * 1000);
  timer.unref?.();
}
