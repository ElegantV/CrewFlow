const leaveTypeAliases = [
  { value: 'comp_time', label: '调休', aliases: ['调休假', '调休'] },
  { value: 'public_out', label: '公出', aliases: ['公出'] },
  { value: 'breastfeeding', label: '哺乳假', aliases: ['哺乳假'] },
  { value: 'annual', label: '年假', aliases: ['年假'] },
  { value: 'sick', label: '病假', aliases: ['病假'] },
  { value: 'personal', label: '事假', aliases: ['事假'] },
  { value: 'prenatal', label: '产检假', aliases: ['产检假'] },
  { value: 'maternity', label: '产假', aliases: ['产假'] },
  { value: 'parental', label: '育儿假', aliases: ['育儿假'] },
  { value: 'bereavement', label: '丧假', aliases: ['丧假'] },
  { value: 'marriage', label: '婚假', aliases: ['婚假'] },
  { value: 'paternity', label: '陪产假', aliases: ['陪产假'] }
]

const fixedWorkdays = { marriage: 10, paternity: 15 }

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function localDate(year, month, day) {
  const value = new Date(year, month - 1, day)
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day) return null
  return value
}

function shiftDate(date, days) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  result.setDate(result.getDate() + days)
  return result
}

function addWorkdays(startDate, workdays) {
  const parts = startDate.split('-').map(Number)
  const cursor = localDate(parts[0], parts[1], parts[2])
  let counted = 0
  while (counted < workdays) {
    const weekday = cursor.getDay()
    if (weekday !== 0 && weekday !== 6) counted += 1
    if (counted < workdays) cursor.setDate(cursor.getDate() + 1)
  }
  return formatDate(cursor)
}

function parseDate(text, now) {
  if (text.includes('后天')) return { value: formatDate(shiftDate(now, 2)), explicit: '后天' }
  if (text.includes('明天')) return { value: formatDate(shiftDate(now, 1)), explicit: '明天' }
  if (text.includes('今天') || text.includes('今日')) return { value: formatDate(now), explicit: '今天' }

  const iso = text.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/)
  const chinese = text.match(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})[日号]?/)
  const match = iso || chinese
  if (!match) return null
  const year = Number(match[1] || now.getFullYear())
  const month = Number(match[2])
  const day = Number(match[3])
  const date = localDate(year, month, day)
  if (!date) return { error: '日期不存在，请检查年月日后重试。' }
  return { value: formatDate(date), explicit: match[0] }
}

function detectTypes(text, availableTypes) {
  const allowed = new Set((availableTypes && availableTypes.length ? availableTypes : leaveTypeAliases).map(item => item.value))
  return leaveTypeAliases.filter(item => allowed.has(item.value) && item.aliases.some(alias => text.includes(alias)))
}

function parseDays(text) {
  if (text.includes('上午')) return { days: 0.5, period: 'morning', label: '上午半天' }
  if (text.includes('下午')) return { days: 0.5, period: 'afternoon', label: '下午半天' }
  if (text.includes('半天')) return { days: 0.5, period: null, label: '半天' }
  if (/全天|一天|1天|一日/.test(text)) return { days: 1, period: 'day', label: '全天' }
  const match = text.match(/(?:请|休)?(\d{1,2})天/)
  if (match) {
    const days = Number(match[1])
    if (days > 0) return { days, period: 'day', label: `${days}天` }
  }
  return null
}

function extractReason(text) {
  const match = text.match(/(?:因为|原因是|事由是|事由[:：]?)([^，。；;]+)/)
  return match ? match[1].trim() : ''
}

function typeChoices(availableTypes) {
  const source = availableTypes && availableTypes.length ? availableTypes : leaveTypeAliases
  return source.map(item => ({ label: item.label, value: item.value }))
}

