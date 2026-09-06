const me = require('../../services/me')
const onboard = require('../../utils/onboard')

const STEP_META = {
  basic: { title: '基本信息', description: '填写姓名并选择人员类型' },
  agent: { title: '工作代理人', description: '非行员发起请假前需指定代理人' },
  signature: { title: '审批签名', description: '审批申请时需要使用手写签名' }
}

Page({
  data: {
    loading: true,
    loadError: false,
    profile: null,
    steps: [],
    stepIndex: 0,
    currentStep: 'basic',
    form: { name: '', personnelType: 'vendor' },
    personnelTypes: [
      { value: 'bank', label: '行员' },
      { value: 'digital', label: '数科' },
      { value: 'vendor', label: '厂商' }
    ],
    personnelTypeIndex: 2,
    people: [],
    selectedAgentIndex: -1,
    saving: false,
    signatureDirty: false,
    savingSignature: false
  },

  onLoad() {
    this.loadProfile()
  },

  async loadProfile() {
    this.setData({ loading: true, loadError: false })
    try {
      const profile = await me.get()
      const missing = onboard.missingRequiredOf(profile)
      // 资料已完备（如绑定的是老账号）直接回首页，不停留。
      if (!missing.length) {
        wx.reLaunch({ url: '/pages/index/index' })
        return
      }
      // 姓名缺失时把代理人并入基本信息一步保存（整行更新要求非行员必须带代理人），
      // 姓名已有但代理人缺失时单独出代理人步骤。
      const keys = []
      if (missing.includes('name')) keys.push('basic')
      else if (missing.includes('agent')) keys.push('agent')
      if (missing.includes('signature')) keys.push('signature')
      const form = { name: profile.name || '', personnelType: profile.personnelType || 'vendor' }
      this.setData({
        loading: false,
        profile,
        steps: keys.map(key => Object.assign({ key }, STEP_META[key])),
        stepIndex: 0,
        currentStep: keys[0],
        form,
        personnelTypeIndex: Math.max(0, this.data.personnelTypes.findIndex(item => item.value === form.personnelType))
      })
      this.loadPeople(profile)
    } catch (error) {
      this.setData({ loading: false, loadError: true })
    }
  },

  async loadPeople(profile) {
    const current = profile || this.data.profile
    if (!current) return
    try {
      const result = await me.people()
      const people = result.people || []
      const selectedAgentIndex = current.agent ? people.findIndex(person => person.id === current.agent.id) : -1
      this.setData({ people, selectedAgentIndex })
    } catch (error) {
      this.setData({ people: [] })
    }
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field
    if (field && this.data.form) this.data.form[field] = event.detail.value
  },

  onPersonnelTypeChange(event) {
    const index = Number(event.detail.value)
    this.setData({ personnelTypeIndex: index, 'form.personnelType': this.data.personnelTypes[index].value })
  },

  onAgentChange(event) {
    this.setData({ selectedAgentIndex: Number(event.detail.value) })
  },

  // PUT /profile 是整行更新，这里带上已加载的资料一起提交，避免把其他字段清成空。
  async saveBasic() {
    const { form, profile, people, selectedAgentIndex, saving } = this.data
    if (saving) return
    const name = (form.name || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写中文姓名', icon: 'none' })
      return
    }
    const agent = people[selectedAgentIndex]
    if (form.personnelType !== 'bank' && !agent && !(profile.agent && profile.agent.id)) {
      wx.showToast({ title: '非行员请选择工作代理人', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      await me.saveProfile({
        name,
        accountName: profile.accountName || null,
        oaAccount: profile.oaAccount || null,
        idCardNo: profile.idCardNo || null,
        personnelType: form.personnelType,
        digitalEmployeeNo: profile.digitalEmployeeNo || null,
        department: profile.department || null,
        bankProject: profile.bankProject || null,
        agentUserId: form.personnelType === 'bank' ? null : (agent ? agent.id : profile.agent.id),
        attendanceLocation: profile.attendanceLocation || null,
        bankLevel: profile.bankLevel || null,
        itlStatus: profile.itlStatus || 'no',
        workStartDate: profile.workStartDate || null,
        mobile: profile.mobile || null,
        address: profile.address || null,
        emergencyContactName: (profile.emergencyContact && profile.emergencyContact.name) || null,
        emergencyContactPhone: (profile.emergencyContact && profile.emergencyContact.phone) || null
      })
      this.setData({ saving: false })
      this.advance()
    } catch (error) {
      this.setData({ saving: false })
      wx.showToast({ title: error.message || '保存失败', icon: 'none', duration: 3000 })
    }
  },

  async saveAgent() {
    const { saving } = this.data
    if (saving) return
    const agent = this.data.people[this.data.selectedAgentIndex]
    if (!agent) {
      wx.showToast({ title: '请选择工作代理人', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      await me.setAgent(agent.id)
      this.setData({ saving: false })
      this.advance()
    } catch (error) {
      this.setData({ saving: false })
      wx.showToast({ title: error.message || '保存失败', icon: 'none', duration: 3000 })
    }
  },

  onSignatureStart(event) {
    const point = event.touches && event.touches[0]
    if (!point) return
    if (!this.signatureContext) {
      // 与个人信息页一致，保持旧版 Canvas 接口：Canvas 2D 在 macOS 开发者工具
      // WebView 渲染层存在触摸即崩的兼容问题。
      this.signatureContext = wx.createCanvasContext('signatureCanvas', this)
      this.signatureContext.setStrokeStyle('#111827')
      this.signatureContext.setLineWidth(4)
      this.signatureContext.setLineCap('round')
      this.signatureContext.setLineJoin('round')
    }
    this.lastSignaturePoint = { x: point.x, y: point.y }
  },

  onSignatureMove(event) {
    const point = event.touches && event.touches[0]
    if (!point || !this.lastSignaturePoint || !this.signatureContext) return
    this.signatureContext.beginPath()
    this.signatureContext.moveTo(this.lastSignaturePoint.x, this.lastSignaturePoint.y)
    this.signatureContext.lineTo(point.x, point.y)
    this.signatureContext.stroke()
    this.signatureContext.draw(true)
    this.lastSignaturePoint = { x: point.x, y: point.y }
    if (!this.data.signatureDirty) this.setData({ signatureDirty: true })
  },

  onSignatureEnd() {
    this.lastSignaturePoint = null
  },

  clearSignature() {
    const context = this.signatureContext || wx.createCanvasContext('signatureCanvas', this)
    context.clearRect(0, 0, 1000, 400)
    context.draw()
    this.signatureContext = context
    this.lastSignaturePoint = null
    this.setData({ signatureDirty: false })
  },

  saveSignature() {
    if (!this.data.signatureDirty || this.data.savingSignature) {
      wx.showToast({ title: '请先在签名框内手写签名', icon: 'none' })
      return
    }
    this.setData({ savingSignature: true })
    wx.canvasToTempFilePath({
      canvasId: 'signatureCanvas', fileType: 'png', quality: 1, destWidth: 1200, destHeight: 400,
      success: result => {
        wx.getFileSystemManager().readFile({
          filePath: result.tempFilePath, encoding: 'base64',
          success: async file => {
            try {
              await me.setSignature(`data:image/png;base64,${file.data}`)
              this.setData({ savingSignature: false, signatureDirty: false })
              this.advance()
            } catch (error) {
              this.setData({ savingSignature: false })
              wx.showToast({ title: error.message || '签名保存失败', icon: 'none' })
            }
          },
          fail: () => {
            // 真机调试模式下临时文件是 http://tmp 虚拟路径，读不到；与个人信息页同样引导。
            this.setData({ savingSignature: false })
            wx.showToast({
              title: '真机调试模式暂不支持保存签名，请用「预览」扫码后保存',
              icon: 'none', duration: 3000
            })
          }
        })
      },
      fail: () => {
        this.setData({ savingSignature: false })
        wx.showToast({ title: '签名生成失败', icon: 'none' })
      }
    }, this)
  },

  skipStep() {
    wx.showModal({
      title: '暂不设置',
      content: '稍后发起相关业务时仍会提示补齐，是否跳过？',
      success: result => {
        if (!result.confirm) return
        onboard.markSkipped()
        this.advance()
      }
    })
  },

  advance() {
    const next = this.data.stepIndex + 1
    if (next >= this.data.steps.length) {
      this.finish()
      return
    }
    this.setData({ stepIndex: next, currentStep: this.data.steps[next].key })
    if (this.data.steps[next].key === 'agent') this.loadPeople()
  },

  finish() {
    wx.showToast({ title: '信息已完善', icon: 'success' })
    setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600)
  }
})
