'use strict';
/**
 * make_splices.js — 构造「系统测试数据」
 *
 * 赛题要求：「一批由 AI 生成的高仿伪造内容样本（如 AIGC 生成种草文案/图片、虚假评论样本等），
 * 用于在选定场景下测试或者评估 Agent」。
 *
 * 本脚本负责图像侧。它把
 *   - dataset/raw/real/  真实相机照片（负样本来源，必须真人拍摄）
 *   - dataset/raw/ai/    真实 AIGC 产物（正样本来源，必须来自扩散模型等生成工具）
 * 合成为四类带 ground truth 的样本，并为篡改类输出像素级 mask，
 * 使评测不仅能算「判没判对」，还能算「可疑区域定位准不准」。
 *
 * 用法：
 *   node tools/make_splices.js                # 用真实素材构造
 *   node tools/make_splices.js --demo         # 无素材时，用程序化素材跑通流程（仅供验证工具链）
 *   node tools/make_splices.js --seed 42      # 指定随机种子，保证可复现
 *
 * 设计原则：
 *   1) 零第三方依赖（PNG 编解码见 tools/png.js）
 *   2) 可复现：同一 seed + 同一素材 = 同一份数据集
 *   3) 诚实：程序化素材会在 manifest 里标记 synthetic=true，评测时须显式排除
 */

var fs = require('fs');
var path = require('path');
var png = require('./png.js');

var ROOT = path.resolve(__dirname, '..');
var DIR = {
  real: path.join(ROOT, 'dataset', 'raw', 'real'),
  ai: path.join(ROOT, 'dataset', 'raw', 'ai'),
  demoreal: path.join(ROOT, 'dataset', 'raw', '_demo_real'),
  demoai: path.join(ROOT, 'dataset', 'raw', '_demo_ai'),
  samples: path.join(ROOT, 'dataset', 'samples'),
  masks: path.join(ROOT, 'dataset', 'masks')
};

var MAX_EDGE = 1024;          // 样本最长边，兼顾取证精度与体积
var FEATHER = 6;              // 拼接边缘羽化像素，避免留下肉眼可见的硬边

/* ---------------- 可复现随机 ---------------- */

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var rnd = mulberry32(20260921);

/* ---------------- 图像基础操作 ---------------- */

function loadPNG(p) {
  var d = png.decodePNG(fs.readFileSync(p));
  return { w: d.width, h: d.height, data: d.data };
}
function savePNG(p, w, h, data, gray) {
  fs.writeFileSync(p, png.encodePNG(w, h, data, gray));
}
function cloneImg(im) {
  return { w: im.w, h: im.h, data: new Uint8Array(im.data) };
}

/** 限制最长边，保持宽高比（双线性） */
function fitEdge(im, maxEdge) {
  var s = Math.min(1, maxEdge / Math.max(im.w, im.h));
  if (s >= 1) return im;
  return resize(im, Math.max(8, Math.round(im.w * s)), Math.max(8, Math.round(im.h * s)));
}

function resize(im, dw, dh) {
  var out = new Uint8Array(dw * dh * 4);
  var xr = im.w / dw, yr = im.h / dh;
  for (var y = 0; y < dh; y++) {
    var sy = Math.min(im.h - 1, y * yr), y0 = Math.floor(sy), y1 = Math.min(im.h - 1, y0 + 1), fy = sy - y0;
    for (var x = 0; x < dw; x++) {
      var sx = Math.min(im.w - 1, x * xr), x0 = Math.floor(sx), x1 = Math.min(im.w - 1, x0 + 1), fx = sx - x0;
      var di = (y * dw + x) * 4;
      for (var c = 0; c < 4; c++) {
        var a = im.data[(y0 * im.w + x0) * 4 + c], b = im.data[(y0 * im.w + x1) * 4 + c];
        var cc = im.data[(y1 * im.w + x0) * 4 + c], d = im.data[(y1 * im.w + x1) * 4 + c];
        var t = a + (b - a) * fx, u = cc + (d - cc) * fx;
        out[di + c] = Math.round(t + (u - t) * fy);
      }
    }
  }
  return { w: dw, h: dh, data: out };
}

