const auth = require('../../services/auth')

Page({
  data: {
    mode: 'register',
    submitting: false,
    registered: false,
    form: { name: '', mobile: '' },
    bindForm: { name: '', mobile: '' }
  },

  switchMode(event) {
    this.setData({ mode: event.currentTarget.dataset.mode, registered: false })
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field
    this.data.form[field] = event.detail.value
  },

  onBindInput(event) {
    const field = event.currentTarget.dataset.field
    this.data.bindForm[field] = event.detail.value
  },

  async submitRegister() {
    const name = (this.data.form.name || '').trim()
    const mobile = (this.data.form.mobile || '').trim()
    if (!name || !mobile) {
      wx.showToast({ title: '请填写姓名和手机号', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      await auth.register({ name, mobile })
      this.setData({ submitting: false, registered: true })
    } catch (error) {
      this.setData({ submitting: false })
      if (error.code === 'ACCOUNT_ALREADY_EXISTS') {
        wx.showModal({
          title: '已有账号',
          content: error.message,
          confirmText: '去绑定',
          success: result => {
            if (result.confirm) {
              this.setData({ mode: 'bind', bindForm: { name, mobile } })
            }
          }
        })
        return
      }
      wx.showToast({ title: error.message || '注册失败', icon: 'none' })
    }
  },

  async submitBind() {
    const name = (this.data.bindForm.name || '').trim()
    const mobile = (this.data.bindForm.mobile || '').trim()
    if (!name || !mobile) {
      wx.showToast({ title: '请填写姓名和手机号', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      const result = await auth.bind({ name, mobile })
      this.setData({ submitting: false })
      // 同步全局用户信息，避免首页沿用绑定前的旧状态。
      if (result && result.user) {
        getApp().globalData.user = result.user
      }
      if (result && result.user && result.user.status === 'pending') {
        this.setData({ registered: true })
      } else {
        wx.showToast({ title: '绑定成功', icon: 'success' })
        wx.reLaunch({ url: '/pages/index/index' })
      }
    } catch (error) {
      this.setData({ submitting: false })
      wx.showToast({ title: error.message || '绑定失败', icon: 'none' })
    }
  }
})
