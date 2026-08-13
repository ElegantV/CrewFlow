const request = require('./request')

module.exports = {
  list() {
    return request({ url: '/api/v1/overtime' })
  },
  balance() {
    return request({ url: '/api/v1/overtime/balance' })
  },
  create(data) {
    return request({ url: '/api/v1/overtime', method: 'POST', data })
  },
  revoke(id) {
    return request({ url: `/api/v1/overtime/${id}/revoke`, method: 'POST' })
  }
}

