const request = require('./request')

module.exports = {
  get() {
    return request({ url: '/api/v1/me' })
  },
  people() {
    return request({ url: '/api/v1/me/people' })
  },
  saveProfile(data) {
    return request({ url: '/api/v1/me/profile', method: 'PUT', data })
  },
  setAvatar(imageData) {
    return request({ url: '/api/v1/me/avatar', method: 'PUT', data: { imageData }, timeout: 30000 })
  },
  setAgent(agentUserId) {
    return request({ url: '/api/v1/me/agent', method: 'PUT', data: { agentUserId } })
  },
  setSignature(imageData) {
    return request({ url: '/api/v1/me/signature', method: 'PUT', data: { imageData }, timeout: 30000 })
  },
  dashboard() {
    return request({ url: '/api/v1/me/dashboard' })
  },
  ledger(month) {
    return request({ url: `/api/v1/me/ledger?month=${encodeURIComponent(month)}` })
  }
}
