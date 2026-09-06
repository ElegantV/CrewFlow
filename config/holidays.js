// 2026 年法定节假日与调休上班日，来源：国务院办公厅 国办发明电〔2025〕7号。
// 此静态表仅作离线兜底；启动后以服务端 /api/v1/calendar 同步的数据为准
// （服务端数据源为 holiday-cn，管理员可在后台手工覆盖），无需每年改代码。

const STATUTORY_HOLIDAYS = [
  '2026-01-01', '2026-01-02', '2026-01-03', // 元旦
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', // 春节
  '2026-04-04', '2026-04-05', '2026-04-06', // 清明
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
  '2026-06-19', '2026-06-20', '2026-06-21', // 端午
  '2026-09-25', '2026-09-26', '2026-09-27', // 中秋
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07' // 国庆
]

const MAKEUP_WORKDAYS = [
  '2026-01-04', // 周日
  '2026-02-14', // 周六
  '2026-02-28', // 周六
  '2026-05-09', // 周六
  '2026-09-20', // 周日
  '2026-10-10' // 周六
]

const holidaySet = new Set(STATUTORY_HOLIDAYS)
const makeupSet = new Set(MAKEUP_WORKDAYS)

function parse(value) {
  const parts = String(value).split('-').map(Number)
  return new Date(parts[0], parts[1] - 1, parts[2])
}

function key(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function isWeekend(date) {
  const day = date.getDay()
  return day === 0 || day === 6
}

// 是否为工作日：调休上班日算工作日；法定节假日不算；其余周一至周五算工作日。
function isWorkday(dateStr) {
  const date = parse(dateStr)
  if (makeupSet.has(dateStr)) return true
  if (holidaySet.has(dateStr)) return false
  return !isWeekend(date)
}

// 计算 [start, end] 区间内的工作日数量（已扣除周末和法定节假日）。
function countWorkdays(start, end) {
  const from = parse(start)
  const to = parse(end)
  let total = 0
  const cursor = new Date(from)
  while (cursor <= to) {
    if (isWorkday(key(cursor))) total += 1
    cursor.setDate(cursor.getDate() + 1)
  }
  return total
}

// 应用服务端日历数据：服务端优先级高于静态兜底（同一日期覆盖归类）。
// days 结构：[{ date: 'YYYY-MM-DD', dayType: 'holiday' | 'makeup' }]
function applyServerCalendar(days) {
  if (!Array.isArray(days)) return
  for (const day of days) {
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue
    if (day.dayType === 'holiday') {
      holidaySet.add(day.date)
      makeupSet.delete(day.date)
    } else if (day.dayType === 'makeup') {
      makeupSet.add(day.date)
      holidaySet.delete(day.date)
    }
  }
}

module.exports = { countWorkdays, isWorkday, isWeekend, applyServerCalendar, STATUTORY_HOLIDAYS, MAKEUP_WORKDAYS }
