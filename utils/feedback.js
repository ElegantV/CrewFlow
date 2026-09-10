// 统一错误提示：短消息用轻提示，长消息用弹窗完整展示（wx.showToast 会截断长文本）。
// 各页面错误提示一律走这里，避免新增提示时再出现"文字过长显示不全"。
const TOAST_MAX_LENGTH = 14

function showError(error, fallback) {
  const message = String((error && error.message) || fallback || '操作失败，请稍后重试')
  if (message.length <= TOAST_MAX_LENGTH) {
    wx.showToast({ title: message, icon: 'none', duration: 2500 })
    return
  }
  wx.showModal({
    title: '提示',
    content: message,
    showCancel: false,
    confirmText: '知道了'
  })
}

module.exports = { showError }
