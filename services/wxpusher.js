const request = require('./request')

module.exports = {
  status() {
    return request({ url: '/api/v1/wxpusher/status' })
  },
  getQr() {
    return request({ url: '/api/v1/wxpusher/qr', method: 'POST' })
  },
  check() {
    return request({ url: '/api/v1/wxpusher/check', method: 'POST' })
  },
  unbind() {
    return request({ url: '/api/v1/wxpusher/unbind', method: 'POST' })
  },
  test() {
    return request({ url: '/api/v1/wxpusher/test', method: 'POST' })
  }
}