function analyzeDraft(draft, availableTypes, now) {
  if (!draft.leaveType) {
    return {
      status: 'clarify', draft, field: 'leaveType',
      message: '你想请哪一种假？请选择假别。',
      choices: typeChoices(availableTypes)
    }
  }
  if (!draft.startDate) {
    return {
      status: 'clarify', draft, field: 'startDate',
      message: '还缺少请假日期，请选择或输入具体日期。',
      choices: [
        { label: `今天 ${formatDate(now)}`, value: formatDate(now) },
        { label: `明天 ${formatDate(shiftDate(now, 1))}`, value: formatDate(shiftDate(now, 1)) }
      ],
      allowDatePicker: true
    }
  }
  const fixed = fixedWorkdays[draft.leaveType]
  if (fixed) {
    draft.days = fixed
    draft.period = 'day'
  } else if (!draft.days) {
    return {
      status: 'clarify', draft, field: 'duration',
      message: '请多久？请选择全天或半天时段。',
      choices: [
        { label: '全天', value: 'day' },
        { label: '上午半天', value: 'morning' },
        { label: '下午半天', value: 'afternoon' }
      ]
    }
  } else if (draft.days === 0.5 && !draft.period) {
    return {
      status: 'clarify', draft, field: 'period',
      message: '半天是上午还是下午？',
      choices: [
        { label: '上午', value: 'morning' },
        { label: '下午', value: 'afternoon' }
      ]
    }
  }

  const type = (availableTypes || []).find(item => item.value === draft.leaveType) ||
    leaveTypeAliases.find(item => item.value === draft.leaveType)
  if (draft.days === 0.5 && type && type.minimumHours && type.minimumHours > 4) {
    return {
      status: 'invalid',
      message: `${type.label}最少需要请${type.minimumHours / 8}天，不能申请半天。`
    }
  }
  const endDate = draft.days > 1 ? addWorkdays(draft.startDate, draft.days) : draft.startDate
  const periodLabel = draft.period === 'morning' ? '上午半天' : draft.period === 'afternoon' ? '下午半天' : `${draft.days}天`
  return {
    status: 'ready',
    draft: Object.assign({}, draft, { endDate }),
    summary: `${type ? type.label : '请假'} · ${draft.startDate}${endDate !== draft.startDate ? ` 至 ${endDate}` : ''} · ${periodLabel}`
  }
}

function parsePrompt(input, options) {
  const text = String(input || '').trim().replace(/\s+/g, '')
  const now = options && options.now ? options.now : new Date()
  const availableTypes = options && options.availableTypes ? options.availableTypes : leaveTypeAliases
  if (!text) return { status: 'invalid', message: '请输入要执行的任务。' }
  if (!/(请假|请.{0,8}假|休假|调休|年假|病假|事假|公出|产假|婚假|丧假|育儿假|陪产假|产检假|哺乳假)/.test(text)) {
    return { status: 'invalid', message: '这不是可执行的请假指令。你可以试试“8月13号请一天调休假”。' }
  }

  const date = parseDate(text, now)
  if (date && date.error) return { status: 'invalid', message: date.error }
  const detectedTypes = detectTypes(text, availableTypes)
  if (detectedTypes.length > 1) {
    return {
      status: 'clarify', field: 'leaveType',
      draft: { startDate: date && date.value, reason: extractReason(text) },
      message: '指令中出现了多个假别，请确认要申请哪一种。',
      choices: detectedTypes.map(item => ({ label: item.label, value: item.value }))
    }
  }
  const duration = parseDays(text)
  const draft = {
    leaveType: detectedTypes[0] && detectedTypes[0].value,
    startDate: date && date.value,
    days: duration && duration.days,
    period: duration && duration.period,
    reason: extractReason(text)
  }
  return analyzeDraft(draft, availableTypes, now)
}

function applyChoice(result, value, options) {
  const now = options && options.now ? options.now : new Date()
  const availableTypes = options && options.availableTypes ? options.availableTypes : leaveTypeAliases
  const draft = Object.assign({}, result.draft)
  if (result.field === 'leaveType') draft.leaveType = value
  if (result.field === 'startDate') draft.startDate = value
  if (result.field === 'duration') {
    draft.days = value === 'day' ? 1 : 0.5
    draft.period = value
  }
  if (result.field === 'period') draft.period = value
  return analyzeDraft(draft, availableTypes, now)
}

function toLeaveRequest(draft) {
  return {
    leaveType: draft.leaveType,
    startDate: draft.startDate,
    endDate: draft.endDate || draft.startDate,
    startPeriod: draft.period || 'day',
    endPeriod: draft.period || 'day',
    reason: draft.reason || '由简序日程 AI 助手提交'
  }
}

module.exports = { parsePrompt, applyChoice, toLeaveRequest, formatDate }
