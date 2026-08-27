const { isApiConfigured, isDevelopment } = require('../../config/env')
const me = require('../../services/me')

function emptyReminders() {
  return { overtimeExpiring: [], pendingApprovals: null, dutyConflicts: [] }
}

Page({
  data: {
    apiConfigured: false,
    apiStatus: 'not_configured',
    user: null,
    reminders: emptyReminders(),
    shortcuts: [
      {
        key: 'assistant',
        icon: '/assets/icons/ai.png',
        title: 'AI 助手',
        description: '说出任务，自动判断并执行',
        url: '/pages/assistant/index',
        accent: 'ai'
      },
      {
        key: 'duty',
        icon: '/assets/icons/duty.png',
        title: '值班',
        description: '登记值班并查看可用调休',
        url: '/pages/duty/index',
        accent: 'blue'
      },
      {
        key: 'leave',
        icon: '/assets/icons/leave.png',
        title: '请假',
        description: '提交申请并查看审批进度',
        url: '/pages/leave/index',
        accent: 'green'
      },
      {
        key: 'situation',
        icon: '/assets/icons/situation.png',
        title: '员工情况',
        description: '按日期查看请假与加班人员',
        url: '/pages/situation/index',
        accent: 'orange'
      },
      {
        key: 'contact',
        icon: '/assets/icons/contact.png',
        title: '通讯录',
        description: '按系统查找人员并快速联系',
        url: '/pages/contact/index',
        accent: 'blue'
      },
      {
        key: 'profile',
        icon: '/assets/icons/profile.png',
        title: '个人信息',
        description: '维护账户、行内与联系信息',
        url: '/pages/profile/index',
        accent: 'purple'
      }
    ]
  },

  async onShow() {
    const app = getApp()
    if (app.ready) {
      await app.ready
    }
    const user = app.globalData.user
    const shortcuts = this.data.shortcuts.filter(item => !['approval', 'admin', 'dev'].includes(item.key))
    if (user && (user.role === 'admin' || user.role === 'super_admin')) {
      shortcuts.push({
        key: 'approval', icon: '/assets/icons/approval.png', title: '请假审批',
        description: '处理普通用户的一级审批', url: '/pages/approval/index', accent: 'orange'
      })
    }
    if (user && user.role === 'super_admin') {
      shortcuts.push({
        key: 'admin', icon: '/assets/icons/admin.png', title: '用户管理',
        description: '配置角色、状态与审批管理员', url: '/pages/admin/users', accent: 'red'
      })
    }
    if (isDevelopment()) {
      shortcuts.push({
        key: 'dev', icon: '/assets/icons/dev.png', title: '切换测试身份',
        description: '仅开发版可用，不影响真实微信账号', url: '/pages/dev/users', accent: 'slate'
      })
    }
    this.setData({
      apiConfigured: isApiConfigured(),
      apiStatus: app.globalData.apiStatus,
      user,
      shortcuts
    })
    if (user) {
      await this.refreshUser(user)
    }
    this.loadReminders(this.data.user || user)
  },

  // 从服务端刷新当前用户状态/姓名，避免会话缓存与数据库不一致。
  async refreshUser(user) {
    try {
      const profile = await me.get()
      const refreshed = Object.assign({}, user, {
        name: profile.name || user.name,
        role: profile.role || user.role,
        status: profile.status || user.status
      })
      getApp().globalData.user = refreshed
      this.setData({ user: refreshed })
    } catch (error) {
      // 待激活账号由请求层统一跳转注册页，这里无需处理。
      if (error.code === 'ACCOUNT_PENDING') return
    }
  },

  async loadReminders(user) {
    const app = getApp()
    if (!user || user.status !== 'active' || app.globalData.apiStatus !== 'ready') {
      if (this.data.reminders !== emptyReminders()) this.setData({ reminders: emptyReminders() })
      return
    }
    try {
      const dashboard = await me.dashboard()
      this.setData({ reminders: {
        overtimeExpiring: dashboard.overtime.expiringSoon || [],
        pendingApprovals: dashboard.pendingApprovals,
        dutyConflicts: dashboard.dutyConflicts || []
      } })
    } catch (error) {
      if (this.data.reminders !== emptyReminders()) this.setData({ reminders: emptyReminders() })
    }
  },

  openShortcut(event) {
    wx.navigateTo({ url: event.currentTarget.dataset.url })
  },

  openRegister() {
    wx.navigateTo({ url: '/pages/register/index' })
  },

  async retryConnection() {
    const app = getApp()
    this.setData({ apiStatus: 'connecting' })
    app.ready = app.bootstrap()
    await app.ready
    this.onShow()
  }
})
