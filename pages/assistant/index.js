const leave = require('../../services/leave')
const overtime = require('../../services/overtime')
const contact = require('../../services/contact')
const situation = require('../../services/situation')
const me = require('../../services/me')
const approval = require('../../services/approval')
const admin = require('../../services/admin')
const parser = require('../../utils/assistant-parser')
const command = require('../../utils/assistant-command')
const ai = require('../../services/ai')

const fallbackTypes = [
  { value: 'comp_time', label: '调休' }, { value: 'annual', label: '年假' },
  { value: 'sick', label: '病假' }, { value: 'personal', label: '事假' },
  { value: 'public_out', label: '公出' }, { value: 'marriage', label: '婚假' },
  { value: 'maternity', label: '产假' }, { value: 'paternity', label: '陪产假' }
]

// 语音识别：使用微信「同声传译」插件，未配置时降级为不可用。
let recognitionManager = null
let voiceReady = false
function setupRecognition() {
  if (voiceReady) return true
  try {
    const plugin = requirePlugin('WechatSI')
    recognitionManager = plugin.getRecordRecognitionManager()
    voiceReady = true
    return true
  } catch (error) {
    return false
  }
}

Page({
  data: {
    input: '',
    running: false,
    recording: false,
    types: fallbackTypes,
    pending: null,
    aiAgentEnabled: false,
    messages: [
      { id: 1, role: 'assistant', text: '你好，我是简序日程助手。可以帮你办理请假与加班，也能查询员工情况、通讯录、个人记录，或处理权限范围内的审批和用户管理任务。' }
    ],
    examples: ['8月13号请一天调休假', '今天登记加班2小时，内容：生产发布', '查询张三的电话', '张三今天是否请假']
  },

  async onLoad() {
    this.inputDraft = ''
    this.setupVoice()
    try {
      const result = await leave.types()
      if (result.types && result.types.length) this.setData({ types: result.types })
    } catch (error) {
      // 离线时仍允许体验指令判断，真正执行时由请求层展示失败原因。
    }
    try {
      const profile = await me.get()
      this.setData({ aiAgentEnabled: Boolean(profile.aiAgentEnabled) })
    } catch (error) {
      // 开关状态获取失败不影响指令功能,仅退化为纯规则模式。
    }
  },

  onUnload() {
    if (this.data.recording && recognitionManager) recognitionManager.stop()
  },

  setupVoice() {
    if (!setupRecognition()) return
    recognitionManager.onRecognize = res => {
      if (res && res.result) {
        this.inputDraft = res.result
        this.setData({ input: res.result })
      }
    }
    recognitionManager.onStop = res => {
      const text = String(res && res.result || '').trim()
      this.setData({ recording: false, input: text })
      this.inputDraft = text
      if (text) wx.showToast({ title: '识别完成，可确认后发送', icon: 'none' })
    }
    recognitionManager.onError = res => {
      this.setData({ recording: false })
      wx.showToast({ title: (res && res.msg) || '语音识别失败，请重试', icon: 'none' })
    }
  },

  toggleVoice() {
    if (this.data.running) return
    if (!voiceReady) {
      wx.showToast({ title: '语音输入未配置，请在公众平台添加「微信同声传译」插件', icon: 'none' })
      return
    }
    if (this.data.recording) {
      recognitionManager.stop()
      return
    }
    this.inputDraft = ''
    this.setData({ recording: true, input: '' })
    recognitionManager.start({ lang: 'zh_CN', duration: 60000 })
  },

  // 深度问答开关:整行点击切换,自绘开关样式随 aiAgentEnabled 数据变化。
  toggleAiAgent() {
    if (this.aiToggleLock) return
    this.aiToggleLock = true
    this.applyAiAgent(!this.data.aiAgentEnabled)
  },

  async applyAiAgent(enabled) {
    const previous = this.data.aiAgentEnabled
    if (enabled === previous) {
      this.aiToggleLock = false
      return
    }
    this.setData({ aiAgentEnabled: enabled })
    try {
      await me.setAiAgent(enabled)
      wx.showToast({ title: enabled ? '深度问答已开启' : '深度问答已关闭', icon: 'none' })
    } catch (error) {
      this.setData({ aiAgentEnabled: previous })
      wx.showToast({ title: error.message || '设置失败，请重试', icon: 'none' })
    } finally {
      this.aiToggleLock = false
    }
  },

  onInput(event) {
    this.inputDraft = event.detail.value
  },

  useExample(event) {
    const input = event.currentTarget.dataset.text
    this.inputDraft = input
    this.setData({ input })
  },

  send() {
    const text = String(this.inputDraft || this.data.input || '').trim()
    if (!text || this.data.running) return
    this.appendMessage('user', text)
    this.inputDraft = ''
    this.setData({ input: '' })
    if (this.data.pending && this.data.pending.allowText) {
      const result = command.applyChoice(this.data.pending, text, text)
      this.handleResult(result)
      return
    }
    const results = command.splitTasks(text)
      .map(part => command.parseCommand(part) || parser.parsePrompt(part, { availableTypes: this.data.types }))
      .filter(result => result && result.status !== 'invalid')
    if (results.length === 0) {
      // 开启 AI 深度问答后,指令与请假语料都没命中的输入转交大模型;命中但参数有误(如日期不存在)仍走规则层的具体报错。
      const commandResult = command.parseCommand(text)
      if (!commandResult) {
        const leaveResult = parser.parsePrompt(text, { availableTypes: this.data.types })
        if (leaveResult.status !== 'invalid') {
          this.handleResult(leaveResult)
          return
        }
        if (this.data.aiAgentEnabled) {
          this.askAi(text)
          return
        }
        this.handleResult(leaveResult)
        return
      }
      this.handleResult(commandResult)
      return
    }
    if (results.length === 1) {
      this.handleResult(results[0])
      return
    }
    this.runMultiple(results)
  },

  // 多任务：列出全部子任务，确认后顺序执行。
  runMultiple(results) {
    const readyTasks = results.filter(result => result.status === 'ready')
    const clarifyTasks = results.filter(result => result.status === 'clarify')
    const lines = readyTasks.map((task, index) => `${index + 1}. ${task.summary || task.intent || '请假'}`)
    if (clarifyTasks.length) lines.push(`（另有 ${clarifyTasks.length} 个任务缺少关键信息，请单独处理）`)
    this.appendMessage('assistant', `检测到 ${results.length} 个任务：\n${lines.join('\n')}\n确认后我将按顺序执行。`, 'clarify')
    wx.showModal({
      title: `确认执行 ${readyTasks.length} 个任务？`,
      content: lines.join('\n'),
      confirmText: '全部执行',
      cancelText: '取消',
      success: async res => {
        if (!res.confirm) {
          this.appendMessage('assistant', '已取消执行。', 'error')
          return
        }
        for (const task of readyTasks) {
          if (task.intent) await this.executeCommand(task)
          else await this.executeLeave(task)
        }
        if (clarifyTasks.length) {
          this.appendMessage('assistant', `有 ${clarifyTasks.length} 个任务缺少关键信息，请单独输入后再试。`, 'clarify')
        }
      }
    })
  },

  choose(event) {
    if (!this.data.pending || this.data.running) return
    const label = event.currentTarget.dataset.label
    const value = event.currentTarget.dataset.value
    this.appendMessage('user', label)
    const result = this.data.pending.intent
      ? command.applyChoice(this.data.pending, value, label)
      : parser.applyChoice(this.data.pending, value, { availableTypes: this.data.types })
    this.handleResult(result)
  },

  chooseDate(event) {
    if (!this.data.pending || this.data.running) return
    const value = event.detail.value
    this.appendMessage('user', value)
    const result = this.data.pending.intent
      ? command.applyChoice(this.data.pending, value, value)
      : parser.applyChoice(this.data.pending, value, { availableTypes: this.data.types })
    this.handleResult(result)
  },

  handleResult(result) {
    if (result.status === 'invalid') {
      this.setData({ pending: null })
      this.appendMessage('assistant', result.message, 'error')
      return
    }
    if (result.status === 'clarify') {
      this.setData({ pending: result })
      this.appendMessage('assistant', result.message, 'clarify')
      return
    }
    this.setData({ pending: null })
    if (result.intent) this.executeCommand(result)
    else this.executeLeave(result)
  },

  async executeLeave(result) {
    this.setData({ running: true })
    this.appendMessage('assistant', `已理解：${result.summary}。正在自动提交申请…`, 'running')
    try {
      const response = await leave.create(parser.toLeaveRequest(result.draft))
      this.appendMessage('assistant', `任务执行成功：已提交 ${response.requestedDays} 天申请，当前状态为待审批。`, 'success')
    } catch (error) {
      this.appendMessage('assistant', `任务执行失败：${error.message || '服务暂时不可用，请稍后重试。'}`, 'error')
    } finally {
      this.setData({ running: false })
    }
  },

  async executeCommand(result) {
    this.setData({ running: true })
    try {
      const response = await this.runCommand(result.intent, result.slots || {})
      if (response) this.appendMessage('assistant', response, 'success')
    } catch (error) {
      this.appendMessage('assistant', `任务执行失败：${error.message || '服务暂时不可用，请稍后重试。'}`, 'error')
    } finally {
      this.setData({ running: false })
    }
  },

  async runCommand(intent, slots) {
    if (intent === 'overtime_create') {
      const result = await overtime.create({ date: slots.date, hours: slots.hours, content: slots.content })
      return `任务执行成功：已登记 ${slots.date} 加班 ${result.hours} 小时，调休额度有效期至 ${result.expiresAt}。`
    }
    if (intent === 'overtime_balance') {
      const result = await overtime.balance()
      return `你当前有 ${result.availableHours} 小时可用调休${result.nearestExpiry ? `，最近一笔将于 ${result.nearestExpiry} 到期` : ''}。`
    }
    if (intent === 'overtime_list') {
      const result = await overtime.list()
      const records = result.records || []
      return records.length ? `最近的加班记录：\n${records.slice(0, 8).map(item => `${item.date} · ${item.hours}小时 · ${item.content} · ${item.status}`).join('\n')}` : '你还没有加班记录。'
    }
    if (intent === 'overtime_revoke') return this.revokeOvertime(slots)
    if (intent === 'leave_list') {
      const result = await leave.list()
      const records = result.requests || []
      return records.length ? `最近的请假记录：\n${records.slice(0, 8).map(item => `${item.startDate}${item.endDate !== item.startDate ? ` 至 ${item.endDate}` : ''} · ${item.leaveTypeLabel} · ${item.requestedDays}天 · ${item.status}`).join('\n')}` : '你还没有请假记录。'
    }
    if (intent === 'leave_cancel') return this.cancelLeave(slots)
    if (intent === 'leave_result') return this.openLeaveResult()
    if (intent === 'contact_query') return this.queryContacts(slots)
    if (intent === 'situation_query') return this.querySituation(slots)
    if (intent === 'profile_query') return this.queryProfile()
    if (intent === 'profile_open') {
      wx.navigateTo({ url: '/pages/profile/index' })
      return '已为你打开个人信息页，可修改完整资料、头像和审批签名。'
    }
    if (intent === 'agent_set') return this.setAgent(slots)
    if (intent === 'approval_pending') return this.queryApprovals(false)
    if (intent === 'approval_history') return this.queryApprovals(true)
    if (intent === 'approval_decide') return this.decideApproval(slots)
    if (intent === 'admin_users') return this.queryUsers()
    if (intent === 'admin_update') return this.updateUser(slots)
    if (intent === 'admin_update_select') return this.applyUserUpdate(slots)
    if (intent === 'navigate') {
      wx.navigateTo({ url: slots.url })
      return `已为你打开${slots.label}页面。`
    }
    if (intent === 'overtime_revoke_select') {
      await overtime.revoke(slots.id)
      return '任务执行成功：加班记录已撤销。'
    }
    if (intent === 'leave_cancel_select') {
      await leave.cancel(slots.id)
      return '任务执行成功：请假申请已撤销。'
    }
    if (intent === 'agent_set_select') {
      await me.setAgent(slots.id)
      return `任务执行成功：工作代理人已设置为 ${slots.label || '所选人员'}。`
    }
    if (intent === 'approval_select') return this.decideApproval(slots)
    throw new Error('暂不支持这项操作')
  },

  async queryContacts(slots) {
    const result = await contact.list()
    let matches = result.contacts || []
    if (slots.name) matches = matches.filter(item => item.name.includes(slots.name) || (item.accountName || '').includes(slots.name))
    if (slots.system) matches = matches.filter(item => item.systemName.includes(slots.system))
    if (!matches.length) return `通讯录中没有找到“${slots.name || slots.system || ''}”相关人员。`
    return matches.slice(0, 10).map(item => `${item.name} · ${item.systemName} · ${item.personnelTypeLabel} · 电话：${item.mobile || '未配置'}`).join('\n')
  },

  async querySituation(slots) {
    const result = await situation.month(command.monthOf(slots.date))
    const name = slots.name
    let leaves = (result.leaves || []).filter(item => item.date === slots.date)
    let overtimeRecords = (result.overtime || []).filter(item => item.date === slots.date)
    if (name) {
      leaves = leaves.filter(item => item.name.includes(name))
      overtimeRecords = overtimeRecords.filter(item => item.name.includes(name))
    }
    if (slots.activity === 'leave') overtimeRecords = []
    if (slots.activity === 'overtime') leaves = []
    if (!leaves.length && !overtimeRecords.length) return `${name || slots.date}在 ${slots.date} 没有查询到${slots.activity === 'overtime' ? '加班' : slots.activity === 'leave' ? '已批准请假' : '请假或加班'}记录。`
    const lines = []
    leaves.forEach(item => lines.push(`${item.name}：${item.leaveTypeLabel}（${item.periodLabel}）`))
    overtimeRecords.forEach(item => lines.push(`${item.name}：加班 ${item.hours} 小时，${item.content}`))
    return `${slots.date} 员工情况：\n${lines.join('\n')}`
  },

  async queryProfile() {
    const profile = await me.get()
    return [
      `姓名：${profile.name || '未填写'}`,
      `人员类型：${profile.personnelType || '未配置'}`,
      `部门/项目：${profile.department || profile.bankProject || '未配置'}`,
      `审批人：${profile.manager && profile.manager.name || '未配置'}`,
      `工作代理人：${profile.agent && profile.agent.name || '未配置'}`,
      `年假：${profile.annualLeave ? profile.annualLeave.annualLeaveDays : 0} 天`,
      `电话：${profile.mobile || '未配置'}`
    ].join('\n')
  },

  async queryApprovals(history) {
    const result = history ? await approval.history() : await approval.pending()
    const records = result.approvals || []
    if (!records.length) return history ? '暂无审批历史。' : '当前没有待审批申请。'
    return `${history ? '最近审批历史' : '待审批申请'}：\n${records.slice(0, 10).map(item => `${item.applicantName || (item.applicant && item.applicant.name) || '未命名用户'} · ${item.leaveTypeLabel} · ${item.startDate} 至 ${item.endDate} · ${item.requestedDays}天`).join('\n')}`
  },

  async revokeOvertime(slots) {
    const result = await overtime.list()
    let records = (result.records || []).filter(item => item.canRevoke)
    if (slots.date) records = records.filter(item => item.date === slots.date)
    return this.selectRecord(records, 'overtime_revoke_select', '请选择要撤销的加班记录。', item => `${item.date} · ${item.hours}小时 · ${item.content}`)
  },

  async cancelLeave(slots) {
    const result = await leave.list()
    let records = (result.requests || []).filter(item => item.status === 'pending' || item.status === 'approved')
    if (slots.date) records = records.filter(item => item.startDate <= slots.date && item.endDate >= slots.date)
    return this.selectRecord(records, 'leave_cancel_select', '请选择要撤销的请假申请。', item => `${item.leaveTypeLabel} · ${item.startDate} 至 ${item.endDate}`)
  },

  async setAgent(slots) {
    const result = await me.people()
    let people = result.people || []
    if (slots.name) people = people.filter(item => (item.name || '').includes(slots.name))
    return this.selectRecord(people, 'agent_set_select', '请选择要设置的工作代理人。', item => `${item.name || '未命名用户'}${item.employeeNo ? ` · ${item.employeeNo}` : ''}`)
  },

  async decideApproval(slots) {
    if (slots.id && !slots.action) {
      const pending = {
        status: 'clarify', intent: 'approval_action', slots, field: 'action',
        message: '要如何处理这条申请？',
        choices: [
          { label: '通过申请', value: 'approve' },
          { label: '驳回申请', value: 'reject' }
        ]
      }
      this.setData({ pending })
      this.appendMessage('assistant', pending.message, 'clarify')
      return ''
    }
    if (slots.action === 'reject' && !slots.reason) {
      this.setData({ pending: { status: 'clarify', intent: 'approval_select', slots, field: 'reason', message: '驳回申请必须填写原因，请直接输入原因。', choices: [], allowText: true } })
      this.appendMessage('assistant', '驳回申请必须填写原因，请直接输入原因。', 'clarify')
      return ''
    }
    if (!slots.id) {
      const result = await approval.pending()
      let records = result.approvals || []
      if (slots.name) records = records.filter(item => (item.applicant && item.applicant.name || '').includes(slots.name))
      return this.selectRecord(records, 'approval_select', '请选择要处理的审批申请。', item => `${item.applicant && item.applicant.name || '未命名用户'} · ${item.leaveTypeLabel} · ${item.startDate} 至 ${item.endDate}`, slots)
    }
    await approval.decide(slots.id, slots.action, slots.reason || '')
    return `任务执行成功：申请已${slots.action === 'approve' ? '通过' : '驳回'}。`
  },

  async queryUsers() {
    const result = await admin.users()
    return (result.users || []).slice(0, 20).map(item => `${item.name || '未命名用户'} · ${item.employeeNo || '无工号'} · ${item.role} · ${item.status}`).join('\n') || '暂无用户。'
  },

  async openLeaveResult() {
    const result = await leave.list()
    const records = (result.requests || []).filter(item => item.status === 'approved')
    if (!records.length) return '目前没有已通过的请假申请，无法查看审批结果。'
    wx.navigateTo({ url: '/pages/leave/index' })
    return '已打开请假页面，请在已通过的申请中点击“审批结果”，可复制内容或下载 PDF。'
  },

  async updateUser(slots) {
    if (!slots.status && !slots.role) return '请明确要修改用户的状态或角色。'
    const result = await admin.users()
    let users = result.users || []
    if (slots.name) users = users.filter(item => (item.name || '').includes(slots.name))
    const description = slots.status ? (slots.status === 'active' ? '启用' : '停用') : `设为${slots.role === 'user' ? '普通用户' : slots.role === 'admin' ? '管理员' : '超级管理员'}`
    return this.selectRecord(users, 'admin_update_select', `请选择要${description}的用户。`, item => `${item.name || '未命名用户'} · ${item.employeeNo || '无工号'} · ${item.role} · ${item.status}`, slots)
  },

  async applyUserUpdate(slots) {
    const data = {}
    if (slots.status) data.status = slots.status
    if (slots.role) data.role = slots.role
    await admin.updateUser(slots.id, data)
    return `任务执行成功：用户${slots.status ? (slots.status === 'active' ? '已启用' : '已停用') : '角色已更新'}。`
  },

  selectRecord(records, intent, message, formatter, baseSlots) {
    if (!records.length) return '没有找到符合条件且可操作的记录。'
    const choices = records.slice(0, 10).map(item => ({ label: formatter(item), value: item.id }))
    const pending = { status: 'clarify', intent, slots: Object.assign({}, baseSlots), field: 'id', message, choices }
    this.setData({ pending })
    this.appendMessage('assistant', message, 'clarify')
    return ''
  },

  // AI 深度问答:大模型输出只作为回答文本展示,不解析为指令,系统操作永远走上面的规则执行路径。
  async askAi(text) {
    this.setData({ running: true })
    const history = this.data.messages
      .filter(item => item.tone !== 'error')
      .slice(-10)
      .map(item => ({ role: item.role, content: item.text }))
    const placeholderId = Date.now() + Math.random()
    this.appendMessage('assistant', '正在思考…', 'running')
    try {
      const result = await ai.chat(history.concat({ role: 'user', content: text }))
      this.replaceMessage(placeholderId, result.reply)
    } catch (error) {
      this.replaceMessage(placeholderId, error.message || 'AI 暂时不可用，请稍后重试。', 'error')
    } finally {
      this.setData({ running: false })
      setTimeout(() => this.setData({ scrollIntoView: `message-${this.data.messages.length - 1}` }), 30)
    }
  },

  appendMessage(role, text, tone) {
    const messages = this.data.messages.concat({ id: Date.now() + Math.random(), role, text, tone: tone || '' })
    this.setData({ messages })
    setTimeout(() => this.setData({ scrollIntoView: `message-${messages.length - 1}` }), 30)
  },

  replaceMessage(id, text, tone) {
    const messages = this.data.messages.map(item => item.id === id ? Object.assign({}, item, { text, tone: tone || '' }) : item)
    this.setData({ messages })
  }
})
