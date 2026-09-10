const admin = require('../../services/admin')
const { showError } = require('../../utils/feedback')

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

const bankLevels = ['初级', '中级', '高级', '主管', '高级主管']

Page({
  data: {
    loading: true,
    loadError: '',
    users: [],
    managers: [{ id: '', name: '不指定' }],
    roles,
    statuses,
    bankLevels,
    editing: false,
    saving: false,
    deleting: false,
    roleIndex: 0,
    statusIndex: 0,
    managerIndex: 0,
    bankLevelIndex: 0,
    form: null
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true, loadError: '' })
    try {
      const result = await admin.users()
      const managers = [{ id: '', name: '不指定' }]
      const managerIds = new Set()
      result.users
        .filter(user => user.status === 'active' && (user.role === 'admin' || user.role === 'super_admin'))
        .forEach(user => {
          managers.push({ id: user.id, name: user.name || user.openid.slice(0, 8) })
          managerIds.add(user.id)
        })
      // 现任审批人已被降权/停用/删除时不在可选列表里:仍追加展示并选中,
      // 避免编辑弹层误显示"不指定",以及直接保存把审批管理员静默清空。
      result.users.forEach(user => {
        if (user.manager && !managerIds.has(user.manager.id)) {
          managers.push({
            id: user.manager.id,
            name: `${user.manager.name || '未命名用户'}（已失效）`,
            invalid: true
          })
          managerIds.add(user.manager.id)
        }
      })
      this.setData({
        loading: false,
        users: result.users.map(user => Object.assign({}, user, {
          roleLabel: roles.find(item => item.value === user.role).label
        })),
        managers
      })
    } catch (error) {
      this.setData({ loading: false, loadError: error.message || '用户列表加载失败' })
    }
  },

  edit(event) {
    const user = this.data.users.find(item => item.id === event.currentTarget.dataset.id)
    const roleIndex = roles.findIndex(item => item.value === user.role)
    const statusIndex = statuses.findIndex(item => item.value === user.status)
    const managerIndex = user.manager
      ? this.data.managers.findIndex(item => item.id === user.manager.id)
      : 0
    // 历史自定义级别不在五档内时回退到"初级",保存后即按新选项落库。
    const bankLevelIndex = Math.max(0, bankLevels.indexOf(user.bankLevel))
    this.setData({
      editing: true,
      roleIndex,
      statusIndex,
      managerIndex: Math.max(managerIndex, 0),
      bankLevelIndex,
      form: {
        id: user.id,
        name: user.name || '',
        bankLevel: bankLevels[bankLevelIndex],
        role: user.role,
        status: user.status,
        managerId: user.manager ? user.manager.id : null
      }
    })
  },

  close() {
    if (!this.data.saving && !this.data.deleting) this.setData({ editing: false })
  },

  // 输入期间不 setData 回写受控组件，避免 Skyline 打断中文输入法的拼音组合态。
  onNameInput(event) { this.data.form.name = event.detail.value },
  onBankLevelChange(event) {
    const index = Number(event.detail.value)
    this.setData({ bankLevelIndex: index, 'form.bankLevel': bankLevels[index] })
  },
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
    const manager = this.data.managers[this.data.managerIndex]
    if (manager && manager.invalid) {
      wx.showToast({ title: '当前审批人已失效，请重新选择', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      await admin.updateUser(this.data.form.id, {
        name: this.data.form.name,
        bankLevel: bankLevels[this.data.bankLevelIndex],
        role: this.data.form.role,
        status: this.data.form.status,
        managerId: this.data.form.managerId
      })
      this.setData({ saving: false, editing: false })
      wx.showToast({ title: '用户已更新', icon: 'success' })
      await this.loadData()
    } catch (error) {
      this.setData({ saving: false })
      showError(error, '保存失败')
    }
  },

  // 删除并重置:清空该用户业务数据并解绑微信,使其下次进入走全新注册流程。
  remove() {
    const user = this.data.users.find(item => item.id === this.data.form.id)
    if (!user) return
    wx.showModal({
      title: '删除并重置该用户？',
      content: `将删除「${user.name || '待命名用户'}」的全部请假、加班等数据并解绑微信，之后该微信号首次进入会重新注册。此操作不可恢复。`,
      confirmText: '删除',
      confirmColor: '#dc2626',
      success: async result => {
        if (!result.confirm) return
        this.setData({ deleting: true })
        try {
          await admin.deleteUser(this.data.form.id)
          this.setData({ deleting: false, editing: false })
          wx.showToast({ title: '用户已删除', icon: 'success' })
          await this.loadData()
        } catch (error) {
          this.setData({ deleting: false })
          showError(error, '删除失败')
        }
      }
    })
  },

  noop() {}
})
