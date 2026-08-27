const approval = require('../../services/approval')

Page({
  data: {
    loading: true,
    approvals: [],
    history: []
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true })
    try {
      const [pending, history] = await Promise.all([approval.pending(), approval.history()])
      this.setData({ approvals: pending.approvals, history: history.approvals, loading: false })
    } catch (error) {
      this.setData({ loading: false })
      wx.showToast({ title: error.message || '加载失败', icon: 'none' })
    }
  },

  approve(event) {
    const id = event.currentTarget.dataset.id
    wx.showModal({
      title: '通过申请',
      content: '确认通过这条请假申请？',
      success: async result => {
        if (!result.confirm) return
        await this.decide(id, 'approve', '')
      }
    })
  },

  reject(event) {
    const id = event.currentTarget.dataset.id
    wx.showModal({
      title: '驳回申请',
      editable: true,
      placeholderText: '请填写驳回原因',
      success: async result => {
        if (!result.confirm) return
        if (!(result.content || '').trim()) {
          wx.showToast({ title: '请填写驳回原因', icon: 'none' })
          return
        }
        await this.decide(id, 'reject', (result.content || '').trim())
      }
    })
  },

  async decide(id, action, comment) {
    try {
      await approval.decide(id, action, comment)
      wx.showToast({ title: action === 'approve' ? '已通过' : '已驳回', icon: 'success' })
      await this.loadData()
    } catch (error) {
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
  }
})
