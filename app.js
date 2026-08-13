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
  },

  async bootstrap() {
    if (!this.globalData.apiConfigured) {
      return null
    }

    try {
      const session = await auth.restoreOrLogin()
      this.globalData.user = session.user
      this.globalData.apiStatus = 'ready'
      this.globalData.bootstrapError = null
      return session.user
    } catch (error) {
      this.globalData.apiStatus = 'unavailable'
      this.globalData.bootstrapError = error
      // 网络不可用是可恢复的运行状态，不应在开发者工具中输出未处理异常。
      if (!error || !['NETWORK_ERROR', 'REQUEST_ERROR'].includes(error.code)) {
        console.error('CrewFlow 初始化失败', error)
      }
      return null
    }
  }
})
