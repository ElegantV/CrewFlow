const overtime = require('../../services/overtime')

function today() {
  const date = new Date()
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

Page({
  data: {
    loading: true,
    submitting: false,
    showForm: false,
    availableHours: 0,
    nearestExpiry: null,
    records: [],
    maxDate: '',
    form: {
      date: '',
      hours: '2',
      content: ''
    }
  },

  onLoad() {
    const date = today()
    this.setData({ maxDate: date, 'form.date': date })
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true })
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
      this.setData({ loading: false })
      wx.showToast({ title: error.message || '加载失败', icon: 'none' })
    }
  },

  openForm() {
    this.setData({ showForm: true })
  },

  closeForm() {
    if (!this.data.submitting) this.setData({ showForm: false })
  },

  onDateChange(event) {
    this.setData({ 'form.date': event.detail.value })
  },

  onHoursInput(event) {
    this.data.form.hours = event.detail.value
  },

  onContentInput(event) {
    this.data.form.content = event.detail.value
  },

  async submit() {
    const hours = Number(this.data.form.hours)
    if (!Number.isInteger(hours) || hours < 2 || hours > 6) {
      wx.showToast({ title: '加班时长须为2至6个整小时', icon: 'none' })
      return
    }
    if (!this.data.form.content.trim()) {
      wx.showToast({ title: '请填写加班工作内容', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      await overtime.create(Object.assign({}, this.data.form, { hours }))
      this.setData({
        showForm: false,
        submitting: false,
        'form.hours': '2',
        'form.content': ''
      })
      wx.showToast({ title: '加班已登记', icon: 'success' })
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
