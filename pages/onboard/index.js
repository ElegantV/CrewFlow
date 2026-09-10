const me = require('../../services/me')
const onboard = require('../../utils/onboard')

// 从人员列表提取"处室 → 一级选项"（含"全部处室"兜底）。
function buildDeptOptions(people) {
  const options = [{ value: '', label: '全部处室' }]
  const seen = new Set()
  people.forEach(person => {
    const dept = (person.department || '').trim()
    if (!dept || seen.has(dept)) return
    seen.add(dept)
    options.push({ value: dept, label: dept })
  })
  return options
}

function filterByDept(people, dept) {
  return dept ? people.filter(person => person.department === dept) : people
}

const STEP_META = {
  basic: { title: '基本信息', description: '填写姓名并选择人员类型' },
  relations: { title: '审批人与代理人', description: '一次性选择审批管理员与工作代理人' },
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
    form: { name: '', personnelType: 'digital' },
    personnelTypes: [
      { value: 'bank', label: '行员' },
      { value: 'digital', label: '数科' },
      { value: 'vendor', label: '厂商' }
    ],
    personnelTypeIndex: 1,
    people: [],
    selectedAgentIndex: -1,
    selectedAgentId: '',
    managers: [],
    selectedManagerIndex: -1,
    selectedManagerId: '',
    agentDepartments: [{ value: '', label: '全部处室' }],
    selectedAgentDeptIndex: 0,
    filteredPeople: [],
    managerDepartments: [{ value: '', label: '全部处室' }],
    selectedManagerDeptIndex: 0,
    filteredManagers: [],
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
      // 审批人与代理人合并在同一步一次填完。
      const keys = []
      if (missing.includes('name')) keys.push('basic')
      if (missing.includes('manager') || missing.includes('agent')) keys.push('relations')
      if (missing.includes('signature')) keys.push('signature')
      const form = { name: profile.name || '', personnelType: profile.personnelType || 'digital' }
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
      this.loadManagers(profile)
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
      const selectedAgentId = current.agent ? current.agent.id : ''
      const agentDepartments = buildDeptOptions(people)
      const selectedAgentDeptIndex = current.agent && current.agent.department
        ? Math.max(0, agentDepartments.findIndex(item => item.value === current.agent.department))
        : 0
      const filteredPeople = filterByDept(people, agentDepartments[selectedAgentDeptIndex].value)
      this.setData({
        people,
        agentDepartments,
        selectedAgentDeptIndex,
        filteredPeople,
        selectedAgentId,
        selectedAgentIndex: selectedAgentId
          ? filteredPeople.findIndex(person => person.id === selectedAgentId)
          : -1
      })
    } catch (error) {
      this.setData({ people: [] })
    }
  },

  async loadManagers(profile) {
    const current = profile || this.data.profile
    if (!current) return
    try {
      const result = await me.managers()
      const managers = result.managers || []
      const selectedManagerId = current.manager ? current.manager.id : ''
      const managerDepartments = buildDeptOptions(managers)
      const selectedManagerDeptIndex = current.manager && current.manager.department
        ? Math.max(0, managerDepartments.findIndex(item => item.value === current.manager.department))
        : 0
      const filteredManagers = filterByDept(managers, managerDepartments[selectedManagerDeptIndex].value)
      this.setData({
        managers,
        managerDepartments,
        selectedManagerDeptIndex,
        filteredManagers,
        selectedManagerId,
        selectedManagerIndex: selectedManagerId
          ? filteredManagers.findIndex(manager => manager.id === selectedManagerId)
          : -1
      })
    } catch (error) {
      this.setData({ managers: [] })
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

  onAgentDeptChange(event) {
    const index = Number(event.detail.value)
    const dept = this.data.agentDepartments[index].value
    const filteredPeople = filterByDept(this.data.people, dept)
    const selectedAgentId = filteredPeople.some(person => person.id === this.data.selectedAgentId)
      ? this.data.selectedAgentId
      : ''
    this.setData({
      selectedAgentDeptIndex: index,
      filteredPeople,
      selectedAgentId,
      selectedAgentIndex: selectedAgentId
        ? filteredPeople.findIndex(person => person.id === selectedAgentId)
        : -1
    })
  },

  onManagerDeptChange(event) {
    const index = Number(event.detail.value)
    const dept = this.data.managerDepartments[index].value
    const filteredManagers = filterByDept(this.data.managers, dept)
    const selectedManagerId = filteredManagers.some(manager => manager.id === this.data.selectedManagerId)
      ? this.data.selectedManagerId
      : ''
    this.setData({
      selectedManagerDeptIndex: index,
      filteredManagers,
      selectedManagerId,
      selectedManagerIndex: selectedManagerId
        ? filteredManagers.findIndex(manager => manager.id === selectedManagerId)
        : -1
    })
  },

  onAgentChange(event) {
    const index = Number(event.detail.value)
    this.setData({
      selectedAgentIndex: index,
      selectedAgentId: index >= 0 ? this.data.filteredPeople[index].id : ''
    })
  },

  onManagerChange(event) {
    const index = Number(event.detail.value)
    this.setData({
      selectedManagerIndex: index,
      selectedManagerId: index >= 0 ? this.data.filteredManagers[index].id : ''
    })
  },

  // PUT /profile 是整行更新，这里带上已加载的资料一起提交，避免把其他字段清成空。
  async saveBasic() {
    const { form, profile, filteredPeople, selectedAgentIndex, saving } = this.data
    if (saving) return
    const name = (form.name || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写中文姓名', icon: 'none' })
      return
    }
    const agent = filteredPeople[selectedAgentIndex]
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
      this.setData({
        saving: false,
        profile: Object.assign({}, this.data.profile, {
          name,
          personnelType: form.personnelType,
          agent: agent ? { id: agent.id, name: agent.name } : this.data.profile.agent
        })
      })
      this.advance()
    } catch (error) {
      this.setData({ saving: false })
      wx.showToast({ title: error.message || '保存失败', icon: 'none', duration: 3000 })
    }
  },

  async saveRelations() {
    const { saving, profile, filteredPeople, filteredManagers, selectedAgentIndex, selectedManagerIndex } = this.data
    if (saving) return
    const needManager = profile.role === 'user'
    const needAgent = profile.personnelType !== 'bank'
    const manager = filteredManagers[selectedManagerIndex]
    const agent = filteredPeople[selectedAgentIndex]
    if (needManager && !manager) {
      wx.showToast({ title: '请选择审批人', icon: 'none' })
      return
    }
    if (needAgent && !agent) {
      wx.showToast({ title: '请选择工作代理人', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      if (needManager) await me.setManager(manager.id)
      if (needAgent) await me.setAgent(agent.id)
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
    if (this.data.steps[next].key === 'relations') {
      this.loadPeople()
      this.loadManagers()
    }
  },

  finish() {
    wx.showModal({
      title: '必要信息已完善',
      content: '是否现在补充其余个人信息（联系方式、部门、账号等）？',
      confirmText: '去完善',
      cancelText: '稍后再说',
      success: result => {
        if (result.confirm) {
          wx.reLaunch({ url: '/pages/profile/index' })
        } else {
          wx.reLaunch({ url: '/pages/index/index' })
        }
      }
    })
  }
})
