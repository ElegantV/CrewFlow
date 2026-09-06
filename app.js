const auth = require('./services/auth')
const { isApiConfigured } = require('./config/env')

App({
  globalData: {
    user: null,
    apiConfigured: isApiConfigured(),
    apiStatus: isApiConfigured() ? 'connecting' : 'not_configured',
    bootstrapError: null
  },

  onLaunch() {
    this.ready = this.bootstrap()
    this.watchUpdate()
  },

  // 热更新机制下用户可能长期停留在旧版本,下载完成后提示重启应用。
  watchUpdate() {
    if (!wx.getUpdateManager) return
    const manager = wx.getUpdateManager()
    manager.onUpdateReady(() => {
      wx.showModal({
        title: '更新提示',
        content: '新版本已经准备好，是否重启应用？',
        success: (res) => { if (res.confirm) manager.applyUpdate() }
      })
    })
  },

  // 线上 JS 异常目前没有其他上报通道,统一写入实时日志(小程序后台可查)便于排障。
  logRealtimeError(tag, detail) {
    try {
      if (wx.getRealtimeLogManager) wx.getRealtimeLogManager().error(tag, detail)
    } catch (e) { /* 实时日志不可用时忽略 */ }
    console.error(tag, detail)
  },

  onError(message) {
    this.logRealtimeError('app onError', message)
  },

  onUnhandledRejection(res) {
    this.logRealtimeError('app onUnhandledRejection', res && res.reason)
  },

  async bootstrap() {
    if (!this.globalData.apiConfigured) {
      return null
    }

    try {
      // 加超时兜底，避免 wx.login 或网络异常导致界面一直停留在"正在连接"。
      const session = await Promise.race([
        auth.restoreOrLogin(),
        new Promise((_, reject) => {
          setTimeout(() => reject({ code: 'REQUEST_ERROR', message: '连接超时，请重试' }), 15000)
        })
      ])
      this.globalData.user = session.user
      this.globalData.apiStatus = 'ready'
      this.globalData.bootstrapError = null
      // 节假日历:登录后异步拉取当年数据,失败不影响主流程(前端保留静态兜底)。
      require('./services/calendar').ensureYear(new Date().getFullYear()).catch(() => {})
      return session.user
    } catch (error) {
      this.globalData.apiStatus = 'unavailable'
      this.globalData.bootstrapError = error
      // 网络不可用是可恢复的运行状态，不应在开发者工具中输出未处理异常。
      if (!error || !['NETWORK_ERROR', 'REQUEST_ERROR'].includes(error.code)) {
        console.error('简序日程 初始化失败', error)
      }
      return null
    }
  }
})
