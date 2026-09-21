# `png.js`

> 源文件 `tools/png.js` · 语言 `javascript` · 5746 字节 · 165 行

```javascript
'use strict';
/**
 * png.js — 最小 PNG 编解码（仅依赖 Node 内置 zlib，无第三方包）
 *
 * 只支持赛题数据集用得到的子集：
 *   位深 8、非隔行、颜色类型 2(RGB) / 6(RGBA) / 0(灰度)
 * 解码统一输出 RGBA，编码统一输出 RGBA（colorType 6）或灰度（colorType 0）。
 *
 * 之所以自己写：本项目其余部分都是零依赖、可离线跑的，
 * 数据集构造脚本也应该能在任何一台装了 Node 的机器上直接跑起来。
 */

var zlib = require('zlib');

/* ---------------- CRC32 ---------------- */

var CRC_TABLE = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  var c = -1;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------------- 解码 ---------------- */

var SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

function u32(b, o) { return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }

function decodePNG(buf) {
  if (buf.length < 8) throw new Error('不是 PNG：文件过短');
  for (var s = 0; s < 8; s++) if (buf[s] !== SIG[s]) throw new Error('不是 PNG：文件头不符');

  var off = 8, ihdr = null, idat = [], plte = null;
  while (off + 8 <= buf.length) {
    var len = u32(buf, off);
    var type = buf.toString('ascii', off + 4, off + 8);
    var data = buf.slice(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = data;
    else if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR');

  var w = u32(ihdr, 0), h = u32(ihdr, 4);
  var depth = ihdr[8], colorType = ihdr[9], interlace = ihdr[12];
  if (depth !== 8) throw new Error('仅支持 8 位深，当前 ' + depth);
  if (interlace !== 0) throw new Error('不支持隔行扫描 PNG');
  if (colorType !== 0 && colorType !== 2 && colorType !== 3 && colorType !== 6) {
    throw new Error('不支持的颜色类型 ' + colorType);
  }

  var channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : 4;
  var raw = zlib.inflateSync(Buffer.concat(idat));
  var stride = w * channels;
  var out = Buffer.alloc(w * h * 4, 255);

  // 逐行反过滤
  var prev = Buffer.alloc(stride, 0);
  var cur = Buffer.alloc(stride, 0);
  var p = 0;
  for (var y = 0; y < h; y++) {
    var ft = raw[p++];
    raw.copy(cur, 0, p, p + stride);
    p += stride;
    unfilter(ft, cur, prev, stride, channels, w);
    // 写入 RGBA
    for (var x = 0; x < w; x++) {
      var si = x * channels, di = (y * w + x) * 4;
      if (colorType === 0) { out[di] = out[di + 1] = out[di + 2] = cur[si]; out[di + 3] = 255; }
      else if (colorType === 2) { out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2]; out[di + 3] = 255; }
      else if (colorType === 3) { // 调色板
        var pi = cur[si] * 3;
        out[di] = plte[pi]; out[di + 1] = plte[pi + 1]; out[di + 2] = plte[pi + 2]; out[di + 3] = 255;
      } else {
        out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2]; out[di + 3] = cur[si + 3];
      }
    }
    cur.copy(prev);
  }
  return { width: w, height: h, data: new Uint8Array(out) };
}

function paeth(a, b, c) {
  var pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

function unfilter(ft, cur, prev, stride, channels, w) {
  var i, x;
  if (ft === 0) return;
  if (ft === 1) {
    for (i = channels; i < stride; i++) cur[i] = (cur[i] + cur[i - channels]) & 0xFF;
  } else if (ft === 2) {
    for (i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 0xFF;
  } else if (ft === 3) {
    for (i = 0; i < stride; i++) {
      var a = i >= channels ? cur[i - channels] : 0;
      cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xFF;
    }
  } else if (ft === 4) {
    for (x = 0; x < stride; x++) {
      var aa = x >= channels ? cur[x - channels] : 0;
      var bb = prev[x];
      var cc = x >= channels ? prev[x - channels] : 0;
      cur[x] = (cur[x] + paeth(aa, bb, cc)) & 0xFF;
    }
  } else throw new Error('未知滤波器类型 ' + ft);
}

/* ---------------- 编码 ---------------- */

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** rgba: Uint8Array/Buffer，长度 w*h*4 */
function encodePNG(w, h, rgba, grayscale) {
  var colorType = grayscale ? 0 : 6;
  var channels = grayscale ? 1 : 4;
  var stride = w * channels;
  var raw = Buffer.alloc((stride + 1) * h);
  var p = 0;
  for (var y = 0; y < h; y++) {
    raw[p++] = 0; // filter: None
    for (var x = 0; x < w; x++) {
      var si = (y * w + x) * 4;
      if (grayscale) {
        raw[p++] = (rgba[si] * 299 + rgba[si + 1] * 587 + rgba[si + 2] * 114) / 1000 | 0;
      } else {
        raw[p++] = rgba[si]; raw[p++] = rgba[si + 1];
        raw[p++] = rgba[si + 2]; raw[p++] = rgba[si + 3];
      }
    }
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from(SIG),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { decodePNG: decodePNG, encodePNG: encodePNG };

```
