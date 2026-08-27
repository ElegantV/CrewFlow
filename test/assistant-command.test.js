const assert = require('node:assert/strict')
const test = require('node:test')
const command = require('../utils/assistant-command')

const now = new Date(2026, 7, 13)

test('解析完整的加班登记指令', () => {
  const result = command.parseCommand('今天登记加班2小时，内容：生产发布支持', { now })
  assert.equal(result.status, 'ready')
  assert.equal(result.intent, 'overtime_create')
  assert.deepEqual(result.slots, { date: '2026-08-13', hours: 2, content: '生产发布支持' })
})

test('加班缺少工作内容时继续追问', () => {
  const result = command.parseCommand('今天登记加班3小时', { now })
  assert.equal(result.status, 'clarify')
  assert.equal(result.field, 'content')
  assert.equal(result.allowText, true)
})

test('支持查询指定人员电话', () => {
  const result = command.parseCommand('查询张三的电话', { now })
  assert.equal(result.intent, 'contact_query')
  assert.equal(result.slots.name, '张三')
})

test('支持查询指定人员一般信息', () => {
  const result = command.parseCommand('查看张三的信息', { now })
  assert.equal(result.intent, 'contact_query')
  assert.equal(result.slots.name, '张三')
})

test('个人和管理员信息查询优先于通用通讯录查询', () => {
  assert.equal(command.parseCommand('查看我的信息', { now }).intent, 'profile_query')
  assert.equal(command.parseCommand('查看用户信息', { now }).intent, 'admin_users')
})

test('支持查询指定人员某日是否请假', () => {
  const result = command.parseCommand('张三今天是否请假', { now })
  assert.equal(result.intent, 'situation_query')
  assert.equal(result.slots.date, '2026-08-13')
  assert.equal(result.slots.name, '张三')
  assert.equal(result.slots.activity, 'leave')
})

test('查询某日谁请假时不把“谁”当作姓名', () => {
  const result = command.parseCommand('今天谁请假', { now })
  assert.equal(result.intent, 'situation_query')
  assert.equal(result.slots.name, '')
})

test('支持调休余额、记录与审批查询', () => {
  assert.equal(command.parseCommand('我还有多少调休', { now }).intent, 'overtime_balance')
  assert.equal(command.parseCommand('查看我的加班记录', { now }).intent, 'overtime_list')
  assert.equal(command.parseCommand('查看我的请假进度', { now }).intent, 'leave_list')
  assert.equal(command.parseCommand('查看待审批申请', { now }).intent, 'approval_pending')
})

test('驳回指令提取目标人员与原因', () => {
  const result = command.parseCommand('驳回张三的请假，原因：当天人手不足', { now })
  assert.equal(result.intent, 'approval_decide')
  assert.equal(result.slots.action, 'reject')
  assert.equal(result.slots.name, '张三')
  assert.equal(result.slots.reason, '当天人手不足')
})

test('“审批请假”进入待审批选择流程', () => {
  const result = command.parseCommand('审批请假', { now })
  assert.equal(result.intent, 'approval_decide')
  assert.equal(result.slots.action, '')
})

test('选择审批动作后保留申请编号', () => {
  const pending = { intent: 'approval_action', field: 'action', slots: { id: 'approval-id' } }
  const result = command.applyChoice(pending, 'approve', '通过申请', { now })
  assert.equal(result.intent, 'approval_select')
  assert.equal(result.slots.id, 'approval-id')
  assert.equal(result.slots.action, 'approve')
})

test('多轮加班补充信息后变成可执行任务', () => {
  const first = command.parseCommand('今天登记加班', { now })
  const second = command.applyChoice(first, 2, '2小时', { now })
  assert.equal(second.field, 'content')
  const ready = command.applyChoice(second, '故障处理', '故障处理', { now })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.slots.content, '故障处理')
})

test('支持专用页面和审批结果能力', () => {
  assert.equal(command.parseCommand('修改我的头像', { now }).intent, 'profile_open')
  assert.equal(command.parseCommand('下载请假审批结果PDF', { now }).intent, 'leave_result')
  const route = command.parseCommand('打开通讯录', { now })
  assert.equal(route.intent, 'navigate')
  assert.equal(route.slots.url, '/pages/contact/index')
  assert.equal(command.parseCommand('修改个人信息', { now }).intent, 'profile_open')
})

test('支持解析用户状态与角色管理', () => {
  const disabled = command.parseCommand('停用张三的账号', { now })
  assert.equal(disabled.intent, 'admin_update')
  assert.equal(disabled.slots.name, '张三')
  assert.equal(disabled.slots.status, 'disabled')
  const role = command.parseCommand('把李四设为管理员', { now })
  assert.equal(role.intent, 'admin_update')
  assert.equal(role.slots.name, '李四')
  assert.equal(role.slots.role, 'admin')
})

test('splitTasks 拆分多任务并保留单任务整体', () => {
  // 多任务：加班+请假
  const multi = command.splitTasks('帮我登记今天加班2小时，然后请明天一天调休')
  assert.equal(multi.length, 2)
  assert.match(multi[0], /加班/)
  assert.match(multi[1], /请假|调休/)
  // 单任务带内容续接，保持整句
  const single = command.splitTasks('登记加班2小时，内容：生产发布')
  assert.equal(single.length, 1)
  assert.match(single[0], /内容：生产发布/)
  // 查询类多任务
  const query = command.splitTasks('查询张三电话，顺便看看李四今天是否请假')
  assert.equal(query.length, 2)
  // 无任务分隔符的整句保持单条
  assert.equal(command.splitTasks('明天请一天年假').length, 1)
  // 空输入
  assert.deepEqual(command.splitTasks(''), [])
})
