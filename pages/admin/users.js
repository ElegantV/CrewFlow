const admin = require('../../services/admin')

const roles = [
  { value: 'user', label: '普通用户' },
  { value: 'admin', label: '管理员' },
  { value: 'super_admin', label: '超级管理员' }
]

const statuses = [
  { value: 'pending', label: '待激活' },
  { value: 'active', label: '已启用' },
  { value: 'disabled', label: '已停用' }
]

Page({
  data: {
    users: [],
    managers: [{ id: '', name: '不指定' }],
    roles,
    statuses,
    editing: false,
    saving: false,
    roleIndex: 0,
    statusIndex: 0,
    managerIndex: 0,
    form: null
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    try {
      const result = await admin.users()
      const managers = [{ id: '', name: '不指定' }].concat(
        result.users
          .filter(user => user.status === 'active' && (user.role === 'admin' || user.role === 'super_admin'))
          .map(user => ({ id: user.id, name: user.name || user.openid.slice(0, 8) }))
      )
      this.setData({
        users: result.users.map(user => Object.assign({}, user, {
          roleLabel: roles.find(item => item.value === user.role).label,
          statusLabel: statuses.find(item => item.value === user.status).label
        })),
        managers
      })
    } catch (error) {
      wx.showToast({ title: error.message || '加载失败', icon: 'none' })
    }
  },

  edit(event) {
    const user = this.data.users.find(item => item.id === event.currentTarget.dataset.id)
    const roleIndex = roles.findIndex(item => item.value === user.role)
    const statusIndex = statuses.findIndex(item => item.value === user.status)
    const managerIndex = user.manager
      ? this.data.managers.findIndex(item => item.id === user.manager.id)
      : 0
    this.setData({
      editing: true,
      roleIndex,
      statusIndex,
      managerIndex: Math.max(managerIndex, 0),
      form: {
        id: user.id,
        name: user.name || '',
        employeeNo: user.employeeNo || '',
        role: user.role,
        status: user.status,
        managerId: user.manager ? user.manager.id : null
      }
    })
  },

  close() {
    if (!this.data.saving) this.setData({ editing: false })
  },

  // 输入期间不 setData 回写受控组件，避免 Skyline 打断中文输入法的拼音组合态。
  onNameInput(event) { this.data.form.name = event.detail.value },
  onEmployeeNoInput(event) { this.data.form.employeeNo = event.detail.value },
  onRoleChange(event) {
    const index = Number(event.detail.value)
    this.setData({ roleIndex: index, 'form.role': roles[index].value })
  },
  onStatusChange(event) {
    const index = Number(event.detail.value)
    this.setData({ statusIndex: index, 'form.status': statuses[index].value })
  },
  onManagerChange(event) {
    const index = Number(event.detail.value)
    this.setData({ managerIndex: index, 'form.managerId': this.data.managers[index].id || null })
  },

  async save() {
    if (!this.data.form.name.trim()) {
      wx.showToast({ title: '请填写姓名', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      await admin.updateUser(this.data.form.id, {
        name: this.data.form.name,
        employeeNo: this.data.form.employeeNo || null,
        role: this.data.form.role,
        status: this.data.form.status,
        managerId: this.data.form.managerId
      })
      this.setData({ saving: false, editing: false })
      wx.showToast({ title: '用户已更新', icon: 'success' })
      await this.loadData()
    } catch (error) {
      this.setData({ saving: false })
      wx.showToast({ title: error.message || '保存失败', icon: 'none' })
    }
  },

  noop() {}
})
