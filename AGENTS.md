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
- 公网验证：`curl https://api.ccherry.cn/health`（经 nginx 反代）
- `docker logs crewflow-api-1 --tail 50` 无未处理异常
- 有新迁移时，进 db 容器抽查表数据（如 `SELECT count(*) FROM calendar_days`）

## 域名与 HTTPS（2026-09-07 已上线）

- 备案域名 `ccherry.cn`，API 用子域 **`api.ccherry.cn`**（A 记录 → `101.201.100.221`，DNS 在阿里云/hichina）
- ECS 上 nginx 反代 `443 → 127.0.0.1:3000`，证书为 Let's Encrypt（`certbot` 已配自动续期，配置在
  `/etc/nginx/sites-available/crewflow`）；80 会 301 跳 HTTPS
- **阿里云安全组需放行入方向 80 和 443**（IP 归属变更/重装后要复查）
- 小程序 `config/env.js` 的 `PRODUCTION_API_ORIGIN` = `https://api.ccherry.cn`（trial/release 生效）
- 微信公众平台服务器域名只需配：
  - request 合法域名：`https://api.ccherry.cn`
  - downloadFile 合法域名：`https://api.ccherry.cn`
  - DNS 预解析域名（选填）：`api.ccherry.cn`（不带协议头）
  - uploadFile / socket / udp / tcp / 预连接：**不配**（项目未使用）
- 微信「API 密钥（API 安全）」页面不用配置（未启用接口加解密，服务端调微信接口为明文 HTTPS）

## 小程序打包注意事项

- `project.config.json` 的 `packOptions.ignore` 已排除：`server`、`test`、`docs`、
  `assets/appicon`（后台手动上传的头像设计稿，不进包）、`assets/icons/generate.js`（SVG→PNG 构建脚本）
- 主包约 816K（<1.5M 限制）；图标均在 `assets/icons/`（<6K，无 >200K 资源）
- 头像在「小程序后台 → 设置 → 头像」手动上传 `assets/appicon/appicon-1024.png`
- 版本备注应写清本次增量改动，便于审核；每次提审/上传后同步更新 `CHANGELOG.md`
- **版本记录流程**：每次 git 提交后，列出本次提交的版本备注与版本号，待用户确认后再写入 `CHANGELOG.md`（未经确认不得擅自写入）；
  确认后除写入完整版外，另出一份**简版项目备注**（供微信开发者工具上传/提审填写，≤5 条、每条一句话，只写用户可感知的增量）

## 已知关键逻辑（改动时注意）

- **网络瞬时失败不清会话**（`services/request.js`）：wx.request 网络失败只置 `apiStatus='unavailable'`
  保留 token，下一次请求成功自动恢复 `ready`；只有 401/403 才清会话。曾因失败即清 token 导致
  真机「尚未连接后端」卡死。修改时勿回退此行为。
- 半天（4 小时）请假仅支持 调休/公出/哺乳假（`leave-policy.ts` 中只有这三种 `minimumHours: 4`）
- 年假提交校验剩余额度（`leaves.ts` 事务内 `ANNUAL_LEAVE_INSUFFICIENT`），额度按 `work_start_date`
  当年工龄计算（满一年可休，<5 年 5 天，之后逐年 +1 上限 15）

## 本地开发 / 测试

- 服务端：`server/README.md`；API 集成测试 `npm run test:api`（Playwright）与 `npm test`
  （node:test），测试库 `crewflow_test`，迁移需手动应用到该库
- 开发版真机调试走本地 SSH 隧道：`autossh` 保活启动（本机执行）：
  ```bash
  autossh -M 0 -N -f -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes -i ~/.ssh/aliyun_182 \
    -L 0.0.0.0:3100:127.0.0.1:3000 root@101.201.100.221 -F /dev/null
  ```
  `config/env.js` 的 `DEVICE_API_ORIGIN` 需与本机当前局域网 IP 一致（`ipconfig getifaddr en0`）。
  ⚠️ 隧道仅供开发版调试；体验版/正式版走 `https://api.ccherry.cn`，不依赖隧道。

## 注意事项

- **NODE_ENV 当前为 `production`**：服务器 `.env` 若改成 `development`（供 SSH 隧道调试用 dev 测试
  登录接口），提审/上线前必须改回 `production` 并 `docker compose up -d` 重启。`development` 下
  会多出 `/api/v1/auth/dev/users` 与 `/api/v1/auth/dev` 测试登录接口。
- 数据库定时备份：crontab 每日 02:30 跑 `scripts/backup-database.sh`，保留 14 天，备份在
  `/opt/crewflow/backups/`。