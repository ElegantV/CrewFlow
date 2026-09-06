# CrewFlow 项目备忘（供 AI 助手快速了解）

原生微信小程序（仓库根目录）+ Fastify/PostgreSQL 服务端（`server/`），团队值班、调休、请假系统。

## 部署方式（2026-09-06 实操验证）

生产环境为阿里云 ECS，服务端目录**不是 git 仓库**，靠 rsync 同步：

- 服务器：`root@101.201.100.221`，SSH 密钥 `~/.ssh/aliyun_182`（无 ssh config 别名）
- 目标目录：`/opt/crewflow`（`server/` 的拷贝），compose 项目名 `crewflow`，服务 `api` + `db`
- 小程序端发布只能在微信开发者工具手动上传（无 CI），本仓库的"上线"通常指服务端

### 服务端上线流程

```bash
# 1. 同步代码（仓库根目录执行；绝不覆盖服务器 .env）
rsync -av --exclude=".env" --exclude="node_modules" --exclude="dist" \
  --exclude="backups" --exclude="backup.log" --exclude="test-results" \
  -e "ssh -i ~/.ssh/aliyun_182" server/ root@101.201.100.221:/opt/crewflow/

# 2-5. 以下均在 ECS 上、/opt/crewflow 内执行（顺序不能反）
./scripts/backup-database.sh                              # 迁移前必备份
docker compose build api                                  # 先构建
docker compose run --rm api node scripts/migrate.mjs      # 再迁移（幂等，版本表在 schema_migrations）
docker compose up -d                                      # 最后切流量
```

### 部署后验证

- `curl http://127.0.0.1:3000/health` → `{"status":"ok","db":true}`
- `docker logs crewflow-api-1 --tail 50` 无未处理异常
- 有新迁移时，进 db 容器抽查表数据（如 `SELECT count(*) FROM calendar_days`）

### 注意事项

- **NODE_ENV 检查项**：服务器 `.env` 若为 `development`（供 SSH 隧道调试用 dev 测试登录接口），
  提审/上线前必须改回 `production` 并 `docker compose up -d` 重启。开发调试的隧道方式见
  `config/env.js` 注释。
- 数据库定时备份：crontab 每日 02:30 跑 `scripts/backup-database.sh`，保留 14 天，备份在
  `/opt/crewflow/backups/`。
- 本地开发/测试：`server/README.md`；API 集成测试 `npm run test:api`（Playwright）与
  `npm test`（node:test），测试库 `crewflow_test`，迁移需手动应用到该库。
