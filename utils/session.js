const TOKEN_KEY = 'crewflow_token'
const USER_KEY = 'crewflow_user'
const EXPIRES_AT_KEY = 'crewflow_token_expires_at'

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || ''
}

function getUser() {
  return wx.getStorageSync(USER_KEY) || null
}

function getSession() {
  const token = getToken()
  const user = getUser()
  const expiresAt = Number(wx.getStorageSync(EXPIRES_AT_KEY) || 0)

  if (!token || !user || expiresAt <= Date.now() + 60 * 1000) {
    return null
  }

  return { token, user, expiresAt }
}

function saveSession({ token, user, expiresIn }) {
  const expiresAt = Date.now() + Number(expiresIn) * 1000
  wx.setStorageSync(TOKEN_KEY, token)
  wx.setStorageSync(USER_KEY, user)
  wx.setStorageSync(EXPIRES_AT_KEY, expiresAt)
  return { token, user, expiresAt }
}

function clearSession() {
  wx.removeStorageSync(TOKEN_KEY)
  wx.removeStorageSync(USER_KEY)
  wx.removeStorageSync(EXPIRES_AT_KEY)
}

module.exports = {
  clearSession,
  getSession,
  getToken,
  saveSession
}

