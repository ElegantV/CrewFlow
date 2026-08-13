const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const projectRoot = path.join(__dirname, '..')

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(target) : [target]
  })
}

test('不使用开发者工具与 Skyline 行为不一致的组合事件属性', () => {
  const files = walk(path.join(projectRoot, 'pages')).filter(file => file.endsWith('.wxml'))
  const missing = []

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const controls = source.match(/<(?:input|textarea)\b[\s\S]*?(?:\/>|<\/textarea>)/g) || []
    for (const control of controls) {
      if (/ignore-composition-event=|ignoreCompositionEvent=/.test(control)) {
        missing.push(`${path.relative(projectRoot, file)}: ${control.replace(/\s+/g, ' ').slice(0, 100)}`)
      }
    }
  }

  assert.deepEqual(missing, [], `以下输入框仍使用组合事件属性：\n${missing.join('\n')}`)
})

test('文本输入处理器不在输入期间调用 setData 回写', () => {
  const handlers = [
    ['pages/profile/index.js', 'onInput'],
    ['pages/admin/users.js', 'onNameInput'],
    ['pages/admin/users.js', 'onEmployeeNoInput'],
    ['pages/duty/index.js', 'onContentInput'],
    ['pages/leave/index.js', 'onReasonInput'],
    ['pages/assistant/index.js', 'onInput']
  ]
  const offenders = []

  for (const [relativeFile, handler] of handlers) {
    const source = fs.readFileSync(path.join(projectRoot, relativeFile), 'utf8')
    const start = source.indexOf(`${handler}(`)
    const lineEnd = source.indexOf('\n', start)
    const firstLine = start >= 0 ? source.slice(start, lineEnd >= 0 ? lineEnd : source.length) : ''
    const blockEnd = source.indexOf('\n  },', start)
    const body = firstLine.includes('},')
      ? firstLine
      : start >= 0 && blockEnd >= 0 ? source.slice(start, blockEnd) : ''
    if (!body || /setData\s*\(/.test(body)) offenders.push(`${relativeFile}:${handler}`)
  }

  assert.deepEqual(offenders, [], `以下输入处理器仍会触发视图重绘：\n${offenders.join('\n')}`)
})

test('Skyline 样式不使用属性选择器', () => {
  const stylesheets = walk(path.join(projectRoot, 'pages')).filter(file => file.endsWith('.wxss'))
  const offenders = []
  for (const file of stylesheets) {
    const source = fs.readFileSync(file, 'utf8')
    source.split('\n').forEach((line, index) => {
      if (/^[^@/{]*\[[^\]]+\][^{]*\{/.test(line.trim())) {
        offenders.push(`${path.relative(projectRoot, file)}:${index + 1}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `Skyline 不支持以下属性选择器：\n${offenders.join('\n')}`)
})
