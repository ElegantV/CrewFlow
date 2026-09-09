const approval = require('../../services/approval')

function formatTime(value) {
  if (!value) return ''
  const text = String(value)
  return text.length >= 16 ? text.slice(0, 16).replace('T', ' ') : text
}

Page({
  data: {
    loading: true,
    approvals: [],
    history: [],
    decidingId: '',
    detail: null,
    loadError: ''
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true, loadError: '' })
    try {
      const [pending, history] = await Promise.all([approval.pending(), approval.history()])
      this.setData({ approvals: pending.approvals, history: history.approvals, loading: false })
    } catch (error) {
      this.setData({ loading: false, loadError: error.message || '加载失败，请重试' })
    }
  },

  openDetail(event) {
    if (this.data.decidingId) return
    const id = event.currentTarget.dataset.id
    const item = this.data.approvals.find(entry => entry.id === id)
    if (item) this.setData({ detail: Object.assign({}, item, { submittedTime: formatTime(item.submittedAt) }) })
  },

  closeDetail() {
    if (this.data.decidingId) return
    this.setData({ detail: null })
  },

  approve(event) {
    const id = event.currentTarget.dataset.id
    if (!id || this.data.decidingId) return
    this.setData({ decidingId: id })
    wx.showModal({
      title: '通过申请',
      content: '确认通过这条请假申请？',
      success: async result => {
        if (!result.confirm) {
          this.setData({ decidingId: '' })
          return
        }
        await this.decide(id, 'approve', '')
      },
      fail: () => this.setData({ decidingId: '' })
    })
  },

  reject(event) {
    const id = event.currentTarget.dataset.id
    if (!id || this.data.decidingId) return
    this.setData({ decidingId: id })
    wx.showModal({
      title: '驳回申请',
      editable: true,
      placeholderText: '请填写驳回原因',
      success: async result => {
        const reason = (result.content || '').trim()
        if (!result.confirm || !reason) {
          this.setData({ decidingId: '' })
          if (result.confirm) wx.showToast({ title: '请填写驳回原因', icon: 'none' })
          return
        }
        await this.decide(id, 'reject', reason)
      },
      fail: () => this.setData({ decidingId: '' })
    })
  },

  async decide(id, action, comment) {
    try {
      await approval.decide(id, action, comment)
      this.setData({ decidingId: '', detail: null })
      wx.showToast({ title: action === 'approve' ? '已通过' : '已驳回', icon: 'success' })
      await this.loadData()
    } catch (error) {
      this.setData({ decidingId: '' })
      if (error.code === 'SIGNATURE_REQUIRED') {
        wx.showModal({
          title: '请先设置审批签名',
          content: error.message,
          confirmText: '去设置',
          success: result => {
            if (result.confirm) wx.navigateTo({ url: '/pages/profile/index' })
          }
        })
        return
      }
      wx.showToast({ title: error.message || '审批失败', icon: 'none' })
    }
  },

  noop() {}
})
