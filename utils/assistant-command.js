const { formatDate } = require('./assistant-parser')

function pad(value) { return String(value).padStart(2, '0') }

function shiftDate(date, days) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  result.setDate(result.getDate() + days)
  return result
}

function validDate(year, month, day) {
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

function parseDate(text, now = new Date()) {
  if (/后天/.test(text)) return formatDate(shiftDate(now, 2))
  if (/明天/.test(text)) return formatDate(shiftDate(now, 1))
  if (/今天|今日/.test(text)) return formatDate(now)
  if (/昨天/.test(text)) return formatDate(shiftDate(now, -1))
  const iso = text.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/)
  const cn = text.match(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})[日号]?/)
  const match = iso || cn
  if (!match) return null
  const date = validDate(Number(match[1] || now.getFullYear()), Number(match[2]), Number(match[3]))
  return date ? formatDate(date) : 'invalid'
}

function cleanName(value) {
  return String(value || '').replace(/^(查一下|查询|查看|查|看看)/, '').replace(/(的)?(联系方式|联系信息|联系电话|手机号|手机|电话|是否请假|有没有请假|是否加班|有没有加班).*$/, '').trim()
}

function parseOvertime(text, now) {
  const date = parseDate(text, now)
  if (date === 'invalid') return { status: 'invalid', message: '日期不存在，请检查后重试。' }
  const hoursMatch = text.match(/(\d)\s*(?:个)?小时/)
  const contentMatch = text.match(/(?:工作内容|内容|事项|事由)(?:是|为|[:：])?(.+)$/)
  const slots = {
    date,
    hours: hoursMatch ? Number(hoursMatch[1]) : null,
    content: contentMatch ? contentMatch[1].trim() : ''
  }
  if (!slots.date) return clarify('overtime_create', slots, 'date', '哪一天加班？请选择日期。', [], true)
  if (!slots.hours) return clarify('overtime_create', slots, 'hours', '加班几小时？请选择 2 至 6 个整小时。', [2, 3, 4, 5, 6].map(value => ({ label: `${value}小时`, value })))
  if (slots.hours < 2 || slots.hours > 6) return { status: 'invalid', message: '加班时长须为 2 至 6 个整小时。' }
  if (!slots.content) return clarify('overtime_create', slots, 'content', '还缺少加班工作内容，请直接输入，例如“内容：生产发布支持”。', [])
  return { status: 'ready', intent: 'overtime_create', slots, summary: `登记加班 · ${slots.date} · ${slots.hours}小时 · ${slots.content}` }
}

function clarify(intent, slots, field, message, choices, allowDatePicker) {
  return { status: 'clarify', intent, slots, field, message, choices: choices || [], allowDatePicker: Boolean(allowDatePicker), allowText: !(choices && choices.length) && !allowDatePicker }
}

