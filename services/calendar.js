// 节假日历加载器：按年从服务端拉取法定假与调休补班日并应用到 holidays 静态兜底上。
// 加载失败不影响使用——保留静态表，未覆盖的日期按周一至周五规则判定。
const request = require('./request')
const holidays = require('../config/holidays')

const loadedYears = new Set()

function loadYear(year) {
  return request({ url: `/api/v1/calendar?year=${encodeURIComponent(year)}` }).then(result => {
    if (result && Array.isArray(result.days)) holidays.applyServerCalendar(result.days)
  })
}

// 幂等加载指定年份；outcome.loaded 表示本次是否发生了真实拉取，
// 调用方据此决定是否重渲染日历，避免加载完成后的重复刷新循环。
function ensureYear(year) {
  const key = String(year)
  if (loadedYears.has(key)) return Promise.resolve({ loaded: false })
  loadedYears.add(key)
  return loadYear(key)
    .then(() => ({ loaded: true }))
    .catch(error => {
      loadedYears.delete(key)
      throw error
    })
}

module.exports = { ensureYear }
