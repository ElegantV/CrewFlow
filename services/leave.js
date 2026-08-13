const request = require('./request')

module.exports = {
  list() {
    return request({ url: '/api/v1/leaves' })
  },
  types() {
    return request({ url: '/api/v1/leaves/types' })
  },
  create(data) {
    return request({ url: '/api/v1/leaves', method: 'POST', data })
  },
  cancel(id) {
    return request({ url: `/api/v1/leaves/${id}/cancel`, method: 'POST' })
  },
  approvalResult(id) {
    return request({ url: `/api/v1/leaves/${id}/approval-result` })
  },
  downloadPdf(id) {
    return request.download({ url: `/api/v1/leaves/${id}/pdf`, timeout: 30000 })
  }
}
