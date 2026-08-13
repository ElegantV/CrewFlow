const environments = {
  develop: {
    // 开发者工具运行在电脑上，可以访问回环地址。
    apiBaseUrl: 'http://127.0.0.1:3000',
    // 真机必须访问开发电脑的局域网地址；网络变化后更新此处。
    deviceApiBaseUrl: 'http://172.20.10.8:3000'
  },
  trial: {
    apiBaseUrl: ''
  },
  release: {
    apiBaseUrl: ''
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
