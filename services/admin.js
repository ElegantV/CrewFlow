const request = require('./request')

module.exports = {
  users() {
    return request({ url: '/api/v1/admin/users' })
  },
  updateUser(id, data) {
    return request({ url: `/api/v1/admin/users/${id}`, method: 'PUT', data })
  },
  downloadRecords(start, end, userId) {
    const params = [`start=${start}`, `end=${end}`]
    if (userId) params.push(`userId=${userId}`)
    return request.download({
      url: `/api/v1/admin/records/export?${params.join('&')}`,
      timeout: 60000
    })
  }
}

