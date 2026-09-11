const leave = require('../../services/leave')
const overtime = require('../../services/overtime')
const contact = require('../../services/contact')
const situation = require('../../services/situation')
const me = require('../../services/me')
const approval = require('../../services/approval')
const admin = require('../../services/admin')
const holidays = require('../../config/holidays')
const parser = require('../../utils/assistant-parser')
const command = require('../../utils/assistant-command')

function trimDays(value) {
  const num = Number(value)
  return Number.isInteger(num) ? String(num) : String(Math.round(num * 10) / 10)
}

const fallbackTypes = [
  { value: 'comp_time', label: '调休' }, { value: 'annual', label: '年假' },
  { value: 'sick', label: '病假' }, { value: 'personal', label: '事假' },
  { value: 'public_out', label: '公出' }, { value: 'marriage', label: '婚假' },
  { value: 'maternity', label: '产假' }, { value: 'paternity', label: '陪产假' }
]

// 语音输入：使用微信「同声传译」插件（仅语音转文字），未配置时降级为不可用。
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
    voiceMode: false,
    focusKeyboard: false,
    stage: '',
    feedback: '',
    types: fallbackTypes,
    pending: null,
    messages: [],
    scrollIntoView: '',
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
  },

  onUnload() {
    if (this.data.recording && recognitionManager) recognitionManager.stop()
  },

  // 对话列表辅助：commit 统一更新并滚动到底部，appendUser 记录用户输入并结束当前机器人回合。
  nextTailId() {
    this.tailSeq = (this.tailSeq || 0) + 1
    return `tail-${this.tailSeq}`
  },

  commit(messages) {
    const list = messages.slice(-60)
    this.setData({ messages: list, scrollIntoView: this.nextTailId() })
  },

  appendUser(text) {
    this.currentBotKey = undefined
    this.commit(this.data.messages.concat({ role: 'user', text }))
  },

  nextBotKey(messages) {
    const used = new Set((messages || []).filter(item => item.role === 'bot').map(item => item.key))
    let seq = (this.botSeq || 0) + 1
    while (used.has(`bot-${seq}`)) seq += 1
    this.botSeq = seq
    return `bot-${seq}`
  },

  // 结果反馈：同一轮用户操作内的机器人提示复用同一个气泡(running→success 原地刷新)，
  // 新的用户消息(appendUser/choose)会把回合推进到下一个气泡。
  showFeedback(text, tone) {
    const stage = tone === 'success' ? 'success' : tone === 'error' ? 'error' : tone === 'clarify' ? 'clarify' : tone === 'running' ? 'running' : 'parsed'
    const messages = this.data.messages.slice()
    if (this.currentBotKey === undefined) {
      this.currentBotKey = this.nextBotKey(messages)
      messages.push({ key: this.currentBotKey, role: 'bot', text, stage })
    } else {
      const index = messages.findIndex(item => item.key === this.currentBotKey && item.role === 'bot')
      if (index >= 0) {
        messages[index] = Object.assign({}, messages[index], { text, stage })
      } else {
        this.currentBotKey = this.nextBotKey(messages)
        messages.push({ key: this.currentBotKey, role: 'bot', text, stage })
      }
    }
    this.setData({ messages: messages.slice(-60), scrollIntoView: this.nextTailId(), stage, feedback: text })
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
      this.inputDraft = text
      const patch = { recording: false, input: text }
      if (text) {
        // 识别出文字后切回键盘模式,便于确认/修改后发送。
        patch.voiceMode = false
        patch.focusKeyboard = true
        wx.showToast({ title: '识别完成，可确认后发送', icon: 'none' })
      }
      this.setData(patch)
    }
    recognitionManager.onError = res => {
      this.setData({ recording: false })
      wx.showToast({ title: (res && res.msg) || '语音识别失败，请重试', icon: 'none' })
    }
  },

  // 长按录制、松开结束（与微信发语音一致）：按下即 start，抬起即 stop。
  onVoiceStart() {
    if (this.data.running || this.data.recording || !this.data.voiceMode) return
    if (!voiceReady) {
      wx.showModal({
        title: '语音输入未配置',
        content: '请在微信公众平台添加「微信同声传译」插件后重试。',
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    this.inputDraft = ''
    this.setData({ recording: true, input: '' })
    recognitionManager.start({ lang: 'zh_CN', duration: 60000 })
  },

  onVoiceEnd() {
    if (!this.data.recording) return
    recognitionManager.stop()
  },

  // 键盘 / 语音两种输入模式互切：语音模式下输入框变为"按住 说话"。
  // focusKeyboard 只在切回键盘时置 true 唤起输入法，随后在 blur 时复位，
  // 避免在聚焦状态下翻转为 false 造成"键盘弹出又收起"。
  toggleVoiceMode() {
    if (this.data.running || this.data.recording) return
    const voiceMode = !this.data.voiceMode
    this.setData({ voiceMode, focusKeyboard: !voiceMode })
  },

  onKeyboardBlur() {
    if (this.data.focusKeyboard) this.setData({ focusKeyboard: false })
  },

  onInput(event) {
    this.inputDraft = event.detail.value
    this.setData({ input: event.detail.value })
  },

  useExample(event) {
    const input = event.currentTarget.dataset.text
    this.inputDraft = input
    this.setData({ input })
  },

  send() {
    const text = String(this.inputDraft || this.data.input || '').trim()
    if (!text || this.data.running) return
    this.inputDraft = ''
    this.setData({ input: '' })
    // 先展示用户输入消息,再进行解析/执行,保证对话列表可回看。
    this.appendUser(text)
    if (this.data.pending && this.data.pending.allowText) {
      const result = this.data.pending.intent
        ? command.applyChoice(this.data.pending, text, text)
        : parser.applyChoice(this.data.pending, text, { availableTypes: this.data.types })
      this.handleResult(result)
      return
    }
    this.runRuleFlow(text)
  },

  runRuleFlow(text) {
    const results = command.splitTasks(text)
      .map(part => command.parseCommand(part) || parser.parsePrompt(part, { availableTypes: this.data.types }))
      .filter(result => result && result.status !== 'invalid')
    if (results.length === 0) {
      const commandResult = command.parseCommand(text)
      if (commandResult && commandResult.status !== 'invalid') {
        this.handleResult(commandResult)
        return
      }
      const leaveResult = commandResult ? null : parser.parsePrompt(text, { availableTypes: this.data.types })
      if (leaveResult && leaveResult.status !== 'invalid') {
        this.handleResult(leaveResult)
        return
      }
      if (commandResult) {
        // 正则命中了指令但参数有误(如日期不存在),保留规则层的精确报错。
        this.handleResult(commandResult)
        return
      }
      this.handleResult(leaveResult)
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
    this.showFeedback(`检测到 ${results.length} 个任务：\n${lines.join('\n')}\n确认后按顺序执行。`, 'clarify')
    wx.showModal({
      title: `确认执行 ${readyTasks.length} 个任务？`,
      content: lines.join('\n'),
      confirmText: '全部执行',
      cancelText: '取消',
      success: async res => {
        if (!res.confirm) {
          this.showFeedback('已取消执行。', 'error')
          return
        }
        for (const task of readyTasks) {
          // 每个子任务独立成一条机器人结果,避免互相覆盖。
          this.currentBotKey = undefined
          if (task.intent) await this.executeCommand(task)
          else await this.executeLeave(task)
        }
        if (clarifyTasks.length) {
          this.showFeedback(`有 ${clarifyTasks.length} 个任务缺少关键信息，请单独输入后再试。`, 'clarify')
        }
      }
    })
  },

  choose(event) {
    if (!this.data.pending || this.data.running) return
    const label = event.currentTarget.dataset.label
    const value = event.currentTarget.dataset.value
    this.appendUser(label)
    const result = this.data.pending.intent
      ? command.applyChoice(this.data.pending, value, label)
      : parser.applyChoice(this.data.pending, value, { availableTypes: this.data.types })
    this.handleResult(result)
  },

  chooseDate(event) {
    if (!this.data.pending || this.data.running) return
    const value = event.detail.value
    this.appendUser(value)
    const result = this.data.pending.intent
      ? command.applyChoice(this.data.pending, value, value)
      : parser.applyChoice(this.data.pending, value, { availableTypes: this.data.types })
    this.handleResult(result)
  },

  handleResult(result) {
    if (result.status === 'invalid') {
      this.setData({ pending: null })
      this.showFeedback(result.message, 'error')
      return
    }
    if (result.status === 'clarify') {
      this.setData({ pending: result })
      this.showFeedback(result.message, 'clarify')
      return
    }
    this.setData({ pending: null })
    if (result.intent) this.executeCommand(result)
    else this.executeLeave(result)
  },

  async executeLeave(result) {
    this.setData({ running: true })
    this.showFeedback(`已解析：${result.summary}。正在提交申请…`, 'running')
    try {
      const response = await leave.create(parser.toLeaveRequest(result.draft))
      const statusText = response.approvalRequired ? '当前状态为待审批' : '已直接生效'
      let feedback = `办理成功：已提交 ${response.requestedDays} 天申请，${statusText}。`
      if (response.warnings && response.warnings.length) {
        feedback += `\n提醒：${response.warnings.map(item => item.message).join('；')}`
      }
      this.showFeedback(feedback, 'success')
    } catch (error) {
      this.showFeedback(`办理失败：${error.message || '服务暂时不可用，请稍后重试。'}`, 'error')
    } finally {
      this.setData({ running: false })
    }
  },

  async executeCommand(result) {
    this.setData({ running: true })
    try {
      const response = await this.runCommand(result.intent, result.slots || {})
      if (response) this.showFeedback(response, 'success')
    } catch (error) {
      this.showFeedback(`办理失败：${error.message || '服务暂时不可用，请稍后重试。'}`, 'error')
    } finally {
      this.setData({ running: false })
    }
  },

  async runCommand(intent, slots) {
    if (intent === 'overtime_create') {
      const result = await overtime.create({ date: slots.date, offTime: slots.offTime, hours: slots.hours, content: slots.content })
      if (result.status === 'pending' || result.approvalRequired) {
        return `办理成功：已提交 ${slots.date} 加班申请，当前状态为待审批，通过后才产生调休额度。`
      }
      return `办理成功：已登记 ${slots.date} 加班 ${result.hours} 小时，调休额度有效期至 ${result.expiresAt}。`
    }
    if (intent === 'overtime_balance') {
      const result = await overtime.balance()
      return `你当前有 ${result.availableHours} 小时可用调休${result.nearestExpiry ? `，最近一笔将于 ${result.nearestExpiry} 到期` : ''}。`
    }
    if (intent === 'annual_balance') {
      const [profile, listResult] = await Promise.all([me.get(), leave.list()])
      const entitlement = profile.annualLeave ? profile.annualLeave.annualLeaveDays : 0
      const year = new Date().getFullYear()
      const yearStart = `${year}-01-01`
      const yearEnd = `${year}-12-31`
      const used = (listResult.requests || []).reduce((total, request) => {
        if (request.leaveType !== 'annual' || (request.status !== 'pending' && request.status !== 'approved')) return total
        const start = request.startDate > yearStart ? request.startDate : yearStart
        const end = request.endDate < yearEnd ? request.endDate : yearEnd
        if (start > end) return total
        const rangeTotal = holidays.countWorkdays(request.startDate, request.endDate)
        const overlap = holidays.countWorkdays(start, end)
        const ratio = rangeTotal > 0 ? overlap / rangeTotal : 1
        return total + (request.requestedDays || 0) * ratio
      }, 0)
      const remaining = Math.max(0, entitlement - used)
      return `你当前年假共 ${trimDays(entitlement)} 天，已申请 ${trimDays(used)} 天，剩余 ${trimDays(remaining)} 天。`
    }
    if (intent === 'overtime_list') {
      const result = await overtime.list()
      const records = result.records || []
      const labels = { active: '可用', pending: '待审批', rejected: '已驳回', consumed: '已用完', revoked: '已撤销', expired: '已到期' }
      return records.length ? `最近的加班记录：\n${records.slice(0, 8).map(item => `${item.date} · ${item.hours}小时 · ${item.content} · ${labels[item.status] || item.status}`).join('\n')}` : '你还没有加班记录。'
    }
    if (intent === 'overtime_revoke') return this.revokeOvertime(slots)
    if (intent === 'leave_list') {
      const result = await leave.list()
      const records = result.requests || []
      const labels = { pending: '待审批', approved: '已通过', rejected: '已驳回', cancelled: '已撤销' }
      return records.length ? `最近的请假记录：\n${records.slice(0, 8).map(item => `${item.startDate}${item.endDate !== item.startDate ? ` 至 ${item.endDate}` : ''} · ${item.leaveTypeLabel} · ${item.requestedDays}天 · ${labels[item.status] || item.status}`).join('\n')}` : '你还没有请假记录。'
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
      return '办理成功：加班记录已撤销。'
    }
    if (intent === 'leave_cancel_select') {
      await leave.cancel(slots.id)
      return '办理成功：请假申请已撤销。'
    }
    if (intent === 'agent_set_select') {
      await me.setAgent(slots.id)
      return `办理成功：工作代理人已设置为 ${slots.label || '所选人员'}。`
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
    if (!leaves.length && !overtimeRecords.length) return `${name || slots.date}在 ${slots.date} 没有查询到${slots.activity === 'overtime' ? '加班' : slots.activity === 'leave' ? '请假' : '请假或加班'}记录。`
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
    const lines = records.slice(0, 10).map(item => {
      const name = item.applicantName || (item.applicant && item.applicant.name) || '未命名用户'
      if (item.bizType === 'overtime') return `${name} · 加班 · ${item.date} · ${item.hours}小时`
      return `${name} · ${item.leaveTypeLabel} · ${item.startDate} 至 ${item.endDate} · ${item.requestedDays}天`
    })
    return `${history ? '最近审批历史' : '待审批申请'}：\n${lines.join('\n')}`
  },

  async revokeOvertime(slots) {
    const result = await overtime.list()
    let records = (result.records || []).filter(item => item.canRevoke)
    if (slots.date) records = records.filter(item => item.date === slots.date)
    if (!records.length) return slots.date ? `${slots.date} 没有可撤销的加班记录。` : '没有可撤销的加班记录。'
    if (records.length === 1) {
      const item = records[0]
      const pending = item.status === 'pending'
      const confirmed = await new Promise(resolve => {
        wx.showModal({
          title: pending ? '撤回申请' : '撤销加班',
          content: pending
            ? `${item.date} · ${item.hours}小时${item.content ? ` · ${item.content}` : ''}\n确认撤回这条待审批的加班申请？`
            : `${item.date} · ${item.hours}小时${item.content ? ` · ${item.content}` : ''}\n撤销后将移除对应调休额度，是否继续？`,
          confirmText: pending ? '确认撤回' : '确认撤销',
          cancelText: '取消',
          success: res => resolve(!!res.confirm),
          fail: () => resolve(false)
        })
      })
      if (!confirmed) {
        this.showFeedback('已取消操作。', 'error')
        return ''
      }
      await overtime.revoke(item.id)
      return `办理成功：加班记录已${pending ? '撤回' : '撤销'}。`
    }
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
      this.showFeedback(pending.message, 'clarify')
      return ''
    }
    if (slots.action === 'reject' && !slots.reason) {
      this.setData({ pending: { status: 'clarify', intent: 'approval_select', slots, field: 'reason', message: '驳回申请必须填写原因，请直接输入原因。', choices: [], allowText: true } })
      this.showFeedback('驳回申请必须填写原因，请直接输入原因。', 'clarify')
      return ''
    }
    if (!slots.id) {
      const result = await approval.pending()
      let records = result.approvals || []
      if (slots.name) records = records.filter(item => (item.applicant && item.applicant.name || '').includes(slots.name))
      return this.selectRecord(records, 'approval_select', '请选择要处理的审批申请。', item => {
        const name = item.applicant && item.applicant.name || '未命名用户'
        if (item.bizType === 'overtime') return `${name} · 加班 · ${item.date} · ${item.hours}小时`
        return `${name} · ${item.leaveTypeLabel} · ${item.startDate} 至 ${item.endDate}`
      }, slots)
    }
    await approval.decide(slots.id, slots.action, slots.reason || '')
    return `办理成功：申请已${slots.action === 'approve' ? '通过' : '驳回'}。`
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
    return `办理成功：用户${slots.status ? (slots.status === 'active' ? '已启用' : '已停用') : '角色已更新'}。`
  },

  selectRecord(records, intent, message, formatter, baseSlots) {
    if (!records.length) return '没有找到符合条件且可操作的记录。'
    const choices = records.slice(0, 10).map(item => ({ label: formatter(item), value: item.id }))
    const pending = { status: 'clarify', intent, slots: Object.assign({}, baseSlots), field: 'id', message, choices }
    this.setData({ pending })
    this.showFeedback(message, 'clarify')
    return ''
  },

  // 对话列表更新与机器人提示语复用 showFeedback/commit（上部统一实现）。
})