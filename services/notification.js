const request = require('./request')

module.exports = {
  config() {
    return request({ url: '/api/v1/notifications/config' })
  },
  subscribe(templateId) {
    return request({ url: '/api/v1/notifications/subscribe', method: 'POST', data: { templateId } })
  }
}
