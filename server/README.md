# CrewFlow API

## macOS 本地开发

```bash
brew install postgresql@17
brew services start postgresql@17
/opt/homebrew/opt/postgresql@17/bin/createdb crewflow
for migration in migrations/*.sql; do
  /opt/homebrew/opt/postgresql@17/bin/psql -v ON_ERROR_STOP=1 -d crewflow -f "$migration"
done

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

开发者工具使用 `http://127.0.0.1:3000`；真机自动使用 `config/env.js` 中的
`deviceApiBaseUrl`。两台设备需处于同一局域网，体验版及正式版本仍应使用公网 HTTPS 域名。

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
3. 创建 `.env`，设置微信密钥、JWT 密钥和数据库密码。
4. 执行 `docker compose up -d --build`。
5. 使用 Caddy 或 Nginx 配置 HTTPS，把公网 API 域名反向代理到 `127.0.0.1:3000`。

`deploy/Caddyfile.example` 提供了 Caddy 反向代理模板。替换其中的
`api.example.com` 后，Caddy 会自动申请和续期 HTTPS 证书。

不要把 `.env`、微信 `AppSecret` 或数据库密码提交到版本库。
