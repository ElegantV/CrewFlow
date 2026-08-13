const request = require('./request')

module.exports = {
  month(month) {
    return request({ url: `/api/v1/situation?month=${encodeURIComponent(month)}` })
  },
  range(startMonth, endMonth) {
    return request({ url: `/api/v1/situation?startMonth=${encodeURIComponent(startMonth)}&endMonth=${encodeURIComponent(endMonth)}` })
  }
}
