const request = require('./request')

module.exports = {
  users() {
    return request({ url: '/api/v1/admin/users' })
  },
  updateUser(id, data) {
    return request({ url: `/api/v1/admin/users/${id}`, method: 'PUT', data })
  },
  downloadRecords(start, end) {
    return request.download({
      url: `/api/v1/admin/records/export?start=${start}&end=${end}`,
      timeout: 60000
    })
  }
}

