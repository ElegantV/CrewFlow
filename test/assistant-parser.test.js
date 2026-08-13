const assert = require('node:assert/strict')
const test = require('node:test')
const parser = require('../utils/assistant-parser')

const now = new Date(2026, 7, 13)
const types = [
  { value: 'comp_time', label: '调休', minimumHours: 4 },
  { value: 'annual', label: '年假', minimumHours: 8 }
]

test('明确指令可直接转换成请假任务', () => {
  const result = parser.parsePrompt('8月13号请一天调休假', { now, availableTypes: types })
  assert.equal(result.status, 'ready')
  assert.deepEqual(parser.toLeaveRequest(result.draft), {
    leaveType: 'comp_time',
    startDate: '2026-08-13',
    endDate: '2026-08-13',
    startPeriod: 'day',
    endPeriod: 'day',
    reason: '由 CrewFlow AI 助手提交'
  })
})

test('假别不明确时要求用户选择', () => {
  const result = parser.parsePrompt('8月13号请一天假', { now, availableTypes: types })
  assert.equal(result.status, 'clarify')
  assert.equal(result.field, 'leaveType')
  assert.deepEqual(result.choices.map(item => item.label), ['调休', '年假'])
})

test('半天时段不明确时要求用户选择', () => {
  const result = parser.parsePrompt('8月13号请半天调休', { now, availableTypes: types })
  assert.equal(result.status, 'clarify')
  assert.equal(result.field, 'period')
})

test('选择后继续完成同一任务', () => {
  const first = parser.parsePrompt('8月13号请一天假', { now, availableTypes: types })
  const result = parser.applyChoice(first, 'comp_time', { now, availableTypes: types })
  assert.equal(result.status, 'ready')
  assert.equal(result.draft.leaveType, 'comp_time')
})

test('不存在的日期是无效信息', () => {
  const result = parser.parsePrompt('2月30号请一天调休', { now, availableTypes: types })
  assert.equal(result.status, 'invalid')
  assert.match(result.message, /日期不存在/)
})

test('无关内容给出无效提示', () => {
  const result = parser.parsePrompt('帮我订一杯咖啡', { now, availableTypes: types })
  assert.equal(result.status, 'invalid')
})

test('不符合假别最小时长的指令无效', () => {
  const result = parser.parsePrompt('明天下午请半天年假', { now, availableTypes: types })
  assert.equal(result.status, 'invalid')
  assert.match(result.message, /不能申请半天/)
})
