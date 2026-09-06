import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { loadActiveActor } from "../authz.js";
import { beijingTodayIso } from "../business/beijing-date.js";
import { listCalendarDays } from "../business/calendar.js";

// 前端日历渲染用:返回指定年份的法定假与调休补班日(默认当年)。
export const calendarRoutes: FastifyPluginAsync = async (app) => {
  const protectedHooks = { onRequest: [app.authenticate, loadActiveActor] };

  app.get("/", protectedHooks, async (request) => {
    const parsed = z.object({
      year: z.string().regex(/^\d{4}$/).optional(),
    }).safeParse(request.query);
    const year = parsed.success && parsed.data.year
      ? Number(parsed.data.year)
      : Number(beijingTodayIso().slice(0, 4));
    const days = await listCalendarDays(year);
    return {
      year,
      days: days.map((day) => ({
        date: day.date,
        dayType: day.day_type,
        name: day.name,
        source: day.source,
      })),
    };
  });
};
