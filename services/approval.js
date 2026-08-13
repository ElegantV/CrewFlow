const request = require('./request')

module.exports = {
  pending() {
    return request({ url: '/api/v1/approvals/pending' })
  },
  history() {
    return request({ url: '/api/v1/approvals/history' })
  },
  decide(id, action, comment) {
    return request({
      url: `/api/v1/approvals/${id}/decision`,
      method: 'POST',
      data: { action, comment }
    })
  }
}
