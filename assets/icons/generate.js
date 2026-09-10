#!/usr/bin/env node
// 把 icons 目录下的 SVG 光栅化为 128×128 透明底白色 PNG（viewBox 24 单位）。
// 背景:2026-09-06 用 qlmanage 批量转的那批 PNG 丢失透明通道(白底白图不可用),
// 本脚本是零依赖的可靠再生成入口,用法:
//   node generate.js                 # 检查全部 png,重新生成"全不透明"的坏图
//   node generate.js a.svg b.svg    # 只重新生成指定 svg 对应的 png
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const SS = 4; // 每像素 4×4 超采样

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 路径解析(子路径化为折线) ---------- */
function arcPoints(x1, y1, rx, ry, fA, fS, x2, y2) {
  // SVG 规范的端点参数化转圆心参数化(本仓库图标 phi=0,保留通用公式)
  if (!rx || !ry) return [[x2, y2]];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
  const x1p = dx2, y1p = dy2;
  const rx2 = rx * rx, ry2 = ry * ry;
  let lambda = (x1p * x1p) / rx2 + (y1p * y1p) / ry2;
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  let num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  if (num < 0) num = 0;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let co = Math.sqrt(num / (den || 1));
  if (fA === fS) co = -co;
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cxp + (x1 + x2) / 2, cy = cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fS && dTheta > 0) dTheta -= 2 * Math.PI;
  if (fS && dTheta < 0) dTheta += 2 * Math.PI;
  const n = Math.max(8, Math.ceil(Math.abs(dTheta) / (Math.PI / 16)));
  const pts = [];
  for (let s = 1; s <= n; s++) {
    const t = theta1 + (dTheta * s) / n;
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return pts;
}
function cubicPoints(x1, y1, cx1, cy1, cx2, cy2, x2, y2) {
  const pts = [];
  for (let s = 1; s <= 16; s++) {
    const t = s / 16, u = 1 - t;
    pts.push([
      u * u * u * x1 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * x2,
      u * u * u * y1 + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t * t * t * y2
    ]);
  }
  return pts;
}
function quadPoints(x1, y1, cx, cy, x2, y2) {
  const pts = [];
  for (let s = 1; s <= 16; s++) {
    const t = s / 16, u = 1 - t;
    pts.push([u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2]);
  }
  return pts;
}

// 返回 [{ pts: [[x,y]...], closed: bool }]
function parsePath(d) {
  const toks = d.match(/[MmLlHhVvAaCcQqSsTtZz]|-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) || [];
  const subs = [];
  let cur = null, cx = 0, cy = 0, sx = 0, sy = 0, cmd = null, i = 0;
  const num = () => parseFloat(toks[i++]);
  const startSub = (x, y) => { cur = { pts: [[x, y]], closed: false }; subs.push(cur); cx = x; cy = y; sx = x; sy = y; };
  const lineTo = (x, y) => { if (!cur) return startSub(x, y); cur.pts.push([x, y]); cx = x; cy = y; };
  while (i < toks.length) {
    if (/^[A-Za-z]$/.test(toks[i])) { cmd = toks[i++]; if (cmd === 'Z' || cmd === 'z') { if (cur) { cur.closed = true; cur.pts.push([sx, sy]); cur = null; } continue; } }
    const rel = cmd === cmd.toLowerCase();
    const relx = rel ? cx : 0, rely = rel ? cy : 0;
    switch (cmd.toUpperCase()) {
      case 'M': {
        const x = num() + relx, y = num() + rely;
        startSub(x, y);
        // M/m 后续坐标对按 L/l 处理
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': lineTo(num() + relx, num() + rely); break;
      case 'H': lineTo(num() + relx, cy); break;
      case 'V': lineTo(cx, num() + rely); break;
      case 'C': {
        const x1 = num() + relx, y1 = num() + rely, x2 = num() + relx, y2 = num() + rely, x = num() + relx, y = num() + rely;
        for (const p of cubicPoints(cx, cy, x1, y1, x2, y2, x, y)) lineTo(p[0], p[1]);
        break;
      }
      case 'Q': {
        const x1 = num() + relx, y1 = num() + rely, x = num() + relx, y = num() + rely;
        for (const p of quadPoints(cx, cy, x1, y1, x, y)) lineTo(p[0], p[1]);
        break;
      }
      case 'S': {
        // 首控制点为上一段末控制点镜像;本仓库 SVG 未用到,做安全降级(直线段)
        const x2 = num() + relx, y2 = num() + rely, x = num() + relx, y = num() + rely;
        lineTo(x, y);
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), fA = num(), fS = num(), x = num() + relx, y = num() + rely;
        for (const p of arcPoints(cx, cy, rx, ry, fA, fS, x, y)) lineTo(p[0], p[1]);
        cx = x; cy = y;
        break;
      }
      default: i++; // 未知记号,跳过
    }
  }
  return subs;
}

