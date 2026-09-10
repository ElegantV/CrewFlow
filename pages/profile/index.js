const me = require('../../services/me')
const wxpusher = require('../../services/wxpusher')
const { getApiBaseUrl } = require('../../config/env')
const { showError } = require('../../utils/feedback')

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

const MOBILE_RE = /^1[3-9]\d{9}$/

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

// 参与"未保存修改"判定的字段(不含头像,头像单独即时保存)。
const DIRTY_KEYS = [
  'name', 'accountName', 'oaAccount', 'idCardNo', 'personnelType', 'digitalEmployeeNo',
  'department', 'bankProject', 'attendanceLocation', 'itlStatus',
  'workStartDate', 'mobile', 'address', 'emergencyContactName', 'emergencyContactPhone'
]

function pickForm(form) {
  if (!form) return null
  const snapshot = {}
  DIRTY_KEYS.forEach(key => { snapshot[key] = form[key] === undefined || form[key] === null ? '' : form[key] })
  return snapshot
}

Page({
  data: {
    profile: null,
    form: null,
    people: [],
    selectedAgentIndex: -1,
    selectedAgentId: '',
    managers: [],
    selectedManagerIndex: -1,
    selectedManagerId: '',
    departments: [],
    departmentIndex: 0,
    projects: [],
    projectOptions: [],
    projectIndex: 0,
    locations: [],
    locationIndex: 0,
    managerDepartments: [{ value: '', label: '全部处室' }],
    selectedManagerDeptIndex: 0,
    filteredManagers: [],
    managerMultiRange: [[], []],
    managerMultiIndex: [0, 0],
    agentDepartments: [{ value: '', label: '全部处室' }],
    selectedAgentDeptIndex: 0,
    filteredPeople: [],
    agentMultiRange: [[], []],
    agentMultiIndex: [0, 0],
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
      showError(error, '获取二维码失败')
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
      wx.showToast({ title: '已发送提醒消息', icon: 'success' })
    } catch (error) {
      showError(error, '发送失败')
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
          showError(error, '解绑失败')
        }
      }
    })
  },

  async loadData() {
    try {
      const profile = await me.get()
      const peopleResult = await me.people()
      const people = peopleResult.people || []
      const managersResult = await me.managers()
      const managers = managersResult.managers || []
      const personnelType = profile.personnelType || 'digital'
      const itlStatus = profile.itlStatus || 'no'

      // 行内字典(处室/项目/打卡地点):加载失败不影响页面其余功能,选择器留空兜底。
      let departments = []
      let projects = []
      let locations = []
      try {
        const dicts = await me.dicts()
        departments = dicts.departments || []
        projects = dicts.bankProjects || []
        locations = dicts.attendanceLocations || []
      } catch (error) {
        wx.showToast({ title: '行内字段字典加载失败，请重试', icon: 'none' })
      }
      const departmentIndex = Math.max(0, departments.findIndex(item => item.name === profile.department))
      const projectOptions = departments[departmentIndex]
        ? projects.filter(item => item.departmentId === departments[departmentIndex].id)
        : []
      const projectIndex = Math.max(0, projectOptions.findIndex(item => item.name === profile.bankProject))
      const locationIndex = Math.max(0, locations.findIndex(item => item.name === profile.attendanceLocation))

      // 审批人/代理人两级选择:先按处室过滤,再选具体人员。
      const managerDepartments = buildDeptOptions(managers)
      const agentDepartments = buildDeptOptions(people)
      const selectedManagerId = profile.manager ? profile.manager.id : ''
      const selectedManagerDeptIndex = profile.manager && profile.manager.department
        ? Math.max(0, managerDepartments.findIndex(item => item.value === profile.manager.department))
        : 0
      const filteredManagers = filterByDept(managers, managerDepartments[selectedManagerDeptIndex].value)
      const selectedAgentId = profile.agent ? profile.agent.id : ''
      const selectedAgentDeptIndex = profile.agent && profile.agent.department
        ? Math.max(0, agentDepartments.findIndex(item => item.value === profile.agent.department))
        : 0
      const filteredPeople = filterByDept(people, agentDepartments[selectedAgentDeptIndex].value)

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
        managers,
        departments,
        departmentIndex,
        projects,
        projectOptions,
        projectIndex,
        locations,
        locationIndex,
        managerDepartments,
        selectedManagerDeptIndex,
        filteredManagers,
        managerMultiRange: [managerDepartments.map(item => ({ name: item.label, value: item.value })), filteredManagers],
        managerMultiIndex: [
          selectedManagerDeptIndex,
          Math.max(0, filteredManagers.findIndex(item => item.id === selectedManagerId))
        ],
        selectedManagerId,
        selectedManagerIndex: filteredManagers.findIndex(item => item.id === selectedManagerId),
        agentDepartments,
        selectedAgentDeptIndex,
        filteredPeople,
        agentMultiRange: [agentDepartments.map(item => ({ name: item.label, value: item.value })), filteredPeople],
        agentMultiIndex: [
          selectedAgentDeptIndex,
          Math.max(0, filteredPeople.findIndex(item => item.id === selectedAgentId))
        ],
        selectedAgentId,
        selectedAgentIndex: filteredPeople.findIndex(item => item.id === selectedAgentId),
        personnelTypeIndex: Math.max(0, this.data.personnelTypes.findIndex(item => item.value === personnelType)),
        itlIndex: Math.max(0, this.data.itlOptions.findIndex(item => item.value === itlStatus)),
        annualLeave: profile.annualLeave || calculateAnnualLeave(form.workStartDate),
        isManager: profile.role === 'admin' || profile.role === 'super_admin'
      })
      this.syncSnapshot()
      // 管理员且已保存过签名时回显当前签名;失败不影响资料页其余功能。
      if (profile.signatureConfigured && (profile.role === 'admin' || profile.role === 'super_admin')) {
        this.loadSignature()
      } else {
        this.setData({ signatureImage: '' })
      }
    } catch (error) {
      showError(error, '个人信息加载失败')
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

  // 记录当前表单快照，作为"未保存修改"判定的基线。
  syncSnapshot() {
    this.savedForm = pickForm(this.data.form)
    this.savedAgentId = this.data.selectedAgentId
    this.savedManagerId = this.data.selectedManagerId
  },

  isDirty() {
    if (!this.data.form || !this.savedForm) return false
    const current = pickForm(this.data.form)
    const changed = DIRTY_KEYS.some(key => String(current[key] || '') !== String(this.savedForm[key] || ''))
    if (changed) return true
    return this.data.selectedAgentId !== this.savedAgentId || this.data.selectedManagerId !== this.savedManagerId
  },

  // 自定义返回：有未保存修改时先确认，避免长表单误触返回丢失编辑。
  onNavBack() {
    if (!this.isDirty()) {
      wx.navigateBack()
      return
    }
    wx.showModal({
      title: '放弃未保存的修改？',
      content: '离开后本次修改将丢失，是否放弃修改并返回？',
      confirmText: '放弃修改',
      cancelText: '继续编辑',
      success: result => {
        if (result.confirm) wx.navigateBack()
      }
    })
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
      updates.selectedAgentId = ''
    }
    this.setData(updates)
  },

  onItlChange(event) {
    const index = Number(event.detail.value)
    this.setData({ itlIndex: index, 'form.itlStatus': this.data.itlOptions[index].value })
  },

  // 行内级别由管理员维护,用户不可修改,点击仅提示。
  onBankLevelTap() {
    wx.showToast({ title: '行内级别请联系管理员修改', icon: 'none' })
  },

  // 行内处室选择:联动刷新其下项目;已选项目不在新处室下时重置。
  onDepartmentChange(event) {
    const index = Number(event.detail.value)
    const department = this.data.departments[index]
    const projectOptions = department ? this.data.projects.filter(item => item.departmentId === department.id) : []
    const keptIndex = projectOptions.findIndex(item => item.name === this.data.form.bankProject)
    const projectIndex = keptIndex >= 0 ? keptIndex : 0
    this.setData({
      departmentIndex: index,
      projectOptions,
      projectIndex,
      'form.department': department ? department.name : '',
      'form.bankProject': projectOptions[projectIndex] ? projectOptions[projectIndex].name : ''
    })
  },

  onProjectChange(event) {
    const index = Number(event.detail.value)
    const project = this.data.projectOptions[index]
    this.setData({ projectIndex: index, 'form.bankProject': project ? project.name : '' })
  },

  onLocationChange(event) {
    const index = Number(event.detail.value)
    const location = this.data.locations[index]
    this.setData({ locationIndex: index, 'form.attendanceLocation': location ? location.name : '' })
  },

  // 审批人分级选择:多列 picker,左列处室、右列该处室人员联动。
  onManagerMultiColumnChange(event) {
    const column = event.detail.column
    if (column !== 0) return
    const deptIndex = event.detail.value
    const dept = this.data.managerDepartments[deptIndex].value
    const filteredManagers = filterByDept(this.data.managers, dept)
    const managerMultiIndex = [deptIndex, 0]
    // 已选人员仍在当前处室时保留选中。
    const kept = filteredManagers.findIndex(item => item.id === this.data.selectedManagerId)
    if (kept >= 0) managerMultiIndex[1] = kept
    this.setData({
      managerMultiRange: [this.data.managerDepartments.map(item => ({ name: item.label, value: item.value })), filteredManagers],
      managerMultiIndex
    })
  },

  onManagerMultiChange(event) {
    const [deptIndex, personIndex] = event.detail.value
    const dept = this.data.managerDepartments[deptIndex].value
    const filteredManagers = filterByDept(this.data.managers, dept)
    const person = filteredManagers[personIndex]
    this.setData({
      selectedManagerDeptIndex: deptIndex,
      filteredManagers,
      selectedManagerIndex: person ? personIndex : -1,
      selectedManagerId: person ? person.id : '',
      managerMultiRange: [this.data.managerDepartments.map(item => ({ name: item.label, value: item.value })), filteredManagers],
      managerMultiIndex: [deptIndex, personIndex]
    })
  },

  // 代理人分级选择:多列 picker,左列处室、右列该处室人员联动。
  onAgentMultiColumnChange(event) {
    const column = event.detail.column
    if (column !== 0) return
    const deptIndex = event.detail.value
    const dept = this.data.agentDepartments[deptIndex].value
    const filteredPeople = filterByDept(this.data.people, dept)
    const agentMultiIndex = [deptIndex, 0]
    // 已选人员仍在当前处室时保留选中。
    const kept = filteredPeople.findIndex(item => item.id === this.data.selectedAgentId)
    if (kept >= 0) agentMultiIndex[1] = kept
    this.setData({
      agentMultiRange: [this.data.agentDepartments.map(item => ({ name: item.label, value: item.value })), filteredPeople],
      agentMultiIndex
    })
  },

  onAgentMultiChange(event) {
    const [deptIndex, personIndex] = event.detail.value
    const dept = this.data.agentDepartments[deptIndex].value
    const filteredPeople = filterByDept(this.data.people, dept)
    const person = filteredPeople[personIndex]
    this.setData({
      selectedAgentDeptIndex: deptIndex,
      filteredPeople,
      selectedAgentIndex: person ? personIndex : -1,
      selectedAgentId: person ? person.id : '',
      agentMultiRange: [this.data.agentDepartments.map(item => ({ name: item.label, value: item.value })), filteredPeople],
      agentMultiIndex: [deptIndex, personIndex]
    })
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
                showError(error, '头像上传失败')
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
    if (form.mobile && !MOBILE_RE.test(form.mobile)) {
      wx.showToast({ title: '请输入 11 位有效手机号', icon: 'none' })
      return
    }
    if (form.emergencyContactPhone && !MOBILE_RE.test(form.emergencyContactPhone)) {
      wx.showToast({ title: '紧急联系人手机号格式不正确', icon: 'none' })
      return
    }
    const agent = this.data.filteredPeople[this.data.selectedAgentIndex]
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
        itlStatus: form.itlStatus,
        workStartDate: form.workStartDate || null,
        mobile: form.mobile || null,
        address: form.address || null,
        emergencyContactName: form.emergencyContactName || null,
        emergencyContactPhone: form.emergencyContactPhone || null
      })
      const manager = this.data.filteredManagers[this.data.selectedManagerIndex]
      const currentManagerId = this.data.profile.manager && this.data.profile.manager.id
      if (manager && manager.id && manager.id !== currentManagerId) {
        await me.setManager(manager.id)
      }
      // 局部更新避免整页重载闪烁:表单即最终态,仅刷新依赖服务端回显的字段。
      const updates = { saving: false, annualLeave: calculateAnnualLeave(form.workStartDate) }
      if (manager && manager.id && manager.id !== currentManagerId) {
        updates['profile.manager'] = { id: manager.id, name: manager.name }
      }
      this.setData(updates)
      this.syncSnapshot()
      wx.showToast({ title: '个人信息已保存', icon: 'success' })
    } catch (error) {
      this.setData({ saving: false })
      showError(error, '保存失败')
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
              showError(error, '签名保存失败')
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
