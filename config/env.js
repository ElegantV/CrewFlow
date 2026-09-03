// 生产/体验环境的 API 域名。备案通过后把这里改成真实域名即可，其它地方无需改动。
//
// 要求：
//   1. 必须是 HTTPS —— 微信小程序正式版与体验版强制校验合法域名，HTTP 会被拒绝；
//   2. 域名必须完成 ICP 备案，并在微信公众平台「开发管理 → 服务器域名 → request 合法域名」登记；
//   3. 不要带结尾斜杠，也不要带路径。
//
// 修改后请用微信开发者工具的「真机调试」验证一次，再提交审核。
const PRODUCTION_API_ORIGIN = 'https://api.example.com'

// 开发直连地址：绕过域名校验，方便连云端 ECS 调试。
// 2026-08-31 起由试用机 182.92.211.27 迁移至 99 元/年实例 101.201.100.221。
const DEVELOPMENT_API_ORIGIN = 'http://101.201.100.221:3000'

const environments = {
  develop: {
    // 开发者工具与真机都直连云端，本地无需再启动后端服务。
    apiBaseUrl: DEVELOPMENT_API_ORIGIN,
    deviceApiBaseUrl: DEVELOPMENT_API_ORIGIN
  },
  trial: {
    apiBaseUrl: PRODUCTION_API_ORIGIN
  },
  release: {
    apiBaseUrl: PRODUCTION_API_ORIGIN
  }
}

const API_OVERRIDE_KEY = 'crewflow_api_base_url'

function normalizeApiBaseUrl(value) {
  if (typeof value !== 'string') return ''
  const url = value.trim().replace(/\/$/, '')
  return /^https?:\/\/[^\s/]+(?::\d+)?(?:\/[^\s]*)?$/.test(url) ? url : ''
}

function runtimeApiOverride() {
  try {
    const value = wx.getStorageSync(API_OVERRIDE_KEY)
    return typeof value === 'string' ? value.trim() : ''
  } catch (error) {
    return ''
  }
}

function currentEnvironment() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion || 'develop'
  } catch (error) {
    return 'develop'
  }
}

function currentPlatform() {
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()
    return info.platform || ''
  } catch (error) {
    return 'devtools'
  }
}

function isLoopbackApi(url) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(url)
}

// 体验版与正式版必须走 HTTPS，否则微信会直接拒绝请求。
// 这里只在开发期给出醒目提示，不抛异常，避免配置未完成时整个小程序白屏。
function warnIfInsecure(environmentName, url) {
  if (environmentName === 'develop') return
  if (!url || /^https:\/\//i.test(url)) return
  console.error(
    `[CrewFlow] 当前为 ${environmentName} 环境，但 API 地址不是 HTTPS（${url}）。` +
      '微信会拒绝该请求，请在 config/env.js 中把 PRODUCTION_API_ORIGIN 改为备案过的 HTTPS 域名。'
  )
}

function getApiBaseUrl() {
  const environmentName = currentEnvironment()
  const platform = currentPlatform()
  let override = environmentName === 'develop' ? normalizeApiBaseUrl(runtimeApiOverride()) : ''
  // 开发者工具中保存的回环地址同步到真机后不可用，真机应回退到配置地址。
  if (platform !== 'devtools' && isLoopbackApi(override)) override = ''
  const environment = environments[environmentName] || environments.develop
  const configuredUrl = environmentName === 'develop' && platform !== 'devtools'
    ? environment.deviceApiBaseUrl || environment.apiBaseUrl
    : environment.apiBaseUrl
  const resolved = override || normalizeApiBaseUrl(configuredUrl)
  warnIfInsecure(environmentName, resolved)
  return resolved
}

function isApiConfigured() {
  return Boolean(getApiBaseUrl())
}

function isDevelopment() {
  return currentEnvironment() === 'develop'
}

module.exports = {
  API_OVERRIDE_KEY,
  clearApiBaseUrl() {
    try {
      wx.removeStorageSync(API_OVERRIDE_KEY)
    } catch (error) {
      // Storage is unavailable in non-WeChat tooling; the static config remains usable.
    }
  },
  getApiBaseUrl,
  isApiConfigured,
  isDevelopment,
  setApiBaseUrl(url) {
    const value = normalizeApiBaseUrl(url)
    if (!value) throw new Error('API 地址不能为空')
    if (!/^https?:\/\//.test(value)) throw new Error('API 地址必须以 http:// 或 https:// 开头')
    wx.setStorageSync(API_OVERRIDE_KEY, value)
    return value
  }
}
