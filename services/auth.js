const request = require('./request')
const session = require('../utils/session')

function getLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(result) {
        if (result.code) {
          resolve(result.code)
        } else {
          reject({ code: 'WX_LOGIN_FAILED', message: '未获取到微信登录凭证' })
        }
      },
      fail(error) {
        reject({ code: 'WX_LOGIN_FAILED', message: '微信登录失败', cause: error })
      }
    })
  })
}

async function login() {
  const code = await getLoginCode()
  const result = await request({
    url: '/api/v1/auth/wechat',
    method: 'POST',
    data: { code },
    skipAuth: true
  })
  return session.saveSession(result)
}

async function restoreOrLogin() {
  return session.getSession() || login()
}

function listDevUsers() {
  return request({ url: '/api/v1/auth/dev/users', skipAuth: true })
}

async function devLogin(userId) {
  const result = await request({
    url: '/api/v1/auth/dev',
    method: 'POST',
    data: { userId },
    skipAuth: true
  })
  return session.saveSession(result)
}

async function restoreWechatLogin() {
  session.clearSession()
  return login()
}

module.exports = {
  devLogin,
  login,
  listDevUsers,
  restoreOrLogin,
  restoreWechatLogin
}
