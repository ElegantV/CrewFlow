const request = require('./request')

module.exports = {
  users() {
    return request({ url: '/api/v1/admin/users' })
  },
  updateUser(id, data) {
    return request({ url: `/api/v1/admin/users/${id}`, method: 'PUT', data })
  }
}

