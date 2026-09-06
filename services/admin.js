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
  },
  getAiConfig() {
    return request({ url: '/api/v1/admin/ai-config' })
  },
  saveAiConfig(data) {
    return request({ url: '/api/v1/admin/ai-config', method: 'PUT', data })
  },
  calendarDays(year) {
    return request({ url: `/api/v1/admin/calendar?year=${encodeURIComponent(year)}` })
  },
  saveCalendarDay(data) {
    return request({ url: '/api/v1/admin/calendar/day', method: 'PUT', data })
  },
  deleteCalendarDay(date) {
    return request({ url: `/api/v1/admin/calendar/day?date=${encodeURIComponent(date)}`, method: 'DELETE' })
  },
  syncCalendar() {
    return request({ url: '/api/v1/admin/calendar/sync', method: 'POST', timeout: 30000 })
  }
}

