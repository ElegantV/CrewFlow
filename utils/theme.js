/**
 * 主题色值（JS 侧常量）。
 *
 * 背景：小程序的原生组件（switch / picker 等）部分属性走的是原生渲染通道，
 * 不接受 CSS 变量，只能通过属性传入具体色值，例如 <switch color="#2f6fed" />。
 * 这里集中导出这些色值，避免在各页面 wxml 里散落硬编码十六进制色。
 *
 * ⚠️ 必须与 app.wxss 中 page 选择器下的同名 token 保持一致：
 *    BRAND      <-> --brand
 *    BRAND_DEEP <-> --brand-deep
 * 改 token 时记得同步改这里。
 */

const BRAND = '#1677ff'
const BRAND_DEEP = '#2f6fed'

module.exports = { BRAND, BRAND_DEEP }