/* ---------- 几何命中测试 ---------- */
function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1)));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}
function polysDist(subs, x, y) {
  let best = Infinity;
  for (const s of subs) {
    const pts = s.pts;
    for (let j = 1; j < pts.length; j++) {
      best = Math.min(best, segDist(x, y, pts[j - 1][0], pts[j - 1][1], pts[j][0], pts[j][1]));
    }
    if (s.closed && pts.length > 2) {
      best = Math.min(best, segDist(x, y, pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]));
    }
  }
  return best;
}
function polysInside(subs, x, y, rule) {
  let wn = 0, cross = 0;
  for (const s of subs) {
    const pts = s.pts;
    for (let j = 1; j < pts.length; j++) {
      const y1 = pts[j - 1][1], y2 = pts[j][1];
      if ((y1 > y) !== (y2 > y)) {
        const t = (y - y1) / (y2 - y1);
        const xAt = pts[j - 1][0] + t * (pts[j][0] - pts[j - 1][0]);
        if (x < xAt) { cross++; wn += y2 > y1 ? 1 : -1; }
      }
    }
  }
  return rule === 'evenodd' ? cross % 2 === 1 : wn !== 0;
}
function roundRectDist(x, y, rx0, ry0, w, h, r) {
  const cx = rx0 + w / 2, cy = ry0 + h / 2;
  const hx = w / 2 - r, hy = h / 2 - r;
  const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy;
  const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return out + Math.min(Math.max(qx, qy), 0) - r;
}
const isColor = (v) => v && v !== 'none' && v !== 'transparent';

/* ---------- SVG 元素收集 ---------- */
function collectShapes(svg) {
  const viewBox = (svg.match(/viewBox="([^"]*)"/) || [])[1] || '0 0 24 24';
  const [, , , vw, vh] = viewBox.split(/[\s,]+/).map(Number);
  const shapes = [];
  const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  for (const m of svg.match(/<(path|rect|circle|line|polyline)\b[^>]*\/?>/g) || []) {
    const a = attrs(m);
    const fill = isColor(a.fill), stroke = isColor(a.stroke);
    if (m.startsWith('<path')) {
      const subs = parsePath(a.d);
      if (fill) shapes.push({ t: 'fill', subs, rule: a['fill-rule'] || 'nonzero' });
      if (stroke) shapes.push({ t: 'stroke', subs, w: Number(a['stroke-width'] || 1) });
    } else if (m.startsWith('<rect')) {
      const r = Number(a.rx || 0), x = Number(a.x || 0), y = Number(a.y || 0), w = Number(a.width), h = Number(a.height);
      shapes.push({ t: 'rrect', x, y, w, h, r });
    } else if (m.startsWith('<circle')) {
      const cx = Number(a.cx), cy = Number(a.cy), r = Number(a.r);
      if (fill) shapes.push({ t: 'disk', cx, cy, r });
      if (stroke) shapes.push({ t: 'ring', cx, cy, r, w: Number(a['stroke-width'] || 1) });
    } else if (m.startsWith('<line')) {
      shapes.push({ t: 'stroke', subs: [{ pts: [[Number(a.x1), Number(a.y1)], [Number(a.x2), Number(a.y2)]], closed: false }], w: Number(a['stroke-width'] || 1) });
    } else if (m.startsWith('<polyline')) {
      const nums = (a.points || '').match(/-?(?:\d*\.\d+|\d+)/g).map(Number);
      const pts = [];
      for (let j = 0; j < nums.length; j += 2) pts.push([nums[j], nums[j + 1]]);
      shapes.push({ t: 'stroke', subs: [{ pts, closed: false }], w: Number(a['stroke-width'] || 1) });
    }
  }
  return { shapes, vw: vw || 24, vh: vh || 24 };
}

