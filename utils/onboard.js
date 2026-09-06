// 系统必填字段引导：判定规则与 GET /api/v1/me 返回的 missingRequired 保持一致，
// 服务端版本较旧未返回该字段时，按同一规则在前端兜底计算。
const SKIP_KEY = 'onboardSkipUntil'
const SKIP_DURATION = 24 * 60 * 60 * 1000

function missingRequiredOf(profile) {
  if (!profile) return []
  if (Array.isArray(profile.missingRequired)) return profile.missingRequired
  const missing = []
  if (!profile.name) missing.push('name')
  if (profile.personnelType !== 'bank' && !(profile.agent && profile.agent.id)) missing.push('agent')
  if ((profile.role === 'admin' || profile.role === 'super_admin') && !profile.signatureConfigured) missing.push('signature')
  return missing
}

// 用户在引导页选择"暂不设置"后，24 小时内首页不再强制跳转，避免每次进首页都被打断。
function isSkipped() {
  try {
    return Number(wx.getStorageSync(SKIP_KEY) || 0) > Date.now()
  } catch (error) {
    return false
  }
}

function markSkipped() {
  try {
    wx.setStorageSync(SKIP_KEY, Date.now() + SKIP_DURATION)
  } catch (error) {
    // 存储不可用时跳过即可，下次进首页仍会引导。
  }
}

module.exports = { missingRequiredOf, isSkipped, markSkipped }
