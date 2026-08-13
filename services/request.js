const { getApiBaseUrl } = require('../config/env')
const session = require('../utils/session')

let apiUnavailableUntil = 0

function unavailableError() {
  return {
    code: 'NETWORK_ERROR',
    message: '服务器暂时不可用，请检查网络或 API 地址',
    statusCode: 0
  }
}

function getAppSafely() {
  try {
    return typeof getApp === 'function' ? getApp() : null
  } catch (error) {
    return null
  }
}

function clearAuthenticatedUser(markApiUnavailable = false) {
  session.clearSession()
  const app = getAppSafely()
  if (app && app.globalData) {
    app.globalData.user = null
    if (markApiUnavailable && app.globalData.apiConfigured) {
      app.globalData.apiStatus = 'unavailable'
    } else if (!markApiUnavailable) {
      app.globalData.apiStatus = 'auth_required'
    }
  }
}

function waitForAppReady(options) {
  if (options.skipAuth) return Promise.resolve()
  const app = getAppSafely()
  return app && app.ready ? Promise.resolve(app.ready).then(() => undefined) : Promise.resolve()
}

function request(options = {}) {
  const requestOptions = options || {}
  return waitForAppReady(requestOptions).then(() => {
    const baseUrl = getApiBaseUrl()
    if (!baseUrl) {
      return Promise.reject({
        code: 'API_NOT_CONFIGURED',
        message: '请先在 config/env.js 中配置 API 地址'
      })
    }
    if (apiUnavailableUntil > Date.now()) return Promise.reject(unavailableError())

    const token = session.getToken()
    if (!requestOptions.skipAuth && !token) {
      const app = getAppSafely()
      return Promise.reject({
        code: app && app.globalData && app.globalData.apiStatus === 'unavailable'
          ? 'NETWORK_ERROR'
          : 'AUTH_REQUIRED',
        message: app && app.globalData && app.globalData.apiStatus === 'unavailable'
          ? '服务器暂时不可用，请检查网络或 API 地址'
          : '登录状态已失效，请重新登录'
      })
    }

    const method = String(requestOptions.method || 'GET').toUpperCase()
    const data = requestOptions.data === undefined && method !== 'GET' && method !== 'HEAD'
      ? {}
      : requestOptions.data
    const header = Object.assign({
      'content-type': 'application/json'
    }, requestOptions.header || {})

    if (!requestOptions.skipAuth) {
      header.Authorization = `Bearer ${token}`
    }

    return new Promise((resolve, reject) => {
      let requestTask
      try {
        requestTask = wx.request({
          url: `${baseUrl}${requestOptions.url || ''}`,
          method,
          data,
          header,
          timeout: requestOptions.timeout || 10000,
          success(response) {
            if (response.statusCode >= 200 && response.statusCode < 300) {
              apiUnavailableUntil = 0
              resolve(response.data)
              return
            }

            if (response.statusCode === 401) clearAuthenticatedUser()

            const body = response.data && typeof response.data === 'object' ? response.data : {}
            reject(Object.assign({
              code: 'REQUEST_FAILED',
              message: response.statusCode >= 500 ? '服务器暂时不可用，请稍后重试' : '请求失败',
              statusCode: response.statusCode
            }, body))
          },
          fail(error) {
            // 短暂熔断，避免同一页面的并发请求重复报错；服务恢复后可快速重试。
            apiUnavailableUntil = Date.now() + 5 * 1000
            if (!requestOptions.skipAuth) {
              clearAuthenticatedUser(true)
            } else {
              const app = getAppSafely()
              if (app && app.globalData && app.globalData.apiConfigured) {
                app.globalData.apiStatus = 'unavailable'
              }
            }
            reject(Object.assign(unavailableError(), { cause: error }))
          }
        })
      } catch (error) {
        reject({
          code: 'REQUEST_ERROR',
          message: '请求无法发起，请稍后重试',
          cause: error
        })
      }
      return requestTask
    })
  })
}

request.download = function download(options) {
  const requestOptions = options || {}
  return waitForAppReady(requestOptions).then(() => {
    const baseUrl = getApiBaseUrl()
    if (!baseUrl) {
      return Promise.reject({ code: 'API_NOT_CONFIGURED', message: '请先在 config/env.js 中配置 API 地址' })
    }
    if (apiUnavailableUntil > Date.now()) return Promise.reject(unavailableError())
    const token = session.getToken()
    if (!token) {
      const app = getAppSafely()
      const unavailable = app && app.globalData && app.globalData.apiStatus === 'unavailable'
      return Promise.reject({
        code: unavailable ? 'NETWORK_ERROR' : 'AUTH_REQUIRED',
        message: unavailable ? '服务器暂时不可用，请检查网络或 API 地址' : '登录状态已失效，请重新登录'
      })
    }
    return new Promise((resolve, reject) => {
      try {
        wx.downloadFile({
          url: `${baseUrl}${requestOptions.url || ''}`,
          header: { Authorization: `Bearer ${token}` },
          timeout: requestOptions.timeout || 30000,
          success(response) {
            if (response.statusCode >= 200 && response.statusCode < 300 && response.tempFilePath) {
              apiUnavailableUntil = 0
              resolve(response.tempFilePath)
              return
            }
            if (response.statusCode === 401) clearAuthenticatedUser()
            reject({
              code: 'DOWNLOAD_FAILED',
              message: response.statusCode >= 500 ? '服务器暂时不可用，请稍后重试' : '请假单下载失败',
              statusCode: response.statusCode
            })
          },
          fail(error) {
            apiUnavailableUntil = Date.now() + 5 * 1000
            clearAuthenticatedUser(true)
            reject(Object.assign(unavailableError(), { cause: error }))
          }
        })
      } catch (error) {
        reject({ code: 'REQUEST_ERROR', message: '下载无法发起，请稍后重试', cause: error })
      }
    })
  })
}

module.exports = request
