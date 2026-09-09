const overtime = require('../../services/overtime')

function today() {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function daysAgo(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const statusLabels = {
  active: '可用',
  consumed: '已用完',
  revoked: '已撤销',
  expired: '已到期'
}

function minutes(time) {
  const [hour = 0, minute = 0] = String(time).split(':').map(Number)
  return hour * 60 + minute
}

Page({
  data: {
    loading: true,
    submitting: false,
    showForm: false,
    availableHours: 0,
    nearestExpiry: null,
    records: [],
    maxDate: '',
    minDate: '',
    loadError: '',
    timeSummary: '',
    timeSummaryDanger: false,
    form: {
      date: '',
      startTime: '17:30',
      endTime: '19:30',
      content: ''
    }
  },

  onLoad() {
    const date = today()
    this.setData({ maxDate: date, minDate: daysAgo(90), 'form.date': date })
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true, loadError: '' })
    try {
      const [list, balance] = await Promise.all([overtime.list(), overtime.balance()])
      this.setData({
        records: list.records.map(item => Object.assign({}, item, {
          statusLabel: statusLabels[item.status] || item.status
        })),
        availableHours: balance.availableHours,
        nearestExpiry: balance.nearestExpiry,
        loading: false
      })
    } catch (error) {
      this.setData({ loading: false, loadError: error.message || '加载失败，请重试' })
    }
  },

  openForm() {
    this.setData({ showForm: true })
    this.updateTimeSummary()
  },

  closeForm() {
    if (!this.data.submitting) this.setData({ showForm: false })
  },

  onDateChange(event) {
    this.setData({ 'form.date': event.detail.value })
  },

  onStartTimeChange(event) {
    this.setData({ 'form.startTime': event.detail.value }, () => this.updateTimeSummary())
  },

  onEndTimeChange(event) {
    this.setData({ 'form.endTime': event.detail.value }, () => this.updateTimeSummary())
  },

  // 根据开始/结束时间实时预览可登记的小时数(向下取整为已满的整小时)。
  updateTimeSummary() {
    const form = this.data.form
    const startMinutes = minutes(form.startTime)
    const rawEnd = minutes(form.endTime)
    const endMinutes = rawEnd <= startMinutes ? rawEnd + 1440 : rawEnd
    const duration = endMinutes - startMinutes
    const hours = Math.floor(duration / 60)
    if (hours < 2) {
      this.setData({ timeSummary: `本次时长约${Math.max(hours, 0)}小时，不足2小时，无法登记`, timeSummaryDanger: true })
    } else if (hours > 6) {
      this.setData({ timeSummary: '本次时长超过6小时，请缩短结束时间', timeSummaryDanger: true })
    } else {
      this.setData({ timeSummary: `本次将登记 ${hours} 小时`, timeSummaryDanger: false })
    }
  },

  onContentInput(event) {
    this.data.form.content = event.detail.value
  },

  async submit() {
    const form = this.data.form
    const startMinutes = minutes(form.startTime)
    const rawEnd = minutes(form.endTime)
    // 结束早于开始时视为跨零点（次日结束）；时长按已满的整小时向下取整。
    const endMinutes = rawEnd <= startMinutes ? rawEnd + 1440 : rawEnd
    const duration = endMinutes - startMinutes
    const hours = Math.floor(duration / 60)
    if (hours < 2) {
      wx.showToast({ title: `本次时长约${Math.max(hours, 0)}小时，不足2小时，无法登记`, icon: 'none' })
      return
    }
    if (hours > 6) {
      wx.showToast({ title: '本次时长超过6小时，无法登记', icon: 'none' })
      return
    }
    if (!form.content.trim()) {
      wx.showToast({ title: '请填写加班工作内容', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      await overtime.create({
        date: form.date,
        startTime: form.startTime,
        endTime: form.endTime,
        content: form.content.trim()
      })
      this.setData({
        showForm: false,
        submitting: false,
        'form.startTime': '17:30',
        'form.endTime': '19:30',
        'form.content': ''
      })
      this.updateTimeSummary()
      wx.showToast({ title: `加班已登记（${hours}小时）`, icon: 'success' })
      await this.loadData()
    } catch (error) {
      this.setData({ submitting: false })
      wx.showToast({ title: error.message || '提交失败', icon: 'none' })
    }
  },

  openLedger() {
    wx.navigateTo({ url: '/pages/ledger/index' })
  },

  revoke(event) {
    const id = event.currentTarget.dataset.id
    wx.showModal({
      title: '撤销加班',
      content: '撤销后将移除对应调休额度，是否继续？',
      success: async result => {
        if (!result.confirm) return
        try {
          await overtime.revoke(id)
          wx.showToast({ title: '已撤销', icon: 'success' })
          await this.loadData()
        } catch (error) {
          wx.showToast({ title: error.message || '撤销失败', icon: 'none' })
        }
      }
    })
  },

  noop() {}
})