function parseCommand(input, options = {}) {
  const raw = String(input || '').trim()
  const text = raw.replace(/\s+/g, '')
  const now = options.now || new Date()
  if (!text) return { status: 'invalid', message: '请输入要执行或查询的任务。' }

  const directRoutes = [
    { feature: /通讯录/, url: '/pages/contact/index', label: '通讯录' },
    { feature: /员工情况|人员情况/, url: '/pages/situation/index', label: '员工情况' },
    { feature: /加班|值班/, url: '/pages/duty/index', label: '加班登记' },
    { feature: /请假/, url: '/pages/leave/index', label: '请假' },
    { feature: /审批/, url: '/pages/approval/index', label: '审批' },
    { feature: /用户管理/, url: '/pages/admin/users', label: '用户管理' }
  ]
  if (/打开|进入|前往|跳转|去/.test(text)) {
    const route = directRoutes.find(item => item.feature.test(text))
    if (route) return { status: 'ready', intent: 'navigate', slots: route }
  }

  if (/(登记|记录|新增|添加|补录).{0,4}加班|加班\d.*小时/.test(text)) return parseOvertime(raw, now)
  if (/调休余额|可用调休|还有多少调休|调休额度/.test(text)) return { status: 'ready', intent: 'overtime_balance', slots: {} }
  if (/我的加班|加班记录|加班历史/.test(text)) return { status: 'ready', intent: 'overtime_list', slots: {} }
  if (/撤销|取消/.test(text) && /加班/.test(text)) return { status: 'ready', intent: 'overtime_revoke', slots: { date: parseDate(text, now) } }

  if (/撤销|取消/.test(text) && /(请假|调休|年假|病假|事假)/.test(text)) return { status: 'ready', intent: 'leave_cancel', slots: { date: parseDate(text, now) } }
  if (/审批结果|请假单|下载.*PDF|PDF.*请假/.test(text)) return { status: 'ready', intent: 'leave_result', slots: {} }
  if (/我的请假|请假记录|请假进度|请假状态/.test(text)) return { status: 'ready', intent: 'leave_list', slots: {} }

  if (/待审批|待我审批|审批列表/.test(text)) return { status: 'ready', intent: 'approval_pending', slots: {} }
  if (/审批历史|已审批/.test(text)) return { status: 'ready', intent: 'approval_history', slots: {} }
  if (/(通过|同意|批准|驳回|拒绝).*(申请|请假)|审批.*(通过|同意|批准|驳回|拒绝)/.test(text)) {
    const reject = /驳回|拒绝/.test(text)
    const reason = reject ? ((raw.match(/(?:原因|理由)(?:是|为|[:：])?(.+)$/) || [])[1] || '').trim() : ''
    const nameMatch = text.match(/(?:通过|同意|批准|驳回|拒绝)([\u4e00-\u9fa5·]{2,20}?)(?:的)?(?:申请|请假)/) || text.match(/审批([\u4e00-\u9fa5·]{2,20}?)(?:的)?(?:申请|请假)/)
    return { status: 'ready', intent: 'approval_decide', slots: { action: reject ? 'reject' : 'approve', name: nameMatch && nameMatch[1] || '', reason } }
  }
  if (/^(?:我要|帮我|请)?审批(?:一下)?(?:[\u4e00-\u9fa5·]{2,20}的?)?(?:请假|申请)?$|处理(?:一下)?请假申请/.test(text)) {
    const nameMatch = text.match(/审批(?:一下)?([\u4e00-\u9fa5·]{2,20}?)(?:的)?(?:请假|申请)$/)
    return { status: 'ready', intent: 'approval_decide', slots: { action: '', name: nameMatch && nameMatch[1] || '', reason: '' } }
  }

  if (/(修改|编辑|维护|完善).*(个人信息|我的资料)|(设置|修改).*(头像|签名)/.test(text)) return { status: 'ready', intent: 'profile_open', slots: {} }
  if (/我的信息|个人信息|我的资料|我的审批人|我的代理人|我的年假/.test(text)) return { status: 'ready', intent: 'profile_query', slots: {} }
  if (/用户列表|所有用户|用户信息/.test(text)) return { status: 'ready', intent: 'admin_users', slots: {} }

  if (/联系方式|联系信息|联系电话|手机号|手机|电话|通讯录|联系人|(?:查询|查看|查).+(?:资料|信息)/.test(text)) {
    const systemMatch = raw.match(/(?:查|查看|查询)?(.+?)(?:系统|项目)(?:的)?(?:联系人|通讯录|联系方式)/)
    let name = /通讯录|联系人/.test(text) && systemMatch ? '' : cleanName(raw)
    name = name.replace(/的?(?:资料|信息)$/, '')
    return { status: 'ready', intent: 'contact_query', slots: { name, system: systemMatch && systemMatch[1].trim() } }
  }

  if (/(是否|有没有|有没|谁|哪些人|人员|情况).*(请假|加班)|(请假|加班).*(是否|有没有|有没|谁|哪些人|人员|情况)/.test(text)) {
    const date = parseDate(text, now)
    if (date === 'invalid') return { status: 'invalid', message: '日期不存在，请检查后重试。' }
    const activity = /加班/.test(text) && !/请假/.test(text) ? 'overtime' : /请假/.test(text) && !/加班/.test(text) ? 'leave' : 'all'
    const nameMatch = text.match(/([\u4e00-\u9fa5·]{2,20})(?:在)?(?:今天|明天|后天|昨天|20\d{2}年|\d{1,2}月).*(?:是否|有没有|有没)/) || text.match(/^([\u4e00-\u9fa5·]{2,20})(?:是否|有没有|有没)/)
    let name = nameMatch && nameMatch[1] || ''
    if (name && /^(谁|哪些人|人员|员工|大家)$/.test(name)) name = ''
    const slots = { date, activity, name }
    if (!date) return clarify('situation_query', slots, 'date', '要查看哪一天的员工情况？', [], true)
    return { status: 'ready', intent: 'situation_query', slots }
  }

  if (/设置|修改|更换/.test(text) && /代理人/.test(text)) {
    const match = raw.match(/代理人(?:设置|修改|更换)?(?:成|为|是)?\s*([\u4e00-\u9fa5·]{2,20})/)
    return { status: 'ready', intent: 'agent_set', slots: { name: match && match[1] } }
  }
  if (/(启用|激活|停用|禁用).*(用户|账号)|把.+(设为|改为).*(普通用户|管理员|超级管理员)/.test(text)) {
    const status = /启用|激活/.test(text) ? 'active' : /停用|禁用/.test(text) ? 'disabled' : null
    const role = /超级管理员/.test(text) ? 'super_admin' : /普通用户/.test(text) ? 'user' : /管理员/.test(text) ? 'admin' : null
    const nameMatch = raw.match(/(?:启用|激活|停用|禁用)\s*([\u4e00-\u9fa5·]{2,20}?)(?:的)?(?:用户|账号)(?:$|[，。])/)
      || raw.match(/把\s*([\u4e00-\u9fa5·]{2,20}?)\s*(?:设为|改为)/)
    return { status: 'ready', intent: 'admin_update', slots: { name: nameMatch && nameMatch[1] || '', status, role } }
  }

  return null
}

