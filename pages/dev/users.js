const auth = require('../../services/auth')

const roleLabels = {
  super_admin: '超级管理员',
  admin: '管理员',
  user: '普通用户'
}

const statusLabels = {
  active: '已启用',
  pending: '待激活',
  disabled: '已停用'
}

Page({
  data: {
    loading: true,
    switchingId: '',
    restoring: false,
    currentUser: null,
    users: []
  },

  onShow() {
    this.loadUsers()
  },

  async loadUsers() {
    this.setData({ loading: true, currentUser: getApp().globalData.user })
    try {
      const result = await auth.listDevUsers()
      this.setData({
        loading: false,
        users: result.users.map(user => Object.assign({}, user, {
          roleLabel: roleLabels[user.role] || user.role,
          statusLabel: statusLabels[user.status] || user.status
        }))
      })
    } catch (error) {
      this.setData({ loading: false })
      wx.showToast({ title: error.message || '加载测试用户失败', icon: 'none' })
    }
  },

  async switchUser(event) {
    const userId = event.currentTarget.dataset.id
    this.setData({ switchingId: userId })
    try {
      const session = await auth.devLogin(userId)
      getApp().globalData.user = session.user
      wx.showToast({ title: `已切换为${session.user.name}`, icon: 'success' })
      setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 500)
    } catch (error) {
      this.setData({ switchingId: '' })
      wx.showToast({ title: error.message || '切换失败', icon: 'none' })
    }
  },

  async restoreWechat() {
    this.setData({ restoring: true })
    try {
      const session = await auth.restoreWechatLogin()
      getApp().globalData.user = session.user
      wx.showToast({ title: '已恢复微信登录', icon: 'success' })
      setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 500)
    } catch (error) {
      this.setData({ restoring: false })
      wx.showToast({ title: error.message || '恢复失败', icon: 'none' })
    }
  }
})