/** 可分离高斯模糊（近似，三次 box），仅作用于指定矩形区域 */
function blurRegion(im, rx, ry, rw, rh, radius) {
  if (radius < 1) return;
  var W = im.w, H = im.h;
  var x0 = Math.max(0, rx), y0 = Math.max(0, ry);
  var x1 = Math.min(W, rx + rw), y1 = Math.min(H, ry + rh);
  if (x1 <= x0 || y1 <= y0) return;
  var tmp = new Float32Array((x1 - x0) * (y1 - y0) * 4);
  var bw = x1 - x0, bh = y1 - y0, ch, i, x, y;
  for (y = 0; y < bh; y++) for (x = 0; x < bw; x++) {
    var si = ((y0 + y) * W + (x0 + x)) * 4;
    for (ch = 0; ch < 3; ch++) tmp[(y * bw + x) * 4 + ch] = im.data[si + ch];
    tmp[(y * bw + x) * 4 + 3] = 255;
  }
  for (var pass = 0; pass < 3; pass++) {
    // 横向
    var h2 = new Float32Array(tmp.length);
    for (y = 0; y < bh; y++) for (x = 0; x < bw; x++) for (ch = 0; ch < 3; ch++) {
      var sum = 0, n = 0;
      for (var k = -radius; k <= radius; k++) {
        var xx = x + k; if (xx < 0 || xx >= bw) continue;
        sum += tmp[(y * bw + xx) * 4 + ch]; n++;
      }
      h2[(y * bw + x) * 4 + ch] = sum / n;
    }
    // 纵向
    for (y = 0; y < bh; y++) for (x = 0; x < bw; x++) for (ch = 0; ch < 3; ch++) {
      var s2 = 0, m = 0;
      for (var k2 = -radius; k2 <= radius; k2++) {
        var yy = y + k2; if (yy < 0 || yy >= bh) continue;
        s2 += h2[(yy * bw + x) * 4 + ch]; m++;
      }
      tmp[(y * bw + x) * 4 + ch] = s2 / m;
    }
  }
  for (y = 0; y < bh; y++) for (x = 0; x < bw; x++) {
    var di = ((y0 + y) * W + (x0 + x)) * 4;
    for (ch = 0; ch < 3; ch++) im.data[di + ch] = Math.max(0, Math.min(255, Math.round(tmp[(y * bw + x) * 4 + ch])));
    im.data[di + 3] = 255;
  }
}

