# CrewFlow

CrewFlow 是一个原生微信小程序与独立 API 服务组成的团队值班、调休和请假系统。

## 目录

- 小程序前端：仓库根目录
- 自建后端：`server/`
- 数据库迁移：`server/migrations/`
- 云服务器部署：`server/compose.yaml`

## 架构

- 微信小程序使用 `wx.login` 获取临时登录凭证。
- 后端通过微信 `jscode2session` 接口换取 `openid`，在本地数据库中建立用户身份。
- 后端签发短期业务 Token；微信 `AppSecret` 永远不下发到小程序。
- PostgreSQL 保存用户、值班、调休流水、请假和审批记录。

## 本地准备

当前开发环境使用本机 PostgreSQL。开发者工具访问 `http://127.0.0.1:3000`，真机
访问 `config/env.js` 中配置的电脑局域网地址。启动后端：

```bash
cd server
npm run dev
```

如果使用真机调试，`127.0.0.1` 指向手机而不是开发电脑。项目会在真机自动使用
`config/env.js` 的 `deviceApiBaseUrl`；电脑网络变化后需将其更新为新的局域网地址。
也可执行 `wx.setStorageSync('crewflow_api_base_url', 'https://你的地址')` 设置运行时覆盖。
正式环境应直接填写可从客户端访问的 HTTPS 域名。

局域网真机调试要求手机与电脑位于同一网络，并在开发者工具中关闭“校验合法域名”。
体验版和正式版本必须使用已在微信公众平台配置的 HTTPS 合法域名。

项目统一使用 WebView 渲染。开发者工具的 Skyline 模拟器存在中文输入法切换与组合
输入兼容问题，而项目没有依赖 Skyline 专属组件，因此使用 WebView 可确保开发者工具
与真机输入行为一致。发布体验版或正式版时，最低基础库版本仍设置为 `2.29.2`。

若开发者工具出现 `ERR_CONNECTION_REFUSED`，表示本地 API 尚未启动或地址不可达。
在 `server/` 执行 `npm run dev`，并确认 `config/env.js` 中的开发地址与服务端口一致；
请求层会将网络、鉴权、HTTP 和文件下载异常统一转换为可展示的错误，不会继续使用失效
登录态发起受保护请求。

后端开发命令见 `server/README.md`。

一期规则及仍待确认的细节见 `docs/business-rules.md`。