/* ---------- 渲染 ---------- */
function render(svgPath, outPath) {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const { shapes, vw, vh } = collectShapes(svg);
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const total = SS * SS;
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (vw * (px + (sx + 0.5) / SS)) / SIZE;
          const y = (vh * (py + (sy + 0.5) / SS)) / SIZE;
          for (const s of shapes) {
            let hit = false;
            if (s.t === 'fill') hit = polysInside(s.subs, x, y, s.rule);
            else if (s.t === 'stroke') hit = polysDist(s.subs, x, y) <= s.w / 2;
            else if (s.t === 'disk') hit = Math.hypot(x - s.cx, y - s.cy) <= s.r;
            else if (s.t === 'ring') hit = Math.abs(Math.hypot(x - s.cx, y - s.cy) - s.r) <= s.w / 2;
            else if (s.t === 'rrect') hit = roundRectDist(x, y, s.x, s.y, s.w, s.h, s.r) <= 0;
            if (hit) { cov++; break; }
          }
        }
      }
      const o = (py * SIZE + px) * 4;
      rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255;
      rgba[o + 3] = Math.round((255 * cov) / total);
    }
  }
  fs.writeFileSync(outPath, encodePNG(rgba, SIZE, SIZE));
}

/* ---------- 主流程:默认只修复"全不透明"的坏图 ---------- */
// 坏图(qlmanage 白底转换)整图 alpha 均为 255,而本脚本生成的图标是透明底。
// 早期实现只解压首行且假定 filter=0,曾漏检 list.png(非 filter-0 且首行恰好有
// 透明像素):这里做全图解码 + 全量 alpha 校验,正确还原 PNG filter 后再判定。
function decodeRgba(raw, w, h) {
  const rgba = new Uint8Array(w * h * 4);
  const stride = w * 4;
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const row = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[row + x];
      const left = x >= 4 ? rgba[out + x - 4] : 0;
      const up = y > 0 ? rgba[out - stride + x] : 0;
      const ul = x >= 4 && y > 0 ? rgba[out - stride + x - 4] : 0;
      let r;
      switch (filter) {
        case 1: r = v + left; break;
        case 2: r = v + up; break;
        case 3: r = v + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - ul;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
          r = v + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
          break;
        }
        default: r = v; break;
      }
      rgba[out + x] = r & 0xff;
    }
  }
  return rgba;
}

function isFullyOpaque(file) {
  if (!fs.existsSync(file)) return true;
  const buf = fs.readFileSync(file);
  // 找到 IDAT 并解压全图
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') {
      const raw = zlib.inflateSync(buf.subarray(off + 8, off + 8 + len));
      if (raw.length < 1 + SIZE * 4) return true; // 数据异常视为坏图
      const rgba = decodeRgba(raw, SIZE, SIZE);
      for (let i = 0; i < SIZE * SIZE; i++) {
        if (rgba[i * 4 + 3] < 8) return false;
      }
      return true;
    }
    off += 12 + len;
  }
  return false;
}

const args = process.argv.slice(2);
let targets;
if (args.length) {
  targets = args;
} else {
  const roots = [__dirname, path.join(__dirname, 'fa')];
  targets = roots.flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).map((f) => path.join(dir, f)))
    .filter((svg) => isFullyOpaque(svg.replace(/\.svg$/, '.png')));
}
if (!targets.length) {
  console.log('没有需要修复的图标');
  process.exit(0);
}
for (const svg of targets) {
  const out = svg.replace(/\.svg$/, '.png');
  render(svg, out);
  console.log('已生成', path.relative(process.cwd(), out));
}
