const me = require('../../services/me')
const wxpusher = require('../../services/wxpusher')
const { getApiBaseUrl } = require('../../config/env')

// 年假规则：满一年可休；工龄未满 5 年按 5 天；超过 5 年每多一年加一天，上限 15 天。
function calculateAnnualLeave(workStartDate) {
  if (!workStartDate) return { workYears: 0, annualLeaveDays: 0 }
  const parts = workStartDate.split('-').map(Number)
  const now = new Date()
  let workYears = now.getFullYear() - parts[0]
  if (now.getMonth() + 1 < parts[1] || (now.getMonth() + 1 === parts[1] && now.getDate() < parts[2])) workYears -= 1
  workYears = Math.max(0, workYears)
  let annualLeaveDays = 0
  if (workYears >= 1) {
    annualLeaveDays = workYears < 5 ? 5 : Math.min(workYears, 15)
  }
  return { workYears, annualLeaveDays: Math.floor(annualLeaveDays) }
}

function today() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

Page({
  data: {
    profile: null,
    form: null,
    people: [],
    selectedAgentIndex: -1,
    personnelTypes: [
      { value: 'bank', label: '行员' },
      { value: 'digital', label: '数科' },
      { value: 'vendor', label: '厂商' }
    ],
    personnelTypeIndex: 2,
    itlOptions: [
      { value: 'yes', label: '是' },
      { value: 'no', label: '否' },
      { value: 'ops', label: '运维' }
    ],
    itlIndex: 1,
    annualLeave: { workYears: 0, annualLeaveDays: 0 },
    maxWorkStartDate: today(),
    saving: false,
    savingAvatar: false,
    avatarPicking: false,
    isManager: false,
    signatureDirty: false,
    savingSignature: false,
    wxpusherEnabled: false,
    wxpusherBound: false,
    wxpusherUid: '',
    wxpusherLoading: false
  },

  onShow() {
    this.loadData()
    this.loadWxPusher()
  },

  onUnload() {
    if (this.bindPollTimer) clearTimeout(this.bindPollTimer)
    this.bindPollCount = 0
  },

  async loadWxPusher() {
    try {
      const result = await wxpusher.status()
      this.setData({
        wxpusherEnabled: result.enabled,
        wxpusherBound: result.bound,
        wxpusherUid: result.uid || ''
      })
    } catch (error) {
      this.setData({ wxpusherEnabled: false, wxpusherBound: false })
    }
  },

  async getBindQr() {
    if (this.data.wxpusherLoading) return
    this.setData({ wxpusherLoading: true })
    try {
      const result = await wxpusher.getQr()
      const baseUrl = getApiBaseUrl()
      const qrUrl = result.qrToken && baseUrl ? `${baseUrl}/api/v1/wxpusher/qr/${result.qrToken}` : ''
      if (!qrUrl) {
        wx.showToast({ title: '获取二维码失败', icon: 'none' })
        return
      }
      wx.previewImage({ urls: [qrUrl], current: qrUrl, fail: () => wx.showToast({ title: '二维码加载失败', icon: 'none' }) })
      this.bindPollCount = 0
      this.pollBind()
    } catch (error) {
      wx.showToast({ title: error.message || '获取二维码失败', icon: 'none' })
    } finally {
      this.setData({ wxpusherLoading: false })
    }
  },

  pollBind() {
    if (this.bindPollTimer) clearTimeout(this.bindPollTimer)
    if (!this.bindPollCount) this.bindPollCount = 0
    this.bindPollCount += 1
    // wxpusher 要求轮询间隔不小于 10 秒；最多约 90 秒后提示重新生成二维码。
    if (this.bindPollCount > 9) {
      this.bindPollCount = 0
      this.setData({ wxpusherQrUrl: '' })
      wx.showToast({ title: '绑定超时，请重新扫码', icon: 'none' })
      return
    }
    this.bindPollTimer = setTimeout(async () => {
      try {
        const result = await wxpusher.check()
        if (result.bound) {
          this.bindPollCount = 0
          this.setData({ wxpusherBound: true, wxpusherUid: result.uid || '', wxpusherQrUrl: '' })
          wx.showToast({ title: '绑定成功', icon: 'success' })
          return
        }
        this.pollBind()
      } catch (error) {
        this.pollBind()
      }
    }, 10000)
  },

  async testPush() {
    try {
      await wxpusher.test()
      wx.showToast({ title: '已发送测试消息', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message || '发送失败', icon: 'none' })
    }
  },

  unbindPush() {
    wx.showModal({
      title: '解绑微信推送',
      content: '解绑后将收不到审批提醒消息，是否继续？',
      success: async result => {
        if (!result.confirm) return
        try {
          await wxpusher.unbind()
          this.setData({ wxpusherBound: false, wxpusherUid: '' })
          wx.showToast({ title: '已解绑', icon: 'success' })
        } catch (error) {
          wx.showToast({ title: error.message || '解绑失败', icon: 'none' })
        }
      }
    })
  },

  async loadData() {
    try {
      const profile = await me.get()
      const peopleResult = await me.people()
      const people = peopleResult.people || []
      const personnelType = profile.personnelType || 'vendor'
      const itlStatus = profile.itlStatus || 'no'
      const selectedAgentIndex = profile.agent ? people.findIndex(person => person.id === profile.agent.id) : -1
      const form = {
        name: profile.name || '',
        accountName: profile.accountName || profile.employeeNo || '',
        oaAccount: profile.oaAccount || '',
        idCardNo: profile.idCardNo || '',
        avatar: profile.avatar || '',
        personnelType,
        digitalEmployeeNo: profile.digitalEmployeeNo || '',
        department: profile.department || '',
        bankProject: profile.bankProject || '',
        attendanceLocation: profile.attendanceLocation || '',
        bankLevel: profile.bankLevel || '',
        itlStatus,
        workStartDate: profile.workStartDate || '',
        mobile: profile.mobile || '',
        address: profile.address || '',
        emergencyContactName: (profile.emergencyContact && profile.emergencyContact.name) || '',
        emergencyContactPhone: (profile.emergencyContact && profile.emergencyContact.phone) || ''
      }
      this.setData({
        profile,
        form,
        people,
        selectedAgentIndex,
        personnelTypeIndex: Math.max(0, this.data.personnelTypes.findIndex(item => item.value === personnelType)),
        itlIndex: Math.max(0, this.data.itlOptions.findIndex(item => item.value === itlStatus)),
        annualLeave: profile.annualLeave || calculateAnnualLeave(form.workStartDate),
        isManager: profile.role === 'admin' || profile.role === 'super_admin'
      }, () => {
        // 签名画布在 isManager 为 true 后才渲染,渲染完成后才能查到节点。
        if (this.data.isManager) this.setupSignatureCanvas()
      })
    } catch (error) {
      wx.showToast({ title: error.message || '个人信息加载失败', icon: 'none' })
    }
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field
    if (field && this.data.form) this.data.form[field] = event.detail.value
  },

  onPersonnelTypeChange(event) {
    const index = Number(event.detail.value)
    const personnelType = this.data.personnelTypes[index].value
    const updates = { personnelTypeIndex: index, 'form.personnelType': personnelType }
    if (personnelType === 'bank') {
      updates.selectedAgentIndex = -1
    }
    this.setData(updates)
  },

  onItlChange(event) {
    const index = Number(event.detail.value)
    this.setData({ itlIndex: index, 'form.itlStatus': this.data.itlOptions[index].value })
  },

  onAgentChange(event) {
    this.setData({ selectedAgentIndex: Number(event.detail.value) })
  },

  onWorkStartDateChange(event) {
    const workStartDate = event.detail.value
    this.setData({ 'form.workStartDate': workStartDate, annualLeave: calculateAnnualLeave(workStartDate) })
  },

  chooseAvatar() {
    // 防止重复触发（连点）打开多个选择器。
    if (this.data.savingAvatar || this.data.avatarPicking) return
    this.setData({ avatarPicking: true })
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: result => {
        this.setData({ avatarPicking: false })
        const tempPath = result.tempFiles && result.tempFiles[0] && result.tempFiles[0].tempFilePath
        if (!tempPath) return
        this.setData({ savingAvatar: true })
        const upload = filePath => {
          wx.getFileSystemManager().readFile({
            filePath,
            encoding: 'base64',
            success: async file => {
              try {
                const imageData = `data:image/jpeg;base64,${file.data}`
                await me.setAvatar(imageData)
                this.setData({ savingAvatar: false, 'form.avatar': imageData })
                wx.showToast({ title: '头像已更新', icon: 'success' })
              } catch (error) {
                this.setData({ savingAvatar: false })
                wx.showToast({ title: error.message || '头像上传失败', icon: 'none' })
              }
            },
            fail: () => {
              this.setData({ savingAvatar: false })
              wx.showToast({ title: '头像读取失败', icon: 'none' })
            }
          })
        }
        wx.compressImage({ src: tempPath, quality: 60, success: r => upload(r.tempFilePath), fail: () => upload(tempPath) })
      },
      fail: () => this.setData({ avatarPicking: false }),
      complete: () => this.setData({ avatarPicking: false })
    })
  },

  async saveProfile() {
    const form = this.data.form
    if (!form || !form.name.trim()) {
      wx.showToast({ title: '请填写中文姓名', icon: 'none' })
      return
    }
    const agent = this.data.people[this.data.selectedAgentIndex]
    if (form.personnelType !== 'bank' && !agent) {
      wx.showToast({ title: '非行员请选择工作代理人', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      await me.saveProfile({
        name: form.name,
        accountName: form.accountName || null,
        oaAccount: form.oaAccount || null,
        idCardNo: form.idCardNo || null,
        personnelType: form.personnelType,
        digitalEmployeeNo: form.digitalEmployeeNo || null,
        department: form.department || null,
        bankProject: form.bankProject || null,
        agentUserId: form.personnelType === 'bank' ? null : agent.id,
        attendanceLocation: form.attendanceLocation || null,
        bankLevel: form.bankLevel || null,
        itlStatus: form.itlStatus,
        workStartDate: form.workStartDate || null,
        mobile: form.mobile || null,
        address: form.address || null,
        emergencyContactName: form.emergencyContactName || null,
        emergencyContactPhone: form.emergencyContactPhone || null
      })
      this.setData({ saving: false })
      wx.showToast({ title: '个人信息已保存', icon: 'success' })
      await this.loadData()
    } catch (error) {
      this.setData({ saving: false })
      wx.showToast({ title: error.message || '保存失败', icon: 'none', duration: 3000 })
    }
  },

  onReady() {
    this.setupSignatureCanvas()
  },

  // 签名画布用 Canvas 2D 接口:旧接口导出图片需经 canvasToTempFilePath 落临时文件再读,
  // 真机调试模式下 FileSystemManager 读不到这类临时文件(报"签名读取失败");
  // 2D 画布直接 toDataURL 导出 base64,不落临时文件,各运行环境行为一致。
  setupSignatureCanvas() {
    wx.createSelectorQuery().in(this).select('#signatureCanvas').fields({ node: true, size: true, rect: true }).exec(result => {
      const info = result && result[0]
      if (!info || !info.node) return
      if (this.signatureCanvas === info.node) return
      const canvas = info.node
      const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const dpr = windowInfo.pixelRatio || 2
      canvas.width = info.width * dpr
      canvas.height = info.height * dpr
      const context = canvas.getContext('2d')
      context.scale(dpr, dpr)
      context.strokeStyle = '#111827'
      context.lineWidth = 4
      context.lineCap = 'round'
      context.lineJoin = 'round'
      this.signatureCanvas = canvas
      this.signatureContext = context
      // 缓存画布在视口中的偏移,触摸事件缺 canvas 相对坐标时兜底换算。
      this.canvasRect = { left: info.left || 0, top: info.top || 0 }
    })
  },

  // 不同基础库下 canvas 触摸事件坐标字段不一致:优先 canvas 相对坐标 x/y,
  // 缺失时用视口坐标减画布偏移换算。
  signaturePoint(touch) {
    if (!touch) return null
    const offset = this.canvasRect || { left: 0, top: 0 }
    return {
      x: typeof touch.x === 'number' ? touch.x : touch.clientX - offset.left,
      y: typeof touch.y === 'number' ? touch.y : touch.clientY - offset.top
    }
  },

  onSignatureStart(event) {
    const point = this.signaturePoint(event.touches && event.touches[0])
    if (!point) return
    if (!this.signatureContext) {
      // 画布节点尚未就绪时兜底重试;就绪后下一笔即可正常书写。
      this.setupSignatureCanvas()
      return
    }
    this.lastSignaturePoint = point
  },

  onSignatureMove(event) {
    const point = this.signaturePoint(event.touches && event.touches[0])
    if (!point || !this.lastSignaturePoint || !this.signatureContext) return
    this.signatureContext.beginPath()
    this.signatureContext.moveTo(this.lastSignaturePoint.x, this.lastSignaturePoint.y)
    this.signatureContext.lineTo(point.x, point.y)
    this.signatureContext.stroke()
    this.lastSignaturePoint = point
    if (!this.data.signatureDirty) this.setData({ signatureDirty: true })
  },

  onSignatureEnd() {
    this.lastSignaturePoint = null
  },

  clearSignature() {
    if (!this.signatureContext || !this.signatureCanvas) return
    const context = this.signatureContext
    // clearRect 受 dpr 缩放影响,先复位变换,按物理像素清空整个画布。
    context.save()
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, this.signatureCanvas.width, this.signatureCanvas.height)
    context.restore()
    this.lastSignaturePoint = null
    this.setData({ signatureDirty: false })
  },

  async saveSignature() {
    if (!this.data.signatureDirty || this.data.savingSignature) {
      wx.showToast({ title: '请先在签名框内手写签名', icon: 'none' })
      return
    }
    if (!this.signatureCanvas) {
      wx.showToast({ title: '签名画布未就绪，请重新进入页面', icon: 'none' })
      return
    }
    this.setData({ savingSignature: true })
    try {
      const dataUrl = this.signatureCanvas.toDataURL('image/png')
      await me.setSignature(dataUrl)
      this.setData({ savingSignature: false, signatureDirty: false, 'profile.signatureConfigured': true })
      wx.showToast({ title: '审批签名已保存', icon: 'success' })
    } catch (error) {
      this.setData({ savingSignature: false })
      wx.showToast({ title: error.message || '签名保存失败', icon: 'none' })
    }
  }
})
