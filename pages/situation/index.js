const situation = require('../../services/situation')

function pad(value) { return String(value).padStart(2, '0') }
function monthKey(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}` }
function dateKey(date) { return `${monthKey(date)}-${pad(date.getDate())}` }
function shiftMonth(month, offset) {
  const [year, value] = month.split('-').map(Number)
  return monthKey(new Date(year, value - 1 + offset, 1))
}

Page({
  data: {
    today: '',
    selectedDate: '',
    rangeStart: '',
    rangeEnd: '',
    scrollIntoView: '',
    weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    months: [],
    dayMap: {},
    allLeaves: [],
    allOvertime: [],
    leaves: [],
    overtime: [],
    loading: true,
    error: ''
  },

  onLoad() {
    const now = new Date()
    const today = dateKey(now)
    const currentMonth = monthKey(now)
    const rangeStart = shiftMonth(currentMonth, -6)
    const rangeEnd = shiftMonth(currentMonth, 12)
    this.setData({ today, selectedDate: today, rangeStart, rangeEnd })
    this.loadRange(rangeStart, rangeEnd, today)
  },

  async loadRange(rangeStart, rangeEnd, selectedDate) {
    this.setData({ loading: true, error: '' })
    try {
      const result = await situation.range(rangeStart, rangeEnd)
      const dayMap = {}
      ;(result.days || []).forEach(item => { dayMap[item.date] = item })
      const months = this.buildMonths(rangeStart, rangeEnd, dayMap, selectedDate)
      this.setData({
        dayMap,
        months,
        allLeaves: result.leaves || [],
        allOvertime: result.overtime || [],
        leaves: (result.leaves || []).filter(item => item.date === selectedDate),
        overtime: (result.overtime || []).filter(item => item.date === selectedDate),
        selectedDate,
        scrollIntoView: `month-${selectedDate.slice(0, 7)}`,
        loading: false
      })
      setTimeout(() => this.setData({ scrollIntoView: '' }), 500)
    } catch (error) {
      this.setData({ loading: false, error: error.message || '员工情况加载失败' })
    }
  },

  buildMonths(rangeStart, rangeEnd, dayMap, selectedDate) {
    const months = []
    let current = rangeStart
    while (current <= rangeEnd) {
      const [year, month] = current.split('-').map(Number)
      const first = new Date(year, month - 1, 1)
      const offset = (first.getDay() + 6) % 7
      const daysInMonth = new Date(year, month, 0).getDate()
      const cells = []
      for (let index = 0; index < offset; index += 1) {
        cells.push({ key: `${current}-empty-start-${index}`, empty: true })
      }
      for (let day = 1; day <= daysInMonth; day += 1) {
        const key = `${current}-${pad(day)}`
        const item = dayMap[key] || { leaveCount: 0, overtimeCount: 0 }
        cells.push({
          key,
          date: key,
          day,
          empty: false,
          isToday: key === this.data.today,
          selected: key === selectedDate,
          leaveCount: item.leaveCount || 0,
          overtimeCount: item.overtimeCount || 0,
          hasActivity: Boolean(item.leaveCount || item.overtimeCount)
        })
      }
      while (cells.length % 7 !== 0) cells.push({ key: `${current}-empty-end-${cells.length}`, empty: true })
      months.push({ key: current, id: `month-${current}`, label: `${year}年${month}月`, cells })
      current = shiftMonth(current, 1)
    }
    return months
  },

  selectDate(event) {
    const date = event.currentTarget.dataset.date
    if (!date) return
    this.selectDateValue(date, false)
  },

  selectDateValue(date, shouldScroll) {
    const months = this.data.months.map(month => Object.assign({}, month, {
      cells: month.cells.map(item => item.empty ? item : Object.assign({}, item, { selected: item.date === date }))
    }))
    this.setData({
      selectedDate: date,
      months,
      leaves: this.data.allLeaves.filter(item => item.date === date),
      overtime: this.data.allOvertime.filter(item => item.date === date),
      scrollIntoView: shouldScroll ? `month-${date.slice(0, 7)}` : ''
    })
    if (shouldScroll) setTimeout(() => this.setData({ scrollIntoView: '' }), 500)
  },

  goToday() {
    this.selectDateValue(this.data.today, true)
  },

  retry() {
    this.loadRange(this.data.rangeStart, this.data.rangeEnd, this.data.selectedDate)
  }
})
