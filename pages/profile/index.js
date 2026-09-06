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
    signatureImage: '',
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
      })
      // 管理员且已保存过签名时回显当前签名;失败不影响资料页其余功能。
      if (profile.signatureConfigured && (profile.role === 'admin' || profile.role === 'super_admin')) {
        this.loadSignature()
      } else {
        this.setData({ signatureImage: '' })
      }
    } catch (error) {
      wx.showToast({ title: error.message || '个人信息加载失败', icon: 'none' })
    }
  },

  async loadSignature() {
    try {
      const result = await me.getSignature()
      this.setData({ signatureImage: result.imageData || '' })
    } catch (error) {
      this.setData({ signatureImage: '' })
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

  onSignatureStart(event) {
    const point = event.touches && event.touches[0]
    if (!point) return
    if (!this.signatureContext) {
      // 懒初始化:签名区随资料加载渲染,首次触摸时画布已就绪。
      // 保持旧版 Canvas 接口:Canvas 2D 在 macOS 开发者工具 WebView 渲染层
      // 存在 this._getData 崩溃(触摸即报错),各基础库表现不一致。
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
              this.setData({
                savingSignature: false,
                signatureDirty: false,
                signatureImage: `data:image/png;base64,${file.data}`,
                'profile.signatureConfigured': true
              })
              wx.showToast({ title: '审批签名已保存', icon: 'success' })
            } catch (error) {
              this.setData({ savingSignature: false })
              wx.showToast({ title: error.message || '签名保存失败', icon: 'none' })
            }
          },
          fail: () => {
            // 真机调试模式下临时文件是 http://tmp 虚拟路径,FileSystemManager 读不到;
            // 预览版/体验版/正式版不受影响。签名是一次性设置,给出明确引导即可。
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
  }
})
