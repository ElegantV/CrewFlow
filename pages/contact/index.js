const contact = require('../../services/contact')

Page({
  data: {
    loading: true,
    error: '',
    systems: [],
    selectedSystem: '全部',
    contacts: [],
    filteredContacts: []
  },

  onLoad() {
    this.loadData()
  },

  async loadData() {
    this.setData({ loading: true, error: '' })
    try {
      const result = await contact.list()
      const contacts = result.contacts || []
      this.setData({
        loading: false,
        systems: ['全部'].concat(result.systems || []),
        selectedSystem: '全部',
        contacts,
        filteredContacts: contacts
      })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '通讯录加载失败' })
    }
  },

  selectSystem(event) {
    const system = event.currentTarget.dataset.system
    if (!system || system === this.data.selectedSystem) return
    this.setData({
      selectedSystem: system,
      filteredContacts: system === '全部'
        ? this.data.contacts
        : this.data.contacts.filter(item => item.systemName === system)
    })
  },

  call(event) {
    const mobile = event.currentTarget.dataset.mobile
    if (!mobile) {
      wx.showToast({ title: '该人员未配置手机号', icon: 'none' })
      return
    }
    wx.makePhoneCall({ phoneNumber: mobile })
  },

  copy(event) {
    const item = this.data.contacts.find(contactItem => contactItem.id === event.currentTarget.dataset.id)
    if (!item) return
    wx.setClipboardData({
      data: item.copyText,
      success: () => wx.showToast({ title: '信息已复制', icon: 'success' })
    })
  },

  retry() {
    this.loadData()
  }
})
