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
    calMonth: '',
    calTitle: '',
    calCells: [],
    weekdays: ['一', '二', '三', '四', '五', '六', '日'],
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
      // 头像按人去重返回(people),行上只带 personId,这里回填成 wxml 直接可用的 avatar 字段。
      const avatarById = {}
      ;(result.people || []).forEach(person => { avatarById[person.id] = person.avatar || '' })
      const decorate = item => Object.assign({}, item, { avatar: avatarById[item.personId] || '' })
      const allLeaves = (result.leaves || []).map(decorate)
      const allOvertime = (result.overtime || []).map(decorate)
      this.setData({
        dayMap,
        allLeaves,
        allOvertime,
        leaves: allLeaves.filter(item => item.date === selectedDate),
        overtime: allOvertime.filter(item => item.date === selectedDate),
        selectedDate,
        loading: false
      })
      this.buildCalendar(selectedDate.slice(0, 7))
    } catch (error) {
      this.setData({ loading: false, error: error.message || '员工情况加载失败' })
    }
  },

  buildCalendar(month) {
    if (!month) return
    const [year, value] = month.split('-').map(Number)
    const first = new Date(year, value - 1, 1)
    const offset = (first.getDay() + 6) % 7
    const daysInMonth = new Date(year, value, 0).getDate()
    const cells = []
    for (let index = 0; index < offset; index += 1) {
      cells.push({ key: `${month}-empty-start-${index}`, empty: true })
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = `${month}-${pad(day)}`
      const item = this.data.dayMap[key] || { leaveCount: 0, overtimeCount: 0 }
      cells.push({
        key,
        date: key,
        day,
        empty: false,
        isToday: key === this.data.today,
        selected: key === this.data.selectedDate,
        leaveCount: item.leaveCount || 0,
        overtimeCount: item.overtimeCount || 0,
        hasActivity: Boolean(item.leaveCount || item.overtimeCount)
      })
    }
    while (cells.length % 7 !== 0) cells.push({ key: `${month}-empty-end-${cells.length}`, empty: true })
    this.setData({ calCells: cells, calMonth: month, calTitle: `${year}年${value}月` })
  },

  prevMonth() {
    if (!this.data.calMonth) return
    const month = shiftMonth(this.data.calMonth, -1)
    if (month < this.data.rangeStart) return
    this.buildCalendar(month)
  },

  nextMonth() {
    if (!this.data.calMonth) return
    const month = shiftMonth(this.data.calMonth, 1)
    if (month > this.data.rangeEnd) return
    this.buildCalendar(month)
  },

  selectDate(event) {
    const date = event.currentTarget.dataset.date
    if (!date) return
    this.selectDateValue(date)
  },

  selectDateValue(date) {
    this.setData({
      selectedDate: date,
      leaves: this.data.allLeaves.filter(item => item.date === date),
      overtime: this.data.allOvertime.filter(item => item.date === date)
    })
    this.buildCalendar(this.data.calMonth)
  },

  goToday() {
    this.setData({ calMonth: this.data.today.slice(0, 7) })
    this.selectDateValue(this.data.today)
  },

  retry() {
    this.loadRange(this.data.rangeStart, this.data.rangeEnd, this.data.selectedDate)
  }
})