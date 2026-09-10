const admin = require('../../../services/admin')
const { showError } = require('../../../utils/feedback')

Page({
  data: {
    exportStart: '',
    exportEnd: '',
    exportUsers: [{ id: '', name: '全部用户' }],
    exportUserIndex: 0,
    exporting: false,
    showExport: false
  },

  // 页面级守卫:入口只在超管首页菜单出现,这里兜底拦截直接导航;数据接口另有服务端 super_admin 校验。
  async onLoad() {
    const app = getApp()
    if (app.ready) await app.ready
    const user = app.globalData.user
    if (!user || user.role !== 'super_admin') {
      wx.showToast({ title: '仅超级管理员可访问', icon: 'none' })
      setTimeout(() => {
        wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/index/index' }) })
      }, 600)
    }
  },

  openUsers() { wx.navigateTo({ url: '/pages/admin/users' }) },
  openCalendar() { wx.navigateTo({ url: '/pages/admin/calendar/calendar' }) },
  openDicts() { wx.navigateTo({ url: '/pages/admin/dicts/index' }) },

  // 导出弹窗首次打开时才拉用户列表;失败不阻断导出,仍可按“全部用户”导出。
  async openExport() {
    this.setData({ showExport: true })
    if (this.exportUsersLoaded) return
    try {
      const result = await admin.users()
      const exportUsers = [{ id: '', name: '全部用户' }].concat(
        result.users.map(user => ({ id: user.id, name: user.name || user.openid.slice(0, 8) }))
      )
      this.exportUsersLoaded = true
      this.setData({
        exportUsers,
        // 列表刷新后收窄时，防止选中下标越界。
        exportUserIndex: Math.min(this.data.exportUserIndex, exportUsers.length - 1)
      })
    } catch (error) { /* 忽略:选择器保留“全部用户”兜底项 */ }
  },

  closeExport() { if (!this.data.exporting) this.setData({ showExport: false }) },
  onExportStartChange(event) { this.setData({ exportStart: event.detail.value }) },
  onExportEndChange(event) { this.setData({ exportEnd: event.detail.value }) },
  onExportUserChange(event) { this.setData({ exportUserIndex: Number(event.detail.value) }) },

  // 按日期区间导出考勤记录(仅超级管理员,后端二次校验角色)。
  async exportRecords() {
    const { exportStart, exportEnd, exportUsers, exportUserIndex, exporting } = this.data
    if (exporting) return
    if (!exportStart || !exportEnd) {
      wx.showToast({ title: '请选择起止日期', icon: 'none' })
      return
    }
    if (exportStart > exportEnd) {
      wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' })
      return
    }
    this.setData({ exporting: true })
    try {
      const selectedUser = exportUsers[exportUserIndex]
      const filePath = await admin.downloadRecords(exportStart, exportEnd, selectedUser ? selectedUser.id : '')
      this.setData({ exporting: false })
      wx.openDocument({
        filePath,
        fileType: 'xlsx',
        showMenu: true,
        fail: () => wx.showToast({ title: '文件已下载，但打开失败', icon: 'none' })
      })
    } catch (error) {
      this.setData({ exporting: false })
      showError(error, '导出失败')
    }
  },

  noop() {}
})
