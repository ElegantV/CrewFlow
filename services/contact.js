const request = require('./request')

module.exports = {
  list() {
    return request({ url: '/api/v1/contacts' })
  }
}
