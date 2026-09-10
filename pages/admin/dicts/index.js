const admin = require('../../../services/admin')
const me = require('../../../services/me')
const { showError } = require('../../../utils/feedback')

const TABS = [
  { value: 'departments', label: '行内处室' },
  { value: 'bank-projects', label: '行内项目' },
  { value: 'attendance-locations', label: '打卡地点' }
]

Page({
  data: {
    activeTab: 'departments',
    tabs: TABS,
    departments: [],
    locations: [],
    projects: [],
    loading: true,
    loadError: '',
    editing: false,
    saving: false,
    deleting: false,
    form: { name: '', departmentId: '', leaveApprovalRequired: true, overtimeApprovalRequired: false },
    departmentOptions: [],
    departmentIndex: 0,
    departmentsMap: {},
    projectDeptIndex: 0,
    deptProjects: []
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true, loadError: '' })
    try {
      const dicts = await me.dicts()
      const departmentOptions = dicts.departments.map(item => ({ id: item.id, name: item.name }))
      const departmentsMap = {}
      departmentOptions.forEach(item => { departmentsMap[item.id] = item.name })
      // 处室被删/列表收窄时重置选中处室,避免越界。
      const projectDeptIndex = Math.min(this.data.projectDeptIndex, Math.max(departmentOptions.length - 1, 0))
      this.setData({
        loading: false,
        departments: dicts.departments,
        locations: dicts.attendanceLocations,
        projects: dicts.bankProjects,
        departmentOptions,
        departmentsMap,
        projectDeptIndex,
        deptProjects: this.projectsOf(dicts.bankProjects, departmentOptions, projectDeptIndex)
      })
    } catch (error) {
      this.setData({ loading: false, loadError: error.message || '字典加载失败' })
    }
  },

  // 取指定处室下的项目列表。
  projectsOf(projects, departmentOptions, deptIndex) {
    const department = departmentOptions[deptIndex]
    return department ? projects.filter(item => item.departmentId === department.id) : []
  },

  switchTab(event) {
    this.setData({ activeTab: event.currentTarget.dataset.tab })
  },

  // 点击左侧处室,切换右侧项目列表。
  onProjectDeptChange(event) {
    const index = Number(event.currentTarget.dataset.index)
    this.setData({
      projectDeptIndex: index,
      deptProjects: this.projectsOf(this.data.projects, this.data.departmentOptions, index)
    })
  },

  openAdd() {
    const { activeTab, departmentOptions, projectDeptIndex } = this.data
    this.setData({
      editing: true,
      form: {
        name: '',
        departmentId: activeTab === 'bank-projects' && departmentOptions.length
          ? departmentOptions[projectDeptIndex].id
          : '',
        leaveApprovalRequired: true,
        overtimeApprovalRequired: false
      },
      departmentIndex: activeTab === 'bank-projects' ? projectDeptIndex : 0
    })
  },

  openEdit(event) {
    const { activeTab, departments, locations, projects, departmentOptions } = this.data
    const source = activeTab === 'departments' ? departments : activeTab === 'attendance-locations' ? locations : projects
    const item = source.find(entry => entry.id === event.currentTarget.dataset.id)
    if (!item) return
    const departmentIndex = Math.max(0, departmentOptions.findIndex(dep => dep.id === item.departmentId))
    const updates = {
      editing: true,
      form: {
        id: item.id,
        name: item.name,
        departmentId: item.departmentId || '',
        leaveApprovalRequired: item.leaveApprovalRequired !== false,
        overtimeApprovalRequired: item.overtimeApprovalRequired === true
      },
      departmentIndex
    }
    // 项目编辑时同步左侧处室选中态,保证右侧列表包含正在编辑的项目。
    if (activeTab === 'bank-projects') {
      updates.projectDeptIndex = departmentIndex
      updates.deptProjects = this.projectsOf(projects, departmentOptions, departmentIndex)
    }
    this.setData(updates)
  },

  close() {
    if (!this.data.saving && !this.data.deleting) this.setData({ editing: false })
  },

  onNameInput(event) {
    this.data.form.name = event.detail.value
  },

  onDepartmentChange(event) {
    const index = Number(event.detail.value)
    this.setData({ departmentIndex: index, 'form.departmentId': this.data.departmentOptions[index].id })
  },

  onLeaveApprovalChange(event) {
    this.setData({ 'form.leaveApprovalRequired': event.detail.value })
  },

  onOvertimeApprovalChange(event) {
    this.setData({ 'form.overtimeApprovalRequired': event.detail.value })
  },

  async save() {
    const { activeTab, form, departmentOptions, departmentIndex } = this.data
    const name = (form.name || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写名称', icon: 'none' })
      return
    }
    let payload = { name }
    if (activeTab === 'departments') {
      payload.leaveApprovalRequired = form.leaveApprovalRequired !== false
      payload.overtimeApprovalRequired = form.overtimeApprovalRequired === true
    }
    if (activeTab === 'bank-projects') {
      payload.departmentId = form.departmentId || (departmentOptions[departmentIndex] || {}).id
      if (!payload.departmentId) {
        wx.showToast({ title: '请先创建行内处室', icon: 'none' })
        return
      }
    }
    this.setData({ saving: true })
    try {
      const editingId = this.data.form.id
      if (editingId) {
        await admin.updateDict(activeTab, editingId, payload)
      } else {
        await admin.createDict(activeTab, payload)
      }
      this.setData({ saving: false, editing: false })
      wx.showToast({ title: '已保存', icon: 'success' })
      await this.loadData()
    } catch (error) {
      this.setData({ saving: false })
      showError(error, '保存失败')
    }
  },

  remove(event) {
    const { activeTab } = this.data
    const id = event.currentTarget.dataset.id
    const label = TABS.find(tab => tab.value === activeTab).label
    wx.showModal({
      title: `删除该${label}？`,
      content: '已被用户引用的字典项无法删除。',
      confirmText: '删除',
      confirmColor: '#dc2626',
      success: async result => {
        if (!result.confirm) return
        this.setData({ deleting: true })
        try {
          await admin.deleteDict(activeTab, id)
          this.setData({ deleting: false })
          wx.showToast({ title: '已删除', icon: 'success' })
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