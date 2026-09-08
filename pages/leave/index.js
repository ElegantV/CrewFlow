const leave = require('../../services/leave')
const me = require('../../services/me')
const calendarService = require('../../services/calendar')
const holidays = require('../../config/holidays')

function pad(value) { return String(value).padStart(2, '0') }
function today() {
  const date = new Date()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
function monthKey(date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}` }
function shiftMonth(month, offset) {
  const [year, value] = month.split('-').map(Number)
  return monthKey(new Date(year, value - 1 + offset, 1))
}

const statusLabels = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  cancelled: '已撤销'
}

const defaultLeaveType = {
  value: 'comp_time',
  label: '调休',
  minimumHours: 4,
  incrementHours: 4,
  fixedWorkdays: null,
  proofNotice: null
}

// 半天（4 小时）请假仅支持调休、公出、哺乳假三种类型。
function supportsHalfDay(type) {
  return !type || (type.minimumHours !== undefined ? type.minimumHours <= 4 : false)
}

// 多天请假的开始/结束时段规则：开始日只能全天或下午半天（上午半天不能作开始），
// 结束日只能上午半天或全天（下午半天不能作结束）。
const startPeriods = [
  { value: 'day', label: '全天' },
  { value: 'afternoon', label: '下午半天' }
]
const endPeriods = [
  { value: 'morning', label: '上午半天' },
  { value: 'day', label: '全天' }
]

function periodIndex(list, value) {
  const index = list.findIndex(item => item.value === value)
  return index >= 0 ? index : 0
}

function settled(promise) {
  return promise.then(value => ({ value }), error => ({ error }))
}

Page({
  data: {
    loading: true,
    submitting: false,
    showForm: false,
    showDatePicker: false,
    showResult: false,
    resultLoading: false,
    downloading: false,
    approvalResult: null,
    resultLeaveId: '',
    cancellingId: '',
    requests: [],
    types: [defaultLeaveType],
    typeIndex: 0,
    currentType: defaultLeaveType,
    halfDaySupported: true,
    profile: null,
    startPeriods,
    endPeriods,
    startPeriodIndex: 0,
    endPeriodIndex: 1,
    form: {
      leaveType: 'comp_time',
      startDate: '',
      endDate: '',
      startPeriod: 'day',
      endPeriod: 'day'
    },
    calMonth: '',
    calTitle: '',
    calCells: [],
    today: '',
    weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    rangeStart: '',
    rangeEnd: '',
    sameDayPeriod: 'day',
    rangeWorkdays: 0,
    leaveDays: 0
  },

  onLoad() {
    const currentMonth = monthKey(new Date())
    this.setData({
      calMonth: currentMonth,
      calTitle: this.monthTitle(currentMonth),
      today: today()
    })
    this.buildCalendar(currentMonth)
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true })
    const [listResult, typesResult, profileResult] = await Promise.all([
      settled(leave.list()),
      settled(leave.types()),
      settled(me.get())
    ])
    const updates = { loading: false }
    if (listResult.value) {
      updates.requests = listResult.value.requests.map(item => Object.assign({}, item, {
        statusLabel: statusLabels[item.status] || item.status,
        canCancel: item.status === 'pending' || item.status === 'approved',
        canViewResult: item.status === 'approved'
      }))
    }
    if (typesResult.value && typesResult.value.types && typesResult.value.types.length) {
      const types = typesResult.value.types
      updates.types = types
      updates.currentType = types.find(item => item.value === this.data.form.leaveType) || types[0]
      updates.typeIndex = Math.max(0, types.findIndex(item => item.value === updates.currentType.value))
      updates.halfDaySupported = supportsHalfDay(updates.currentType)
      if (!updates.halfDaySupported) {
        updates.sameDayPeriod = 'day'
        updates['form.startPeriod'] = 'day'
        updates['form.endPeriod'] = 'day'
        updates.startPeriodIndex = periodIndex(startPeriods, 'day')
        updates.endPeriodIndex = periodIndex(endPeriods, 'day')
      }
    }
    if (profileResult.value) updates.profile = profileResult.value
    this.setData(updates)

    const failed = listResult.error || typesResult.error || profileResult.error
    if (failed) {
      wx.showToast({ title: failed.message || '部分数据加载失败，请重试', icon: 'none' })
    }
  },

  openForm() {
    if (this.data.loading) {
      wx.showToast({ title: '数据加载中，请稍候', icon: 'none' })
      return
    }
    if (!this.data.profile) {
      wx.showToast({ title: '个人信息加载失败，正在重试', icon: 'none' })
      this.loadData()
      return
    }
    if (this.data.profile.personnelType !== 'bank' && !this.data.profile.agent) {
      wx.showModal({
        title: '请先设置代理人',
        content: '请假申请需要工作代理人，是否现在设置？',
        success: result => {
          if (result.confirm) wx.navigateTo({ url: '/pages/profile/index' })
        }
      })
      return
    }
    this.setData({ showForm: true })
    this.buildCalendar(this.data.calMonth || monthKey(new Date()))
  },

  openProfile() {
    wx.navigateTo({ url: '/pages/profile/index' })
  },

  openLedger() {
    wx.navigateTo({ url: '/pages/ledger/index' })
  },

  closeForm() {
    if (!this.data.submitting) this.setData({ showForm: false })
  },

  monthTitle(month) {
    const [year, value] = month.split('-').map(Number)
    return `${year}年${value}月`
  },

  buildCalendar(month) {
    const [year, value] = month.split('-').map(Number)
    const first = new Date(year, value - 1, 1)
    const offset = (first.getDay() + 6) % 7
    const daysInMonth = new Date(year, value, 0).getDate()
    const cells = []
    for (let index = 0; index < offset; index += 1) {
      cells.push({ key: `${month}-empty-${index}`, empty: true })
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${month}-${pad(day)}`
      cells.push({
        key: date,
        date,
        day,
        empty: false,
        isToday: date === this.data.today,
        isHoliday: !holidays.isWorkday(date),
        rangeStart: date === this.data.rangeStart,
        rangeEnd: date === this.data.rangeEnd,
        inRange: this.inRange(date)
      })
    }
    while (cells.length % 7 !== 0) {
      cells.push({ key: `${month}-empty-end-${cells.length}`, empty: true })
    }
    this.setData({ calCells: cells, calMonth: month, calTitle: this.monthTitle(month) })
    // 日历数据晚于首屏到达时(服务端按年加载),拉取成功后仅重渲染一次当前月份。
    calendarService.ensureYear(month.slice(0, 4))
      .then(outcome => {
        if (outcome.loaded && this.data.calMonth === month) this.buildCalendar(month)
      })
      .catch(() => {})
  },

  inRange(date) {
    const { rangeStart, rangeEnd } = this.data
    if (!rangeStart || !rangeEnd) return false
    const min = rangeStart < rangeEnd ? rangeStart : rangeEnd
    const max = rangeStart < rangeEnd ? rangeEnd : rangeStart
    return date > min && date < max
  },

  onCalendarTap(event) {
    const date = event.currentTarget.dataset.date
    if (!date) return
    const fixed = this.data.currentType && this.data.currentType.fixedWorkdays
    let rangeStart, rangeEnd, startDate, endDate
    if (fixed) {
      rangeStart = date
      rangeEnd = ''
      startDate = date
      endDate = date
    } else {
      const { rangeStart: rs, rangeEnd: re } = this.data
      if (!rs) {
        rangeStart = date
        rangeEnd = ''
        startDate = date
        endDate = date
      } else if (!re) {
        rangeStart = date < rs ? date : rs
        rangeEnd = date < rs ? rs : date
        startDate = rangeStart
        endDate = rangeEnd
      } else {
        rangeStart = date
        rangeEnd = ''
        startDate = date
        endDate = date
      }
    }
    this.setData({
      rangeStart,
      rangeEnd,
      'form.startDate': startDate,
      'form.endDate': endDate
    })
    this.refreshRange()
    // 选择完成后自动收起日期选择器：固定工作日类型选开始日期即完成，其余选完开始+结束即完成。
    if (fixed || (rangeStart && rangeEnd)) {
      this.setData({ showDatePicker: false })
    }
  },

  openDatePicker() {
    this.setData({ showDatePicker: true })
    this.buildCalendar(this.data.calMonth || monthKey(new Date()))
  },

  closeDatePicker() {
    this.setData({ showDatePicker: false })
  },

  clearDateRange() {
    this.setData({
      rangeStart: '',
      rangeEnd: '',
      rangeWorkdays: 0,
      leaveDays: 0,
      'form.startDate': '',
      'form.endDate': '',
      'form.startPeriod': 'day',
      'form.endPeriod': 'day',
      startPeriodIndex: periodIndex(startPeriods, 'day'),
      endPeriodIndex: periodIndex(endPeriods, 'day')
    })
    this.buildCalendar(this.data.calMonth)
  },

  refreshRange() {
    const { rangeStart, rangeEnd, form } = this.data
    let rangeWorkdays = 0
    let leaveDays = 0
    let startPeriod = form.startPeriod
    let endPeriod = form.endPeriod
    if (rangeStart && rangeEnd) {
      const sameDay = rangeStart === rangeEnd
      rangeWorkdays = sameDay ? 1 : holidays.countWorkdays(rangeStart, rangeEnd)
      if (sameDay) {
        // 单日以整天为基数，时长由下方的请假时长（请一天/上午/下午）决定。
        if (this.data.sameDayPeriod) {
          startPeriod = this.data.sameDayPeriod
          endPeriod = this.data.sameDayPeriod
        }
        leaveDays = 1
      } else {
        // 多天默认全天，避免残留单日的上/下午时段导致小时数计算错误。
        startPeriod = 'day'
        endPeriod = 'day'
        // 多天实际请假天数 = 范围内工作日 − 边界日未休的半天。
        leaveDays = rangeWorkdays
        if (startPeriod === 'morning' || startPeriod === 'afternoon') leaveDays -= 0.5
        if (endPeriod === 'morning' || endPeriod === 'afternoon') leaveDays -= 0.5
      }
      this.setData({
        'form.startPeriod': startPeriod,
        'form.endPeriod': endPeriod,
        startPeriodIndex: periodIndex(startPeriods, startPeriod),
        endPeriodIndex: periodIndex(endPeriods, endPeriod),
        rangeWorkdays,
        leaveDays
      })
    } else {
      this.setData({ rangeWorkdays, leaveDays })
    }
    this.buildCalendar(this.data.calMonth)
  },

  prevMonth() {
    this.buildCalendar(shiftMonth(this.data.calMonth, -1))
  },

  nextMonth() {
    this.buildCalendar(shiftMonth(this.data.calMonth, 1))
  },

  onSameDayPeriod(event) {
    const value = event.currentTarget.dataset.value
    this.setData({
      sameDayPeriod: value,
      'form.startPeriod': value,
      'form.endPeriod': value
    })
  },

  onTypeChange(event) {
    const typeIndex = Number(event.detail.value)
    const currentType = this.data.types[typeIndex]
    const halfDaySupported = supportsHalfDay(currentType)
    const updates = {
      typeIndex,
      currentType,
      halfDaySupported,
      'form.leaveType': currentType.value
    }
    if (!halfDaySupported) {
      // 不支持半天的类型强制全天，避免残留上/下午时段被提交后由服务端拒绝。
      updates.sameDayPeriod = 'day'
      updates['form.startPeriod'] = 'day'
      updates['form.endPeriod'] = 'day'
      updates.startPeriodIndex = periodIndex(startPeriods, 'day')
      updates.endPeriodIndex = periodIndex(endPeriods, 'day')
    }
    this.setData(updates)
    if (currentType.fixedWorkdays) {
      this.setData({ rangeEnd: '', 'form.endDate': '' })
      this.buildCalendar(this.data.calMonth)
    }
  },

  onStartPeriodChange(event) {
    const index = Number(event.detail.value)
    this.setData({ startPeriodIndex: index, 'form.startPeriod': this.data.startPeriods[index].value })
    this.recomputeLeaveDays()
  },

  onEndPeriodChange(event) {
    const index = Number(event.detail.value)
    this.setData({ endPeriodIndex: index, 'form.endPeriod': this.data.endPeriods[index].value })
    this.recomputeLeaveDays()
  },

  recomputeLeaveDays() {
    const { rangeStart, rangeEnd, form } = this.data
    if (!rangeStart || !rangeEnd || rangeStart === rangeEnd) return
    let leaveDays = holidays.countWorkdays(rangeStart, rangeEnd)
    if (form.startPeriod === 'morning' || form.startPeriod === 'afternoon') leaveDays -= 0.5
    if (form.endPeriod === 'morning' || form.endPeriod === 'afternoon') leaveDays -= 0.5
    this.setData({ leaveDays })
  },

  async submit() {
    const form = this.data.form
    const fixedWorkdays = this.data.currentType && this.data.currentType.fixedWorkdays
    if (!form.startDate || !form.endDate) {
      wx.showToast({ title: '请选择请假日期', icon: 'none' })
      return
    }
    if (!fixedWorkdays && form.endDate < form.startDate) {
      wx.showToast({ title: '结束日期不能早于开始日期', icon: 'none' })
      return
    }
    if (!fixedWorkdays && form.startDate === form.endDate) {
      if (form.startPeriod === 'afternoon' && form.endPeriod === 'morning') {
        wx.showToast({ title: '同一天结束时段不能早于开始时段', icon: 'none', duration: 3000 })
        return
      }
      const usesDay = form.startPeriod === 'day' || form.endPeriod === 'day'
      if (usesDay && form.startPeriod !== form.endPeriod) {
        wx.showToast({ title: '同一天选择全天时，开始和结束都须选全天', icon: 'none', duration: 3000 })
        return
      }
    }
    this.setData({ submitting: true })
    try {
      const result = await leave.create(this.data.form)
      this.setData({ showForm: false, submitting: false })
      this.clearDateRange()
      wx.showToast({ title: `已提交${result.requestedDays}天`, icon: 'success' })
      if (result.warnings && result.warnings.length) {
        wx.showModal({
          title: '值班时间冲突提醒',
          content: result.warnings.map(item => item.message).join('\n'),
          showCancel: false
        })
      }
      await this.loadData()
    } catch (error) {
      this.setData({ submitting: false })
      wx.showToast({ title: error.message || '提交失败', icon: 'none', duration: 3000 })
    }
  },

  async openApprovalResult(event) {
    const id = event.currentTarget.dataset.id
    this.setData({ showResult: true, resultLoading: true, approvalResult: null, resultLeaveId: id })
    try {
      const response = await leave.approvalResult(id)
      this.setData({ approvalResult: response.result, resultLoading: false })
    } catch (error) {
      this.setData({ showResult: false, resultLoading: false })
      wx.showToast({ title: error.message || '审批结果加载失败', icon: 'none' })
    }
  },

  closeResult() {
    if (!this.data.downloading) this.setData({ showResult: false })
  },

  copyApprovalResult() {
    if (!this.data.approvalResult) return
    wx.setClipboardData({
      data: this.data.approvalResult.text,
      success: () => wx.showToast({ title: '审批内容已复制', icon: 'success' })
    })
  },

  async downloadApprovalPdf() {
    if (!this.data.resultLeaveId || this.data.downloading) return
    this.setData({ downloading: true })
    try {
      const filePath = await leave.downloadPdf(this.data.resultLeaveId)
      this.setData({ downloading: false })
      wx.openDocument({
        filePath,
        fileType: 'pdf',
        showMenu: true,
        fail: () => wx.showToast({ title: 'PDF 已下载，但打开失败', icon: 'none' })
      })
    } catch (error) {
      this.setData({ downloading: false })
      wx.showToast({ title: error.message || '下载失败', icon: 'none' })
    }
  },

  cancel(event) {
    const id = event.currentTarget.dataset.id
    if (!id || this.data.cancellingId === id) return
    wx.showModal({
      title: '撤销申请',
      content: '调休额度将按原加班记录和原到期日退回，是否继续？',
      success: async result => {
        if (!result.confirm) return
        this.setData({ cancellingId: id })
        try {
          await leave.cancel(id)
          const requests = this.data.requests.map(item => item.id === id
            ? Object.assign({}, item, { status: 'cancelled', statusLabel: statusLabels.cancelled, canCancel: false, canViewResult: false })
            : item)
          this.setData({ requests })
          wx.showToast({ title: '申请已撤销', icon: 'success' })
          await this.loadData()
        } catch (error) {
          wx.showToast({ title: error.message || '撤销失败', icon: 'none' })
        } finally {
          this.setData({ cancellingId: '' })
        }
      }
    })
  },

  noop() {}
})
