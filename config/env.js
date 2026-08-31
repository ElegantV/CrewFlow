const environments = {
  develop: {
    // 开发者工具也直接连云端,本地无需再启动后端服务(2026-08-31 起)。
    apiBaseUrl: 'http://101.201.100.221:3000',
    // 真机预览走阿里云正式 ECS(公网可达,手机无需与服务器同网)。
    // 2026-08-31 起由试用机 182.92.211.27 迁移至 99 元/年实例 101.201.100.221。
    deviceApiBaseUrl: 'http://101.201.100.221:3000'
  },
  trial: {
    // 体验版:测试人员在手机上开启"调试"后可绕过合法域名校验,用 IP 联调。
    // 正式对外前必须更换为 HTTPS 备案域名。
    apiBaseUrl: 'http://101.201.100.221:3000'
  },
  release: {
    // 2026-08-29 决定:先用 ECS 试用机 IP 提交审核(明知合法域名不合规,可能被拒)。
    // 被拒后切换为 HTTPS 备案域名并重提;同时需在公众平台加入 request 合法域名。
    apiBaseUrl: 'http://101.201.100.221:3000'
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

function getApiBaseUrl() {
  const environmentName = currentEnvironment()
  const platform = currentPlatform()
  let override = environmentName === 'develop' ? normalizeApiBaseUrl(runtimeApiOverride()) : ''
  // 开发者工具中保存的回环地址同步到真机后不可用，真机应回退到局域网地址。
  if (platform !== 'devtools' && isLoopbackApi(override)) override = ''
  const environment = environments[environmentName] || environments.develop
  const configuredUrl = environmentName === 'develop' && platform !== 'devtools'
    ? environment.deviceApiBaseUrl
    : environment.apiBaseUrl
  return override || normalizeApiBaseUrl(configuredUrl)
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
