# CrewFlow API

## macOS 本地开发

```bash
brew install postgresql@17
brew services start postgresql@17
/opt/homebrew/opt/postgresql@17/bin/createdb crewflow

cp .env.example .env
npm install
npm run dev
```

`npm run dev` 使用单进程启动方式，适合微信开发者工具和受限终端；需要文件变更自动
重启时可使用 `npm run dev:watch`。

开发配置监听 `0.0.0.0:3000`，以便同一局域网的真机访问；健康检查为 `GET /health`。

生成本地测试用户：

```bash
/opt/homebrew/opt/postgresql@17/bin/psql -v ON_ERROR_STOP=1 \
  -d crewflow -f seeds/001_test_users.sql
```

该脚本可重复执行，只更新 `crewflow-test-*` 测试账号，不覆盖真实微信账号。

本地后端以 `NODE_ENV=development` 运行时，小程序首页会显示“切换测试身份”。
测试登录接口只接受 `crewflow-test-*` 用户；在 `test` 或 `production` 环境中该接口
固定返回 404。点击“恢复真实微信登录”可重新执行微信登录。

### 数据库迁移

迁移文件按顺序放在 `migrations/`，由 `scripts/migrate.mjs` 幂等执行，并记录每个文件的
校验和。新增迁移请**新建文件**（如 `011_xxx.sql`），不要修改已执行过的文件——执行器会
检测内容漂移并拒绝运行。

```bash
# 容器内执行（推荐，镜像里已打包 scripts/ 与 migrations/）
docker compose run --rm api node scripts/migrate.mjs           # 应用待执行迁移
docker compose run --rm api node scripts/migrate.mjs --check    # 只检查，有未执行则返回 1

# 本机直接执行（需已安装依赖）
DATABASE_URL=postgresql://127.0.0.1:5432/crewflow node scripts/migrate.mjs
```

存量库首次执行时，脚本会发现版本表为空但业务表已存在，自动把 `009_wxpusher` 及之前的
迁移补录为「已执行」（校验和留空、不参与比对），然后从 `010` 继续。想跳过这个引导可加
`--no-baseline`。

> 背景：`migrations/` 同时还挂载到 db 容器的 `docker-entrypoint-initdb.d`，该机制只在
> **数据卷为空的首次启动**时运行一次，之后新增的迁移只能靠上面的命令推进。

### API 地址

`config/env.js` 里 `DEVELOPMENT_API_ORIGIN` 是开发直连地址（目前指向云端 ECS，本地无需
启动后端），`PRODUCTION_API_ORIGIN` 是体验版与正式版使用的 HTTPS 域名。域名备案通过后
只需改后一个常量。真机预览时若需临时改地址，可在小程序控制台执行：

```js
wx.setStorageSync('crewflow_api_base_url', 'https://你的地址')  // 仅开发版生效
wx.removeStorageSync('crewflow_api_base_url')
```

管理员和超级管理员首次审批前，需要在小程序“个人信息”中手写并保存审批签名。
审批通过后，申请人和审批管理员都能查看调休抵扣明细、一键复制审批内容，并下载
横向单页 PDF 请假单。审批时会固化签名、抵扣余额和年度汇总，之后更新签名不会改变
历史请假单。

PDF 默认使用 macOS 自带的华文黑体；Docker 镜像会安装 Noto CJK 字体。其他运行环境
若无法自动找到中文字体，请在 `.env` 中设置 `PDF_FONT_PATH`，TTC 字体还可通过
`PDF_FONT_FAMILY` 指定字体名称。

## 云服务器部署

1. 安装 Docker Engine 与 Compose 插件。
2. 将 `server/` 上传到服务器。
3. 创建 `.env`，设置微信密钥、JWT 密钥和数据库密码。生产环境必须设 `NODE_ENV=production`，
   否则 `/api/v1/auth/dev` 测试登录接口会暴露。
4. 先构建新镜像，再执行迁移，最后切流量——顺序不能反：

   ```bash
   docker compose build api
   docker compose run --rm api node scripts/migrate.mjs
   docker compose up -d
   ```

5. 配置 HTTPS：把 `deploy/Caddyfile` 里的 `api.example.com` 换成已备案的真实域名、
   `email` 换成真实邮箱，然后启动 Caddy。证书会自动申请与续期。
6. 在微信公众平台「开发管理 → 开发设置 → 服务器域名」把该域名加入 **request 合法域名**
   （还有 `downloadFile` 合法域名，PDF 请假单下载会用到）。

不要把 `.env`、微信 `AppSecret` 或数据库密码提交到版本库。

### 数据库备份

数据库承载请假、审批、签名等敏感记录，上线即应配置定时备份（`scripts/backup-database.sh`，
需在装有 Docker Compose 的服务器上执行）：

```bash
# 手动执行一次
./scripts/backup-database.sh

# 每天凌晨 02:30 自动备份、保留 14 天（crontab -e 添加）
30 2 * * * cd /部署目录/server && ./scripts/backup-database.sh >> backups/backup.log 2>&1
```

恢复：`gunzip -c backups/crewflow-xxxx.sql.gz | docker compose exec -T db psql --username crewflow --dbname crewflow`。
每次版本升级后建议做一次恢复演练，确认备份确实可用；备份目录可再同步一份到异机/对象存储。

### 管理员账号换绑微信号

「绑定已有用户」按姓名+手机号认领账号，不构成强身份证明，因此服务端限制：
停用账号不可绑定，且只能认领普通用户账号——禁止凭姓名+手机号接管管理员/超级管理员。
管理员更换微信号后，由超级管理员在服务器上更新该账号的 openid（或调整角色）。

### 上线自检清单

正式版提审前逐项确认：

- [ ] `config/env.js` 的 `PRODUCTION_API_ORIGIN` 已改为 HTTPS 域名，且不带结尾斜杠
- [ ] 域名已完成 ICP 备案，并已加入小程序后台的 request / downloadFile 合法域名
- [ ] 服务器安全组放行 443；3000 端口不应对公网开放（compose 已默认绑定 127.0.0.1，
      若自行调整端口映射需保持只由 Caddy 本机反代）
- [ ] `.env` 中 `NODE_ENV=production`，`JWT_SECRET` 至少 32 位随机字符串
- [ ] `npm run migrate:check` 返回「已是最新」，没有未执行的迁移
- [ ] 已配置数据库定时备份（`scripts/backup-database.sh` + crontab），并手动验证过一次备份可恢复
- [ ] `curl https://你的域名/health` 返回 `{"status":"ok"}`
- [ ] 真机预览走一遍：登录 → 登记加班 → 请调休假 → 审批通过 → 下载 PDF
- [ ] 管理员已在「个人信息」中保存手写签名，否则审批通过时无法固化签名
