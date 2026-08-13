const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const stylesheet = fs.readFileSync(
  path.join(__dirname, '../pages/assistant/index.wxss'),
  'utf8'
)

function declarationBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = stylesheet.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))
  return match ? match[1] : ''
}

test('AI 助手使用页面剩余高度，不会把输入栏挤出屏幕', () => {
  const page = declarationBlock('page')
  const layout = declarationBlock('.assistant-page')
  const conversation = declarationBlock('.conversation')

  assert.match(page, /display:\s*flex/)
  assert.match(page, /flex-direction:\s*column/)
  assert.match(layout, /flex:\s*1/)
  assert.match(layout, /height:\s*0/)
  assert.match(layout, /min-height:\s*0/)
  assert.match(conversation, /flex:\s*1/)
  assert.match(conversation, /height:\s*0/)
})
