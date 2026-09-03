#!/usr/bin/env node
// 迁移执行器：按文件名顺序应用 migrations/ 下尚未执行的 SQL，并记录校验和。
//
// 为什么需要它：migrations/ 原先只通过 docker-entrypoint-initdb.d 挂载给 db 容器，
// 该机制只在**数据卷为空的首次启动**时执行，之后新增的迁移文件永远不会自动运行。
// 有了版本记录表后，迁移变成幂等、可追溯、可校验的操作。
//
// 只依赖 pg（生产依赖），可直接在容器内运行：
//   docker compose run --rm api node scripts/migrate.mjs           # 执行待应用迁移
//   docker compose run --rm api node scripts/migrate.mjs --check    # 只检查，有未执行则返回 1
//   docker compose run --rm api node scripts/migrate.mjs --no-baseline
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const CHECK_ONLY = process.argv.includes("--check");
const NO_BASELINE = process.argv.includes("--no-baseline");

// 引入版本表之前的最后一个迁移。存量库（版本表为空但业务表已存在）会把它及之前的
// 迁移补录为"已执行"，避免重复建表导致失败。新增迁移时不需要改这里。
const BASELINE_VERSION = "009_wxpusher";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function fail(message) {
  console.error(`[migrate] ${message}`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  fail("缺少 DATABASE_URL，请在 .env 或运行环境中配置后再执行。");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  options: "-c timezone=Asia/Shanghai",
  max: 2,
});

async function readMigrationFiles() {
  const files = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name.slice(0, -4))
    .sort();
  if (files.length === 0) {
    fail(`未在 ${MIGRATIONS_DIR} 找到任何 .sql 迁移文件。`);
  }
  return files;
}

// 存量库引导：版本表为空、但业务表已经存在，说明这些迁移在引入版本表之前就执行过了。
// 补录为空校验和（"历史版本，不做内容校验"），然后从 BASELINE_VERSION 之后继续。
async function bootstrapBaseline(client, versions) {
  const counted = await client.query("SELECT count(*)::int AS count FROM schema_migrations");
  if (counted.rows[0].count > 0) return;

  const probed = await client.query("SELECT to_regclass('public.users') AS users_table");
  if (!probed.rows[0].users_table) return; // 全新库，从 001 正常执行

  if (NO_BASELINE) {
    console.log("[migrate] 检测到存量库，但已指定 --no-baseline，将尝试执行全部迁移。");
    return;
  }

  const backfill = versions.filter((version) => version <= BASELINE_VERSION);
  if (backfill.length === 0) return;

  for (const version of backfill) {
    await client.query(
      "INSERT INTO schema_migrations (version, checksum) VALUES ($1, '') ON CONFLICT (version) DO NOTHING",
      [version],
    );
  }
  console.log(
    `[migrate] 存量库引导：已补录 ${backfill.length} 个历史迁移（≤ ${BASELINE_VERSION}），` +
      "这些内容不参与校验和比对。",
  );
}

async function main() {
  const versions = await readMigrationFiles();
  const client = await pool.connect();
  try {
    // 先自建版本表，避免 010 与执行器之间的先后依赖。
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version varchar(255) PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    await bootstrapBaseline(client, versions);

    const appliedResult = await client.query("SELECT version, checksum FROM schema_migrations");
    const applied = new Map(appliedResult.rows.map((row) => [row.version, row.checksum]));

    const pending = [];
    for (const version of versions) {
      const sql = await readFile(join(MIGRATIONS_DIR, `${version}.sql`), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const recorded = applied.get(version);

      if (recorded === checksum) continue;
      if (recorded === undefined) {
        pending.push({ version, sql, checksum });
        continue;
      }
      // 空校验和表示补录的历史版本，不做内容校验。
      if (recorded === "") continue;
      fail(
        `迁移 ${version} 的内容已被改写（记录 ${recorded.slice(0, 12)}…，当前 ${checksum.slice(0, 12)}…）。` +
          "已执行的迁移不可修改，请新增一个新版本文件来修正。",
      );
    }

    if (pending.length === 0) {
      console.log(`[migrate] 已是最新，共 ${versions.length} 个迁移，无需执行。`);
      return;
    }

    if (CHECK_ONLY) {
      console.log(`[migrate] 有 ${pending.length} 个待执行迁移：`);
      for (const item of pending) console.log(`  - ${item.version}`);
      process.exitCode = 1;
      return;
    }

    for (const item of pending) {
      process.stdout.write(`[migrate] 执行 ${item.version} … `);
      try {
        await client.query("BEGIN");
        await client.query(item.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
          [item.version, item.checksum],
        );
        await client.query("COMMIT");
        console.log("完成");
      } catch (error) {
        await client.query("ROLLBACK");
        console.log("失败");
        throw error;
      }
    }
    console.log(`[migrate] 全部完成，本次执行 ${pending.length} 个迁移。`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
