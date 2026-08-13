const leave = require('../../services/leave')
const me = require('../../services/me')

function today() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const statusLabels = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  cancelled: '已撤销'
}

const defaultLeaveType = {
  value: 'comp_time',
  label: '调休',
  minimumHours: 4,
  incrementHours: 4,
  fixedWorkdays: null,
  proofNotice: null
}

function settled(promise) {
  return promise.then(value => ({ value }), error => ({ error }))
}

Page({
  data: {
    loading: true,
    submitting: false,
    showForm: false,
    showResult: false,
    resultLoading: false,
    downloading: false,
    approvalResult: null,
    resultLeaveId: '',
    cancellingId: '',
    requests: [],
    types: [defaultLeaveType],
    typeIndex: 0,
    currentType: defaultLeaveType,
    profile: null,
    periods: [
      { value: 'day', label: '全天' },
      { value: 'morning', label: '上午半天' },
      { value: 'afternoon', label: '下午半天' }
    ],
    startPeriodIndex: 0,
    endPeriodIndex: 0,
    form: {
      leaveType: 'comp_time',
      startDate: '',
      endDate: '',
      startPeriod: 'day',
      endPeriod: 'day',
      reason: ''
    }
  },

  onLoad() {
    const date = today()
    this.setData({ 'form.startDate': date, 'form.endDate': date })
  },

  onShow() {
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true })
    const [listResult, typesResult, profileResult] = await Promise.all([
      settled(leave.list()),
      settled(leave.types()),
      settled(me.get())
    ])
    const updates = { loading: false }
    if (listResult.value) {
      updates.requests = listResult.value.requests.map(item => Object.assign({}, item, {
        statusLabel: statusLabels[item.status] || item.status,
        canCancel: item.status === 'pending' || item.status === 'approved',
        canViewResult: item.status === 'approved'
      }))
    }
    if (typesResult.value && typesResult.value.types && typesResult.value.types.length) {
      const types = typesResult.value.types
      updates.types = types
      updates.currentType = types.find(item => item.value === this.data.form.leaveType) || types[0]
      updates.typeIndex = Math.max(0, types.findIndex(item => item.value === updates.currentType.value))
    }
    if (profileResult.value) updates.profile = profileResult.value
    this.setData(updates)

    const failed = listResult.error || typesResult.error || profileResult.error
    if (failed) {
      wx.showToast({ title: failed.message || '部分数据加载失败，请重试', icon: 'none' })
    }
  },

  openForm() {
    if (this.data.loading) {
      wx.showToast({ title: '数据加载中，请稍候', icon: 'none' })
      return
    }
    if (!this.data.profile) {
      wx.showToast({ title: '个人信息加载失败，正在重试', icon: 'none' })
      this.loadData()
      return
    }
    if (this.data.profile.personnelType !== 'bank' && !this.data.profile.agent) {
      wx.showModal({
        title: '请先设置代理人',
        content: '请假申请需要工作代理人，是否现在设置？',
        success: result => {
          if (result.confirm) wx.navigateTo({ url: '/pages/profile/index' })
        }
      })
      return
    }
    this.setData({ showForm: true })
  },

  openProfile() {
    wx.navigateTo({ url: '/pages/profile/index' })
  },

  closeForm() {
    if (!this.data.submitting) this.setData({ showForm: false })
  },

  onTypeChange(event) {
    const typeIndex = Number(event.detail.value)
    const currentType = this.data.types[typeIndex]
    this.setData({
      typeIndex,
      currentType,
      'form.leaveType': currentType.value
    })
  },

  onStartDateChange(event) {
    const value = event.detail.value
    const updates = { 'form.startDate': value }
    if (this.data.form.endDate < value) updates['form.endDate'] = value
    this.setData(updates)
  },

  onEndDateChange(event) {
    this.setData({ 'form.endDate': event.detail.value })
  },

  onStartPeriodChange(event) {
    const index = Number(event.detail.value)
    this.setData({ startPeriodIndex: index, 'form.startPeriod': this.data.periods[index].value })
  },

  onEndPeriodChange(event) {
    const index = Number(event.detail.value)
    this.setData({ endPeriodIndex: index, 'form.endPeriod': this.data.periods[index].value })
  },

  onReasonInput(event) {
    this.data.form.reason = event.detail.value
  },

  async submit() {
    const form = this.data.form
    const fixedWorkdays = this.data.currentType && this.data.currentType.fixedWorkdays
    if (!fixedWorkdays && form.endDate < form.startDate) {
      wx.showToast({ title: '结束日期不能早于开始日期', icon: 'none' })
      return
    }
    if (!fixedWorkdays && form.startDate === form.endDate) {
      if (form.startPeriod === 'afternoon' && form.endPeriod === 'morning') {
        wx.showToast({ title: '同一天结束时段不能早于开始时段', icon: 'none', duration: 3000 })
        return
      }
      const usesDay = form.startPeriod === 'day' || form.endPeriod === 'day'
      if (usesDay && form.startPeriod !== form.endPeriod) {
        wx.showToast({ title: '同一天选择全天时，开始和结束都须选全天', icon: 'none', duration: 3000 })
        return
      }
    }
    this.setData({ submitting: true })
    try {
      const result = await leave.create(this.data.form)
      this.setData({ showForm: false, submitting: false, 'form.reason': '' })
      wx.showToast({ title: `已提交${result.requestedDays}天`, icon: 'success' })
      if (result.warnings && result.warnings.length) {
        wx.showModal({
          title: '值班时间冲突提醒',
          content: result.warnings.map(item => item.message).join('\n'),
          showCancel: false
        })
      }
      await this.loadData()
    } catch (error) {
      this.setData({ submitting: false })
      wx.showToast({ title: error.message || '提交失败', icon: 'none', duration: 3000 })
    }
  },

  async openApprovalResult(event) {
    const id = event.currentTarget.dataset.id
    this.setData({ showResult: true, resultLoading: true, approvalResult: null, resultLeaveId: id })
    try {
      const response = await leave.approvalResult(id)
      this.setData({ approvalResult: response.result, resultLoading: false })
    } catch (error) {
      this.setData({ showResult: false, resultLoading: false })
      wx.showToast({ title: error.message || '审批结果加载失败', icon: 'none' })
    }
  },

  closeResult() {
    if (!this.data.downloading) this.setData({ showResult: false })
  },

  copyApprovalResult() {
    if (!this.data.approvalResult) return
    wx.setClipboardData({
      data: this.data.approvalResult.text,
      success: () => wx.showToast({ title: '审批内容已复制', icon: 'success' })
    })
  },

  async downloadApprovalPdf() {
    if (!this.data.resultLeaveId || this.data.downloading) return
    this.setData({ downloading: true })
    try {
      const filePath = await leave.downloadPdf(this.data.resultLeaveId)
      this.setData({ downloading: false })
      wx.openDocument({
        filePath,
        fileType: 'pdf',
        showMenu: true,
        fail: () => wx.showToast({ title: 'PDF 已下载，但打开失败', icon: 'none' })
      })
    } catch (error) {
      this.setData({ downloading: false })
      wx.showToast({ title: error.message || '下载失败', icon: 'none' })
    }
  },

  cancel(event) {
    const id = event.currentTarget.dataset.id
    if (!id || this.data.cancellingId === id) return
    wx.showModal({
      title: '撤销申请',
      content: '调休额度将按原加班记录和原到期日退回，是否继续？',
      success: async result => {
        if (!result.confirm) return
        this.setData({ cancellingId: id })
        try {
          await leave.cancel(id)
          const requests = this.data.requests.map(item => item.id === id
            ? Object.assign({}, item, { status: 'cancelled', statusLabel: statusLabels.cancelled, canCancel: false, canViewResult: false })
            : item)
          this.setData({ requests })
          wx.showToast({ title: '申请已撤销', icon: 'success' })
          await this.loadData()
        } catch (error) {
          wx.showToast({ title: error.message || '撤销失败', icon: 'none' })
        } finally {
          this.setData({ cancellingId: '' })
        }
      }
    })
  },

  noop() {}
})
