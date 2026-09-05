const request = require('./request')

// AI 深度问答:仅在规则引擎未命中且用户开启开关后调用。
// 服务端只返回回答文本,不做任何系统操作;系统操作始终由指令解析层执行。
module.exports = {
  chat(messages) {
    return request({ url: '/api/v1/ai/chat', method: 'POST', data: { messages }, timeout: 60000 })
  }
}
