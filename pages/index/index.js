const { isApiConfigured, isDevelopment } = require('../../config/env')
const me = require('../../services/me')
const { BRAND_DEEP } = require('../../utils/theme')

function emptyReminders() {
  return { overtimeExpiring: [], pendingApprovals: null, dutyConflicts: [] }
}

Page({
  data: {
    apiConfigured: false,
    apiStatus: 'not_configured',
    user: null,
    reminders: emptyReminders(),
    menuEditor: false,
    menuClosing: false,
    menuSaving: false,
    menuItems: [],
    switchColor: BRAND_DEEP,
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
    const shortcuts = this.buildShortcuts(user)
    this.setData({
      apiConfigured: isApiConfigured(),
      apiStatus: app.globalData.apiStatus,
      user,
      shortcuts
    })
    if (user) {
      await this.refreshUser(user)
      await this.applyHomeMenu()
    }
    this.loadReminders(this.data.user || user)
  },

  // 根据角色计算默认菜单(不含个性化)。
  buildShortcuts(user) {
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
    return shortcuts
  },

  // 应用用户的菜单配置:按保存顺序排列,隐藏项不展示;未配置项按默认顺序追加。
  applyMenuConfig(shortcuts, config) {
    if (!config || !config.length) return shortcuts
    const byKey = {}
    shortcuts.forEach(item => { byKey[item.key] = item })
    const ordered = []
    const used = new Set()
    config.forEach(entry => {
      const item = byKey[entry.key]
      if (!item || used.has(entry.key)) return
      used.add(entry.key)
      if (!entry.hidden) ordered.push(item)
    })
    shortcuts.forEach(item => {
      if (!used.has(item.key)) ordered.push(item)
    })
    return ordered
  },

  // 拉取个人信息中的菜单配置并应用;静默失败时保持默认菜单。
  async applyHomeMenu() {
    try {
      const profile = await me.get()
      if (profile && profile.homeMenuConfig) {
        this.homeMenuConfig = profile.homeMenuConfig
        this.setData({ shortcuts: this.applyMenuConfig(this.buildShortcuts(this.data.user), profile.homeMenuConfig) })
      }
    } catch (error) {
      // 菜单配置获取失败不影响首页可用性。
    }
  },

  // 打开编辑弹层:列出全部可见菜单(含已隐藏项),支持隐藏/显示与上下移动。
  openMenuEditor() {
    const all = this.buildShortcuts(this.data.user)
    const config = this.homeMenuConfig || []
    const hiddenKeys = new Set(config.filter(item => item.hidden).map(item => item.key))
    const orderMap = new Map()
    config.forEach((item, index) => { orderMap.set(item.key, index) })
    const items = all
      .map(item => ({
        key: item.key,
        title: item.title,
        icon: item.icon,
        accent: item.accent,
        hidden: hiddenKeys.has(item.key),
        order: orderMap.has(item.key) ? orderMap.get(item.key) : 100 + all.indexOf(item)
      }))
      .sort((a, b) => a.order - b.order)
    this.setData({ menuEditor: true, menuClosing: false, menuItems: items })
  },

  // 关闭弹层:先播收起动画,再卸载节点,避免底部 sheet 直接消失的突兀感。
  closeMenuEditor() {
    if (this.data.menuClosing) return
    this.setData({ menuClosing: true })
    this.menuCloseTimer = setTimeout(() => {
      this.setData({ menuEditor: false, menuClosing: false })
    }, 200)
  },

  onUnload() {
    if (this.menuCloseTimer) clearTimeout(this.menuCloseTimer)
  },

  toggleMenuItem(event) {
    const key = event.currentTarget.dataset.key
    const menuItems = this.data.menuItems.map(item => item.key === key ? Object.assign({}, item, { hidden: !item.hidden }) : item)
    this.setData({ menuItems })
  },

  moveMenuItem(event) {
    const index = Number(event.currentTarget.dataset.index)
    const delta = event.currentTarget.dataset.direction === 'up' ? -1 : 1
    const target = index + delta
    if (target < 0 || target >= this.data.menuItems.length) return
    const menuItems = this.data.menuItems.slice()
    const temp = menuItems[index]
    menuItems[index] = menuItems[target]
    menuItems[target] = temp
    this.setData({ menuItems })
  },

  async saveMenuEditor() {
    const items = this.data.menuItems.map(item => ({ key: item.key, hidden: item.hidden }))
    this.setData({ menuSaving: true })
    try {
      await me.saveHomeMenu(items)
      this.homeMenuConfig = items
      if (this.menuCloseTimer) clearTimeout(this.menuCloseTimer)
      this.setData({ menuSaving: false, menuEditor: false, menuClosing: false, shortcuts: this.applyMenuConfig(this.buildShortcuts(this.data.user), items) })
      wx.showToast({ title: '菜单已更新', icon: 'success' })
    } catch (error) {
      this.setData({ menuSaving: false })
      wx.showToast({ title: error.message || '保存失败', icon: 'none' })
    }
  },

  noopMenu() {},

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