/** 轻量调色（模拟美颜 App 的一键美化：提亮 + 降对比） */
function beautyAdjust(im, gain, lift) {
  for (var i = 0; i < im.data.length; i += 4) {
    for (var c = 0; c < 3; c++) {
      var v = im.data[i + c];
      v = 128 + (v - 128) * gain + lift;
      im.data[i + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
}

/* ---------------- 掩码与贴片 ---------------- */

/**
 * 生成羽化掩码。shape: 'rect' | 'ellipse'
 * 返回 Float32Array，值域 0..1
 */
function makeMask(w, h, shape, feather) {
  var m = new Float32Array(w * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var v;
      if (shape === 'ellipse') {
        var nx = (x / (w - 1)) * 2 - 1, ny = (y / (h - 1)) * 2 - 1;
        var r = Math.sqrt(nx * nx + ny * ny);
        v = r <= 1 - (feather * 2 / Math.min(w, h)) ? 1 : (r >= 1 ? 0 : (1 - r) / (feather * 2 / Math.min(w, h)));
      } else {
        var dx = Math.min(x, w - 1 - x), dy = Math.min(y, h - 1 - y);
        var e = Math.min(dx, dy);
        v = e >= feather ? 1 : e / feather;
      }
      m[y * w + x] = Math.max(0, Math.min(1, v));
    }
  }
  return m;
}

/** 从 donor 裁一块并缩放到目标尺寸 */
function cropAndFit(donor, tw, th) {
  // 取 donor 中心区域，按目标宽高比裁剪后缩放
  var ar = tw / th;
  var cw = donor.w, chh = Math.round(donor.w / ar);
  if (chh > donor.h) { chh = donor.h; cw = Math.round(donor.h * ar); }
  var cx = Math.floor((donor.w - cw) / 2), cy = Math.floor((donor.h - chh) / 2);
  var sub = { w: cw, h: chh, data: new Uint8Array(cw * chh * 4) };
  for (var y = 0; y < chh; y++) {
    var si = ((cy + y) * donor.w + cx) * 4, di = y * cw * 4;
    sub.data.set(donor.data.subarray(si, si + cw * 4), di);
  }
  return resize(sub, tw, th);
}

/**
 * 把 patch 按 mask 贴到 base 上。
 * 返回 { image, maskFull } —— maskFull 是与 base 同尺寸的 0/255 灰度数组（贴片区域=255）
 */
function paste(base, patch, x, y, mask) {
  var out = cloneImg(base);
  var maskFull = new Uint8Array(base.w * base.h * 4);
  for (var py = 0; py < patch.h; py++) {
    var dy = y + py;
    if (dy < 0 || dy >= base.h) continue;
    for (var px = 0; px < patch.w; px++) {
      var dx = x + px;
      if (dx < 0 || dx >= base.w) continue;
      var a = mask[py * patch.w + px];
      if (a <= 0) continue;
      var di = (dy * base.w + dx) * 4, si = (py * patch.w + px) * 4;
      for (var c = 0; c < 3; c++) {
        out.data[di + c] = Math.round(base.data[di + c] * (1 - a) + patch.data[si + c] * a);
      }
      out.data[di + 3] = 255;
      if (a > 0.5) { maskFull[di] = maskFull[di + 1] = maskFull[di + 2] = 255; maskFull[di + 3] = 255; }
    }
  }
  return { image: out, maskFull: maskFull };
}

/* ---------------- 程序化 demo 素材（仅供跑通流程） ---------------- */

function synthReal(w, h, seed) {
  var r = mulberry32(seed);
  var im = { w: w, h: h, data: new Uint8Array(w * h * 4) };
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var i = (y * w + x) * 4;
    // 模拟带纹理的实拍：渐变背景 + 颗粒噪声 + 暗角
    var bg = 120 + 60 * Math.sin(x / 90) + 40 * Math.cos(y / 70);
    var grain = (r() - 0.5) * 26;                       // 传感器噪声
    var cx = x / w - 0.5, cy = y / h - 0.5;
    var vig = 1 - 0.35 * (cx * cx + cy * cy) * 2;       // 镜头暗角
    var v = (bg + grain) * vig;
    im.data[i] = Math.max(0, Math.min(255, v * 1.05));
    im.data[i + 1] = Math.max(0, Math.min(255, v * 0.95));
    im.data[i + 2] = Math.max(0, Math.min(255, v * 0.9));
    im.data[i + 3] = 255;
  }
  return im;
}

function synthAI(w, h, seed) {
  var r = mulberry32(seed);
  var im = { w: w, h: h, data: new Uint8Array(w * h * 4) };
  // 极平滑、几乎无噪声 —— 扩散模型去噪后的典型统计特征
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var i = (y * w + x) * 4;
    var v = 150 + 70 * Math.sin(x / 130) * Math.cos(y / 110) + (r() - 0.5) * 2.5;
    im.data[i] = Math.max(0, Math.min(255, v));
    im.data[i + 1] = Math.max(0, Math.min(255, v * 0.98 + 8));
    im.data[i + 2] = Math.max(0, Math.min(255, v * 1.02 + 14));
    im.data[i + 3] = 255;
  }
  return im;
}

/* ---------------- 主流程 ---------------- */

function listImages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(function (f) { return /\.png$/i.test(f); })
    .map(function (f) { return path.join(dir, f); });
}

