# CrewFlow 项目长期约定

## 部署与迁移（2026-08-31 建立）

- **迁移唯一入口**：`npm run migrate`（容器内执行 `scripts/migrate.mjs`）。
  新增迁移必须**新建文件** `NNN_xxx.sql`，禁止改写已执行的迁移——执行器用 sha256 校验和检测漂移并拒绝运行。
- **存量库基线**：`BASELINE_VERSION = "009_wxpusher"`。版本表为空但 `users` 表存在时，脚本自动把基线及之前的迁移补录为「已执行」（校验和留空、不参与比对）。若以后再加历史迁移需要调整这个常量。
- **部署顺序不能反**：`docker compose build api` → `npm run migrate` → `docker compose up -d`。
- **`migrations/` 挂在 db 容器的 initdb.d**，只在数据卷为空的首次启动运行。这是当时踩的坑，别再指望它推增量迁移。

## 环境配置

- 小程序 API 地址只改 `config/env.js` 顶部两个常量：`DEVELOPMENT_API_ORIGIN`（开发直连，目前是 ECS IP + HTTP）、`PRODUCTION_API_ORIGIN`（体验版/正式版，必须 HTTPS 备案域名）。
- 非 develop 环境若解析出非 HTTPS 地址，会在控制台打 `[CrewFlow]` 警告，但不抛异常（避免配置未完成时白屏）。

## 线上现状

- ECS `101.201.100.221:3000`（99 元/年实例，2026-08-31 从试用机迁来），`/health` 正常。
- 域名 ICP 备案审核中；小程序本身已备案。备案下来后：填 `PRODUCTION_API_ORIGIN` → 配 `server/deploy/Caddyfile`（域名 + email 两处）→ 公众平台加 request/downloadFile 合法域名 → 提审。
- 安全组：443 放行，**3000 端口不应公网开放**（只由 Caddy 本机反代）。

## 用户偏好

- 前端框架偏好 Vue 生态（非 React 阵营）——虽然本项目小程序是原生写法。
- 提问时希望得到明确的推荐方案，而不是一堆并列选项。
- 待补充：称呼、所在城市。

## 产品与代码命名（易混，注意）

- 代码仓库名：CrewFlow；面向用户的品牌名：**简序日程**（app.js 报错、助手问候、通知文案均用此名）。
- 小程序原生写法（不是 uni-app / Taro），渲染器强制 WebView（app.json `renderer: "webview"`）。

## AI 助手真相（关键）

- `pages/assistant` 的"AI 助手"是**纯规则引擎**（正则 + 意图槽位），**没有接大模型/LLM**。
- 解析器在 `utils/assistant-command.js`（通用指令：加班/查询/审批/通讯录/导航）+ `utils/assistant-parser.js`（请假草稿对话）。
- 语音输入依赖微信「同声传译」插件（WechatSI），未配置则降级。
- 含义：想做"真 AI 对话"是较大的增强项，不是现状。

## 样式设计 token（2026-08-31 建立）

- 全站颜色/圆角/阴影统一在 `app.wxss` 的 `page` 选择器里定义 CSS 变量（`--brand`/`--brand-deep`/`--brand-ai-*`/`--c-*`/`--r-*`/`--shadow-*`）。
- 页面与组件 **不得再硬编码散落的十六进制色值**（尤其 6 个散落蓝 #1677ff/#2563eb/#2f6fed/#246bfd/#1d4ed8/#4f8cff，已归并到 --brand / --brand-deep / --brand-ai-from）；新增颜色一律走 token。
- 状态语义：info=蓝(#2563eb/#eff6ff)、success=绿(#047857/#ecfdf5)、warning=琥珀(#92400e/#fffbeb)、danger=红(#b42318/#fef2f2)、neutral=灰(#718096/#edf2f7)。
- 布局已统一 flex：`page{height:100vh;display:flex;flex-direction:column}` + `.scrollarea{flex:1;height:0}`；尺寸用 `rpx` 不用 `px`（nav-bar 组件除外）。

## 后续开发路线（权威来源）

- `docs/pycode-migration-plan.md`：把旧 pycode(Flask+MySQL) 全量迁到 CrewFlow。P0=迁移脚本+批量管理页+兼容台账；P1=定时提醒/调休到期预警/产假158天/批量审批/`situation` 排除法定节假日；P2=Excel导出/年假视图/哺乳假额度/值班调休联动。
- 上线阻塞：域名 ICP 备案完成后填 `PRODUCTION_API_ORIGIN` → 配 `server/deploy/Caddyfile` → 公众平台加 request/downloadFile 合法域名 → 提审。

## 2026-08-31 工作区状态（未提交 WIP）

- 已改未提交：`app.json`(WechatSI 0.3.5→0.3.10)、`config/env.js`(抽出 PRODUCTION/DEVELOPMENT_API_ORIGIN 常量)、`pages/dev/users.js`、`server/Dockerfile`、`server/README.md`、`server/package.json`。
- 已暂存删除：`server/deploy/Caddyfile.example`（线上用 `Caddyfile` 实体文件）。
- 线上 ECS `101.201.100.221:3000` 已在跑；域名备案审核中。
