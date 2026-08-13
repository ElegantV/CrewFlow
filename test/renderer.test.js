const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')

test('统一使用 WebView，避免 Skyline 模拟器中文输入异常', () => {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  const privateConfig = JSON.parse(fs.readFileSync(path.join(root, 'project.private.config.json'), 'utf8'))

  assert.equal(app.renderer, 'webview')
  assert.equal(app.rendererOptions, undefined)
  assert.equal(privateConfig.setting.skylineRenderEnable, false)
})
