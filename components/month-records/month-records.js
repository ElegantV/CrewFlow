const me = require('../../services/me')

const leaveStatusLabels = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  cancelled: '已撤销'
}

const overtimeStatusLabels = {
  active: '可用',
  consumed: '已用完',
  revoked: '已撤销',
  expired: '已到期'
}

function pad(value) { return String(value).padStart(2, '0') }

Component({
  data: {
    month: '',
    title: '',
    loading: false,
    leaves: [],
    overtime: []
  },

  lifetimes: {
    attached() {
      const now = new Date()
      this.setData({ month: `${now.getFullYear()}-${pad(now.getMonth() + 1)}` })
      this.load()
    }
  },

  methods: {
    load() {
      const [year, value] = this.data.month.split('-').map(Number)
      this.setData({ loading: true, title: `${year}年${value}月` })
      me.ledger(this.data.month).then(result => {
        this.setData({
          loading: false,
          leaves: (result.leaves || []).map(item => Object.assign({}, item, {
            statusLabel: leaveStatusLabels[item.status] || item.status,
            dateLabel: item.startDate === item.endDate ? item.startDate : `${item.startDate} 至 ${item.endDate}`
          })),
          overtime: (result.overtime || []).map(item => Object.assign({}, item, {
            statusLabel: overtimeStatusLabels[item.status] || item.status
          }))
        })
      }).catch(() => {
        this.setData({ loading: false })
        wx.showToast({ title: '记录加载失败', icon: 'none' })
      })
    },

    prevMonth() {
      this.shift(-1)
    },

    nextMonth() {
      this.shift(1)
    },

    shift(offset) {
      const [year, value] = this.data.month.split('-').map(Number)
      const date = new Date(year, value - 1 + offset, 1)
      this.setData({ month: `${date.getFullYear()}-${pad(date.getMonth() + 1)}` })
      this.load()
    }
  }
})
