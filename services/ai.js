const { getApiBaseUrl } = require('../config/env')
const session = require('../utils/session')

// 增量 UTF-8 解码:enableChunked 的分片可能在多字节汉字中间截断,
// 保留不完整字节到下一片拼接,避免输出乱码。
function createUtf8Decoder() {
  let pending = []
  return function decode(bytes) {
    const incoming = new Uint8Array(bytes)
    const all = pending.length ? Uint8Array.from([...pending, ...incoming]) : incoming
    let text = ''
    let i = 0
    while (i < all.length) {
      const first = all[i]
      let length = 1
      if (first >= 0xF0) length = 4
      else if (first >= 0xE0) length = 3
      else if (first >= 0xC0) length = 2
      if (i + length > all.length) break
      let valid = true
      for (let k = 1; k < length; k++) {
        if ((all[i + k] & 0xC0) !== 0x80) { valid = false; break }
      }
      if (!valid) { i += 1; continue }
      if (length === 1) text += String.fromCharCode(first)
      else if (length === 2) text += String.fromCharCode(((first & 0x1F) << 6) | (all[i + 1] & 0x3F))
      else if (length === 3) text += String.fromCharCode(((first & 0x0F) << 12) | ((all[i + 1] & 0x3F) << 6) | (all[i + 2] & 0x3F))
      else {
        const codePoint = ((first & 0x07) << 18) | ((all[i + 1] & 0x3F) << 12) | ((all[i + 2] & 0x3F) << 6) | (all[i + 3] & 0x3F)
        const offset = codePoint - 0x10000
        text += String.fromCharCode(0xD800 + (offset >> 10), 0xDC00 + (offset & 0x3FF))
      }
      i += length
    }
    pending = Array.from(all.subarray(i))
    return text
  }
}

// 解析 SSE 文本帧:按空行切分,提取 data: JSON 事件。
function createSseParser(onEvent) {
  let buffer = ''
  return function feed(text) {
    buffer += text
    const frames = buffer.split('\n\n')
    buffer = frames.pop() || ''
    for (const frame of frames) {
      const line = frame.trim()
      if (!line.startsWith('data:')) continue
      try { onEvent(JSON.parse(line.slice(5).trim())) } catch (error) { /* 忽略无法解析的帧 */ }
    }
  }
}

function authHeader() {
  const token = session.getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function requestFailed(response) {
  const body = response.data && typeof response.data === 'object' ? response.data : {}
  const error = new Error(body.message || 'AI 服务暂时不可用，请稍后重试')
  return Promise.reject(Object.assign(error, body))
}

// 流式聊天:enableChunked 分片接收 SSE,delta 事件实时回调,resolve 于 result 事件。
// 旧基础库不支持 onChunkReceived 时自动降级为一次性 JSON。
function chatStream({ messages }, { onDelta } = {}) {
  return new Promise((resolve, reject) => {
    const requestTask = wx.request({
      url: `${getApiBaseUrl()}/api/v1/ai/chat`,
      method: 'POST',
      data: { messages },
      header: Object.assign({ 'content-type': 'application/json', Accept: 'text/event-stream' }, authHeader()),
      enableChunked: true,
      timeout: 60000,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) return
        if (response.statusCode === 401) {
          return reject(Object.assign(new Error('登录状态已失效，请重新登录'), { code: 'AUTH_REQUIRED' }))
        }
        reject(Object.assign(new Error((response.data && response.data.message) || 'AI 服务暂时不可用，请稍后重试'), { code: 'AI_UPSTREAM_ERROR' }))
      },
      fail(error) {
        reject(Object.assign(new Error('网络异常，AI 暂时不可用'), { cause: error }))
      }
    })
    if (typeof requestTask.onChunkReceived !== 'function') {
      // 分片接收不可用:中止流式,降级为一次性 JSON 请求。
      try { requestTask.abort() } catch (error) { /* 已完成的请求无需中止 */ }
      chat(messages).then(resolve, reject)
      return
    }
    const decode = createUtf8Decoder()
    let settled = false
    const finish = (text) => {
      if (settled) return
      settled = true
      if (text) resolve({ reply: text })
      else reject(new Error('AI 未返回有效回答'))
    }
    requestTask.onChunkReceived(res => {
      const events = createSseParser(event => {
        if (event.type === 'delta' && onDelta) onDelta(event.text)
        else if (event.type === 'result') finish(event.text)
        else if (event.type === 'error') {
          settled = true
          reject(new Error(event.message || 'AI 服务暂时不可用'))
        }
      })
      events(decode(res.data))
    })
  })
}

// 非流式兜底:一次性等待完整回答。
function chat(messages) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${getApiBaseUrl()}/api/v1/ai/chat`,
      method: 'POST',
      data: { messages },
      header: Object.assign({ 'content-type': 'application/json' }, authHeader()),
      timeout: 60000,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data)
          return
        }
        requestFailed(response).then(reject, reject)
      },
      fail() {
        reject(new Error('网络异常，AI 暂时不可用'))
      }
    })
  })
}

module.exports = { chatStream, chat }
