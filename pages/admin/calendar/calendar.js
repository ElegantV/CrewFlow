const admin = require('../../services/admin')

const TYPE_LABELS = {
  holiday: '法定节假日',
  makeup: '调休上班日'
}

Page({
  data: {
    year: new Date().getFullYear(),
    days: [],
    loading: false,
    syncing: false,
    showAdd: false,
    saving: false,
    dayTypes: [
      { value: 'holiday', label: '法定节假日' },
      { value: 'makeup', label: '调休上班日' }
    ],
    dayTypeIndex: 0,
    form: { date: '', name: '' }
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true })
    try {
      const result = await admin.calendarDays(this.data.year)
      const days = (result.days || []).map(item => ({
        date: item.date,
        dayType: item.day_type,
        name: item.name,
        source: item.source,
        typeLabel: TYPE_LABELS[item.day_type] || item.day_type,
        sourceLabel: item.source === 'manual' ? '手工' : '自动'
      }))
      this.setData({ days, loading: false })
    } catch (error) {
      this.setData({ loading: false })
      wx.showToast({ title: error.message || '加载失败', icon: 'none' })
    }
  },

  prevYear() {
    this.setData({ year: this.data.year - 1 })
    this.loadData()
  },

  nextYear() {
    this.setData({ year: this.data.year + 1 })
    this.loadData()
  },

  openAdd() {
    this.setData({ showAdd: true, form: { date: '', name: '' }, dayTypeIndex: 0 })
  },

  closeAdd() {
    this.setData({ showAdd: false })
  },

  onDateChange(event) {
    this.setData({ 'form.date': event.detail.value })
  },

  onNameInput(event) {
    this.setData({ 'form.name': event.detail.value })
  },

  onDayTypeChange(event) {
    this.setData({ dayTypeIndex: Number(event.detail.value) })
  },

  async saveDay() {
    const form = this.data.form
    if (!form.date) {
      wx.showToast({ title: '请选择日期', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      await admin.saveCalendarDay({
        date: form.date,
        dayType: this.data.dayTypes[this.data.dayTypeIndex].value,
        name: form.name || undefined
      })
      this.setData({ saving: false, showAdd: false })
      wx.showToast({ title: '已保存', icon: 'success' })
      this.loadData()
    } catch (error) {
      this.setData({ saving: false })
      wx.showToast({ title: error.message || '保存失败', icon: 'none' })
    }
  },

  removeDay(event) {
    const date = event.currentTarget.dataset.date
    wx.showModal({
      title: '删除日历日期',
      content: `删除后 ${date} 将恢复默认判定（周一至周五上班），是否继续？`,
      success: async result => {
        if (!result.confirm) return
        try {
          await admin.deleteCalendarDay(date)
          wx.showToast({ title: '已删除', icon: 'success' })
          this.loadData()
        } catch (error) {
          wx.showToast({ title: error.message || '删除失败', icon: 'none' })
        }
      }
    })
  },

  async syncNow() {
    if (this.data.syncing) return
    this.setData({ syncing: true })
    try {
      const result = await admin.syncCalendar()
      const results = [result.current, result.next].filter(Boolean)
      const okCount = results.filter(item => item.ok).length
      this.setData({ syncing: false })
      wx.showToast({
        title: okCount ? `已同步 ${okCount} 个年度` : '数据源暂不可用，稍后重试',
        icon: okCount ? 'success' : 'none',
        duration: 2500
      })
      this.loadData()
    } catch (error) {
      this.setData({ syncing: false })
      wx.showToast({ title: error.message || '同步失败', icon: 'none' })
    }
  },

  noop() {}
})