function main() {
  var argv = process.argv.slice(2);
  var demo = argv.indexOf('--demo') >= 0;
  var si = argv.indexOf('--seed');
  if (si >= 0 && argv[si + 1]) rnd = mulberry32(parseInt(argv[si + 1], 10) || 1);

  var realDir = DIR.real, aiDir = DIR.ai, synthetic = false;

  if (demo) {
    realDir = DIR.demoreal; aiDir = DIR.demoai; synthetic = true;
    [realDir, aiDir].forEach(function (d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
    for (var k = 0; k < 3; k++) {
      savePNG(path.join(realDir, 'demo_real_' + k + '.png'), 900, 700, synthReal(900, 700, 1000 + k).data);
      savePNG(path.join(aiDir, 'demo_ai_' + k + '.png'), 1024, 1024, synthAI(1024, 1024, 2000 + k).data);
    }
    console.log('[demo] 已生成程序化素材（仅供验证工具链，不可用于评测）');
  }

  var reals = listImages(realDir), ais = listImages(aiDir);
  if (!reals.length || !ais.length) {
    console.error('\n缺少素材。请准备：');
    console.error('  dataset/raw/real/  真实相机照片（手机实拍，PNG 格式）—— 负样本来源，必须是真货');
    console.error('  dataset/raw/ai/    真实 AIGC 图片（通义万相/SD/MJ 等生成，PNG 格式）—— 正样本来源');
    console.error('\n没有素材时可用  node tools/make_splices.js --demo  跑通流程（产出的样本不参与评测）。\n');
    process.exit(2);
  }

  var poolReal = reals.map(function (p) { return fitEdge(loadPNG(p), MAX_EDGE); });
  var poolAI = ais.map(function (p) { return fitEdge(loadPNG(p), MAX_EDGE); });
  console.log('素材：真实 ' + reals.length + ' 张，AIGC ' + ais.length + ' 张');

  var samples = [];
  var seq = 0;

  function emit(id, img, label, category, extra) {
    var sp = path.join(DIR.samples, id + '.png');
    savePNG(sp, img.w, img.h, img.data);
    var rec = {
      id: id,
      image: 'samples/' + id + '.png',
      category: category,
      label: label,                 // authentic | ai_generated | tampered
      synthetic: synthetic,         // 程序化素材标记，评测须排除
      width: img.w, height: img.h
    };
    if (extra && extra.maskPath) rec.mask = extra.maskPath;
    if (extra) for (var kk in extra) if (kk !== 'maskPath') rec[kk] = extra[kk];
    samples.push(rec);
  }

  // ① 真实原图（负样本）
  poolReal.forEach(function (im, i) {
    emit('real_' + pad(++seq), im, 'authentic', 'real_original', { source: reals[i].replace(ROOT + path.sep, '').replace(/\\/g, '/') });
  });

  // ② AI 原图（正样本：纯生成）
  poolAI.forEach(function (im, i) {
    emit('ai_' + pad(++seq), im, 'ai_generated', 'ai_plain', { source: ais[i].replace(ROOT + path.sep, '').replace(/\\/g, '/') });
  });

  // ③ 拼接篡改：真实底图 + AI 贴片（带 mask）
  poolReal.forEach(function (base, i) {
    var donor = poolAI[i % poolAI.length];
    var shape = rnd() < 0.5 ? 'ellipse' : 'rect';
    var fw = Math.round(base.w * (0.22 + rnd() * 0.16));
    var fh = Math.round(base.h * (0.22 + rnd() * 0.16));
    var px = Math.round(rnd() * (base.w - fw));
    var py = Math.round(rnd() * (base.h - fh));
    var patch = cropAndFit(donor, fw, fh);
    var mask = makeMask(fw, fh, shape, FEATHER);
    var res = paste(base, patch, px, py, mask);
    var id = 'splice_' + pad(++seq);
    savePNG(path.join(DIR.masks, id + '.png'), base.w, base.h, res.maskFull, true);
    emit(id, res.image, 'tampered', 'splice_ai_into_real', {
      maskPath: 'masks/' + id + '.png',
      region: { x: px, y: py, w: fw, h: fh, shape: shape, feather: FEATHER },
      donor: path.basename(ais[i % poolAI.length])
    });
  });

  // ④ 真实图 + 美颜处理（负样本，但极易被误报 —— 用来测误报率）
  poolReal.forEach(function (im, i) {
    var b = cloneImg(im);
    var rw = Math.round(b.w * 0.45), rh = Math.round(b.h * 0.45);
    var rx = Math.round(rnd() * (b.w - rw)), ry = Math.round(rnd() * (b.h - rh));
    blurRegion(b, rx, ry, rw, rh, 2);          // 局部磨皮
    beautyAdjust(b, 0.92, 12);                 // 提亮降对比
    emit('retouch_' + pad(++seq), b, 'authentic', 'retouched_real', {
      note: '真实照片经美颜处理，ground truth 仍为真实，用于测量误报率',
      region: { x: rx, y: ry, w: rw, h: rh, shape: 'rect' }
    });
  });

  var manifest = {
    version: '1.0',
    created: new Date().toISOString(),
    generator: 'tools/make_splices.js',
    seed: null,
    synthetic: synthetic,
    labels: {
      authentic: '真实拍摄，未经合成替换（可含美颜）',
      ai_generated: '整幅由生成模型产出',
      tampered: '真实底图被拼接/替换过局部区域'
    },
    counts: countBy(samples, 'label'),
    samples: samples
  };
  fs.writeFileSync(path.join(ROOT, 'dataset', 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('已生成 ' + samples.length + ' 个样本 → dataset/samples/');
  console.log('  真实 ' + manifest.counts.authentic + ' · AIGC ' + manifest.counts.ai_generated + ' · 篡改 ' + manifest.counts.tampered);
  console.log('清单 → dataset/manifest.json');
  if (synthetic) console.log('注意：当前为程序化素材（synthetic=true），不可用于评测，仅验证工具链。');
}

function pad(n) { return n < 10 ? '000' + n : n < 100 ? '00' + n : n < 1000 ? '0' + n : '' + n; }
function countBy(arr, key) {
  var o = {};
  arr.forEach(function (x) { o[x[key]] = (o[x[key]] || 0) + 1; });
  return o;
}

main();
