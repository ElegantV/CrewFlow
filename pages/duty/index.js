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

const HOURS_OPTIONS = [2, 3, 4, 5, 6]

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
    hoursOptions: HOURS_OPTIONS,
    form: {
      date: '',
      offTime: '18:00',
      hoursIndex: 0,
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
  },

  closeForm() {
    if (!this.data.submitting) this.setData({ showForm: false })
  },

  onDateChange(event) {
    this.setData({ 'form.date': event.detail.value })
  },

  onOffTimeChange(event) {
    this.setData({ 'form.offTime': event.detail.value })
  },

  onHoursChange(event) {
    this.setData({ 'form.hoursIndex': Number(event.detail.value) })
  },

  onContentInput(event) {
    this.data.form.content = event.detail.value
  },

  async submit() {
    const form = this.data.form
    const hours = this.data.hoursOptions[form.hoursIndex]
    if (!form.content.trim()) {
      wx.showToast({ title: '请填写加班工作内容', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      await overtime.create({
        date: form.date,
        offTime: form.offTime,
        hours,
        content: form.content.trim()
      })
      this.setData({
        showForm: false,
        submitting: false,
        'form.offTime': '18:00',
        'form.hoursIndex': 0,
        'form.content': ''
      })
      wx.showToast({ title: `已登记${hours}小时`, icon: 'success' })
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