function applyChoice(result, value, label, options = {}) {
  const slots = Object.assign({}, result.slots, { [result.field]: value })
  if (result.field === 'id' && label) slots.label = label
  if (result.intent === 'overtime_create') {
    if (result.field === 'content') slots.content = label || value
    const synthetic = `${slots.date || ''}登记加班${slots.hours ? `${slots.hours}小时` : ''}${slots.content ? `，内容：${slots.content}` : ''}`
    return parseOvertime(synthetic, options.now || new Date())
  }
  if (result.intent === 'situation_query') return { status: 'ready', intent: result.intent, slots }
  if (result.intent === 'approval_action') return { status: 'ready', intent: 'approval_select', slots }
  return { status: 'ready', intent: result.intent, slots }
}

function monthOf(date) { return String(date || '').slice(0, 7) || `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}` }

const LEAVE_RE = /请假|调休|年假|病假|事假|公出|产假|婚假|丧假|育儿假|陪产假|产检假|哺乳假/
const OVERTIME_RE = /加班|值班/

function hasMultipleIntents(text) {
  let count = 0
  if (LEAVE_RE.test(text)) count += 1
  if (OVERTIME_RE.test(text)) count += 1
  if (/查询|查一下|查看|电话|手机号|通讯录|联系方式|员工情况/.test(text)) count += 1
  if (/审批|通过|驳回|待审批/.test(text)) count += 1
  if (/余额|额度|记录/.test(text)) count += 1
  return count >= 2
}

// 把一句话中的多个任务拆分为独立片段，供逐个解析执行。
// 单任务保持整句（如"登记加班2小时，内容：发布"），多任务时按分隔符/逗号拆分。
function splitTasks(text) {
  const source = String(text || '').trim()
  if (!source) return []
  const hardSep = /[。；]|然后|顺便|同时|还要|以及|另外|接着|接下来/
  let parts = source.split(hardSep)
  if (hasMultipleIntents(source)) {
    parts = parts.flatMap(part => part.split('，'))
  }
  const trimmed = parts.map(part => part.trim()).filter(Boolean)
  const merged = []
  for (const part of trimmed) {
    const continuation = merged.length && /^(?:内容|事由|原因)(?:是|为|[:：])?/.test(part)
    if (continuation) merged[merged.length - 1] = `${merged[merged.length - 1]}，${part}`
    else merged.push(part)
  }
  return merged
}

module.exports = { parseCommand, applyChoice, parseDate, monthOf, splitTasks }
