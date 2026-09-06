const admin = require('../../../services/admin')

Page({
  data: {
    loaded: false,
    saving: false,
    keyMasked: '',
    form: {
      model: '',
      apiKey: '',
      maxReplyChars: '120',
      maxTokens: '400',
      systemPrompt: ''
    }
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    try {
      const config = await admin.getAiConfig()
      this.setData({
        loaded: true,
        keyMasked: config.keyMasked || '',
        form: {
          model: config.model || '',
          apiKey: '',
          maxReplyChars: String(config.maxReplyChars || 120),
          maxTokens: String(config.maxTokens || 400),
          systemPrompt: config.systemPrompt || ''
        }
      })
      this.updateKeyPlaceholder()
    } catch (error) {
      wx.showToast({ title: error.message || 'AI 配置加载失败', icon: 'none' })
    }
  },

  updateKeyPlaceholder() {
    this.setData({
      keyPlaceholder: this.data.keyMasked ? '留空保持现有 Key 不变' : '粘贴 API Key'
    })
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field
    if (field && this.data.form) this.data.form[field] = event.detail.value
  },

  async save() {
    if (this.data.saving) return
    const form = this.data.form
    const maxReplyChars = Number(form.maxReplyChars)
    const maxTokens = Number(form.maxTokens)
    if (!Number.isInteger(maxReplyChars) || maxReplyChars < 30 || maxReplyChars > 1000) {
      wx.showToast({ title: '回复字数上限须为 30~1000 的整数', icon: 'none' })
      return
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 50 || maxTokens > 4000) {
      wx.showToast({ title: 'Token 上限须为 50~4000 的整数', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      const config = await admin.saveAiConfig({
        model: form.model.trim(),
        maxReplyChars,
        maxTokens,
        systemPrompt: form.systemPrompt.trim(),
        apiKey: form.apiKey.trim() || ''
      })
      this.setData({
        saving: false,
        keyMasked: config.keyMasked || '',
        form: Object.assign({}, this.data.form, { apiKey: '' })
      })
      this.updateKeyPlaceholder()
      wx.showToast({ title: 'AI 配置已保存', icon: 'success' })
    } catch (error) {
      this.setData({ saving: false })
      wx.showToast({ title: error.message || '保存失败，请重试', icon: 'none' })
    }
  }
})
