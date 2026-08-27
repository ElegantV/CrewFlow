import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  WECHAT_APP_ID: z.string().min(1),
  WECHAT_APP_SECRET: z.string().min(1),
  WECHAT_SUBSCRIBE_TEMPLATE_ID: z.string().default(""),
  WECHAT_SUBSCRIBE_STATE: z.enum(["developer", "trial", "formal"]).default("formal"),
  WXPUSHER_APP_TOKEN: z.string().default(""),
  BOOTSTRAP_SUPER_ADMIN_OPENID: z.string().default(""),
  CORS_ORIGINS: z.string().default(""),
  PDF_COMPANY_NAME: z.string().default("华银数字科技（北京）有限公司"),
  PDF_PROJECT_TEAM: z.string().default("经营分析决策"),
  PDF_WORK_LOCATION: z.string().default("博瑞"),
  PDF_FONT_PATH: z.string().default(""),
  PDF_FONT_FAMILY: z.string().default(""),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};
