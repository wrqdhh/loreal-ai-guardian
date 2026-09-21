/* ============================================================
 * engine.js — 本地内容取证引擎
 * 纯浏览器实现，无外部依赖、无网络请求、可完全离线运行。
 * 设计原则：只产出「可解释证据」(evidence)，不产出黑盒分数。
 * 每条证据都能回答三个问题：看到了什么 / 在哪 / 为什么可疑。
 * ============================================================ */
(function (global) {
  'use strict';

  var MAX_SIDE = 448;          // 分析尺度上限，兼顾速度与块级统计精度
  var BLOCK = 16;              // 证据块边长

  /* ---------------- 基础工具 ---------------- */
  var U = {
    clamp: function (v, a, b) { return v < a ? a : v > b ? b : v; },
    mean: function (a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; },
    std: function (a) {
      var m = U.mean(a), s = 0;
      for (var i = 0; i < a.length; i++) { var d = a[i] - m; s += d * d; }
      return a.length ? Math.sqrt(s / a.length) : 0;
    },
    median: function (a) {
      var b = Array.prototype.slice.call(a).sort(function (x, y) { return x - y; });
      return b[Math.floor(b.length / 2)];
    },
    fmt: function (v, n) { return (Math.round(v * Math.pow(10, n || 2)) / Math.pow(10, n || 2)).toFixed(n || 2); }
  };

  function decodeImage(src) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('图片解码失败')); };
      im.src = src;
    });
  }

  /* ---------------- 1. 元数据探针 ----------------
   * 真实可用的强信号：AI 生成图往往缺少相机 EXIF，
   * 或在 PNG tEXt 中残留生成工具签名（A1111 的 parameters / ComfyUI 的 prompt 等）。
   */
  function probeMetadata(buf, mime, name) {
    var bytes = new Uint8Array(buf);
    var head = bytes.subarray(0, Math.min(bytes.length, 131072));
    var ascii = '';
    for (var i = 0; i < head.length; i++) ascii += String.fromCharCode(head[i]);

    var isJpeg = (head[0] === 0xFF && head[1] === 0xD8) || /jpe?g/i.test(mime || '');
    var isPng = (head[0] === 0x89 && head[1] === 0x50) || /png/i.test(mime || '');
    var isWebp = /webp/i.test(mime || '') || ascii.indexOf('WEBP') >= 0;

    var out = {
      format: isJpeg ? 'JPEG' : isPng ? 'PNG' : isWebp ? 'WebP' : (name || '').split('.').pop().toUpperCase(),
      sizeKB: Math.round(buf.byteLength / 1024),
      hasExif: ascii.indexOf('Exif') >= 0,
      hasGps: ascii.indexOf('GPS') >= 0,
      camera: null,
      software: null,
      aiTool: null,
      texts: []
    };

    var CAMERA = ['Canon', 'NIKON', 'SONY', 'Apple', 'Xiaomi', 'HUAWEI', 'samsung', 'Samsung',
      'OPPO', 'vivo', 'FUJIFILM', 'Panasonic', 'OLYMPUS', 'Leica', 'Google', 'HONOR', 'realme',
      'OnePlus', 'motorola', 'REDMI', 'Nubia', 'Meitu', 'CASIO'];
    for (var c = 0; c < CAMERA.length; c++) {
      if (ascii.indexOf(CAMERA[c]) >= 0) { out.camera = CAMERA[c]; break; }
    }

    var AI_SIG = [
      ['Stable Diffusion', 'Stable Diffusion'], ['ComfyUI', 'ComfyUI'], ['NovelAI', 'NovelAI'],
      ['Midjourney', 'Midjourney'], ['DALL', 'DALL·E'], ['Automatic1111', 'AUTOMATIC1111'],
      ['InvokeAI', 'InvokeAI'], ['Fooocus', 'Fooocus'], ['Flux', 'FLUX'], ['ideogram', 'Ideogram']
    ];
    for (var a = 0; a < AI_SIG.length; a++) {
      if (ascii.indexOf(AI_SIG[a][0]) >= 0) { out.aiTool = AI_SIG[a][1]; break; }
    }

    if (isPng) {
      var off = 8, guard = 0;
      while (off + 8 <= bytes.length && out.texts.length < 24 && guard++ < 4096) {
        var len = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
        var type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
        if (len < 0 || off + 12 + len > bytes.length) break;
        if (type === 'tEXt' || type === 'iTXt') {
          var chunk = bytes.subarray(off + 8, off + 8 + Math.min(len, 4096));
          var s = '';
          for (var k = 0; k < chunk.length; k++) s += (chunk[k] === 0 ? ' | ' : String.fromCharCode(chunk[k]));
          out.texts.push(type + ' → ' + s.replace(/\s+/g, ' ').trim());
          if (!out.aiTool && /prompt|negative|steps:|sampler|cfg scale|seed/i.test(s)) out.aiTool = 'AI 生成管线（tEXt 参数残留）';
        }
        if (type === 'IEND') break;
        off += 12 + len;
      }
    }

    var swMatch = ascii.match(/(?:Adobe Photoshop|Lightroom|Snapseed|Faceu|B612|Meitu|PicArt|PicsArt|SnapSeed|VSCO|醒图|美图秀秀|黄油相机)/);
    if (swMatch) out.software = swMatch[0];

    return out;
  }

  /* ---------------- 2. 图像取证 ---------------- */
  function prepareCanvas(img) {
    var ow = img.naturalWidth || img.width, oh = img.naturalHeight || img.height;
    var scale = Math.min(1, MAX_SIDE / Math.max(ow, oh));
    var w = Math.max(BLOCK * 2, Math.round(ow * scale));
    var h = Math.max(BLOCK * 2, Math.round(oh * scale));
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return { canvas: cv, ctx: ctx, w: w, h: h, ow: ow, oh: oh, data: ctx.getImageData(0, 0, w, h).data };
  }

  function toGray(data, w, h) {
    var g = new Float32Array(w * h);
    for (var i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    return g;
  }

  function median3(g, w, h) {
    var out = new Float32Array(w * h), buf = new Float32Array(9);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var n = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = U.clamp(y + dy, 0, h - 1) * w;
          for (var dx = -1; dx <= 1; dx++) buf[n++] = g[yy + U.clamp(x + dx, 0, w - 1)];
        }
        for (var i = 1; i < 9; i++) { var v = buf[i], j = i - 1; while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; } buf[j + 1] = v; }
        out[y * w + x] = buf[4];
      }
    }
    return out;
  }

  function blockStats(values, w, h, B) {
    var bw = Math.floor(w / B), bh = Math.floor(h / B);
    var means = new Float32Array(bw * bh), stds = new Float32Array(bw * bh);
    for (var by = 0; by < bh; by++) {
      for (var bx = 0; bx < bw; bx++) {
        var s = 0, n = B * B, tmp = new Float32Array(n), t = 0;
        for (var y = 0; y < B; y++) {
          for (var x = 0; x < B; x++) { var v = values[(by * B + y) * w + bx * B + x]; s += v; tmp[t++] = v; }
        }
        var m = s / n, acc = 0;
        for (var k = 0; k < n; k++) { var d = tmp[k] - m; acc += d * d; }
        means[by * bw + bx] = m;
        stds[by * bw + bx] = Math.sqrt(acc / n);
      }
    }
    return { means: means, stds: stds, bw: bw, bh: bh };
  }

  function zscores(arr) {
    var m = U.mean(arr), sd = U.std(arr) || 1e-6, out = new Float32Array(arr.length);
    for (var i = 0; i < arr.length; i++) out[i] = (arr[i] - m) / sd;
    return { z: out, mean: m, std: sd };
  }

  function rgbFamily(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var l = (mx + mn) / 510;
    var s = d === 0 ? 0 : d / (255 - Math.abs(mx + mn - 255) || 1);
    if (s < 0.10) return l < 0.24 ? '黑' : l > 0.86 ? '白' : '灰';
    var h;
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    if (h < 12 || h >= 340) return (l > 0.68 && s < 0.62) ? '粉' : '红';
    if (h < 40) return '橙';
    if (h < 68) return '黄';
    if (h < 160) return '绿';
    if (h < 195) return '青';
    if (h < 250) return '蓝';
    if (h < 300) return '紫';
    return '粉';
  }

  function dominantColors(data, w, h) {
    var map = {}, step = Math.max(1, Math.floor(Math.sqrt((w * h) / 45000)));
    for (var y = 0; y < h; y += step) {
      for (var x = 0; x < w; x += step) {
        var p = (y * w + x) * 4, r = data[p], g = data[p + 1], b = data[p + 2];
        var key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        var e = map[key] || (map[key] = { n: 0, r: 0, g: 0, b: 0 });
        e.n++; e.r += r; e.g += g; e.b += b;
      }
    }
    var arr = [], total = 0;
    for (var k in map) { var v = map[k]; total += v.n; arr.push({ n: v.n, r: v.r / v.n, g: v.g / v.n, b: v.b / v.n }); }
    arr.sort(function (a, b) { return b.n - a.n; });
    return arr.slice(0, 6).map(function (e) {
      var R = Math.round(e.r), G = Math.round(e.g), B = Math.round(e.b);
      return { r: R, g: G, b: B, share: e.n / total, family: rgbFamily(R, G, B), hex: '#' + [R, G, B].map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('') };
    });
  }

  var AI_SIZES = [512, 768, 896, 1024, 1152, 1536, 2048];

  /** 异常块聚类：把零散的 z 值异常块按四连通聚成区块，并用两个几何判据过滤假阳性
   *  ——这是本引擎最关键的一步。物体边缘、文字笔画也会造成零散异常块，
   *  但它们是「细线/空心环」；真实拼接、局部替换则会形成「实心矩形团块」。
   *  minFill（团块填充率）用来剔除空心环，maxAreaRatio 用来剔除大片天空等天然平滑区。
   */
  function clusterAnomalies(z, bw, bh, dir, thr, minSize, minFill, maxAreaRatio, mask) {
    var n = bw * bh, seen = new Uint8Array(n), comps = [];
    function hit(i) {
      if (mask && !mask[i]) return false;
      return dir > 0 ? z[i] > thr : z[i] < -thr;
    }
    for (var i = 0; i < n; i++) {
      if (seen[i] || !hit(i)) continue;
      var stack = [i], cells = [];
      seen[i] = 1;
      while (stack.length) {
        var c = stack.pop();
        cells.push(c);
        var cx = c % bw, cy = (c - cx) / bw;
        if (cx > 0 && !seen[c - 1] && hit(c - 1)) { seen[c - 1] = 1; stack.push(c - 1); }
        if (cx < bw - 1 && !seen[c + 1] && hit(c + 1)) { seen[c + 1] = 1; stack.push(c + 1); }
        if (cy > 0 && !seen[c - bw] && hit(c - bw)) { seen[c - bw] = 1; stack.push(c - bw); }
        if (cy < bh - 1 && !seen[c + bw] && hit(c + bw)) { seen[c + bw] = 1; stack.push(c + bw); }
      }
      if (cells.length < minSize) continue;
      var minx = bw, maxx = -1, miny = bh, maxy = -1;
      for (var k = 0; k < cells.length; k++) {
        var x = cells[k] % bw, y = (cells[k] - x) / bw;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      var bboxW = maxx - minx + 1, bboxH = maxy - miny + 1;
      var fill = cells.length / (bboxW * bboxH);
      var areaRatio = cells.length / n;
      if (fill < minFill) continue;
      if (maxAreaRatio && areaRatio > maxAreaRatio) continue;
      comps.push({ size: cells.length, bx: minx, by: miny, bw: bboxW, bh: bboxH, fill: fill, areaRatio: areaRatio });
    }
    comps.sort(function (a, b) { return b.size - a.size; });
    return comps;
  }

  function describeCluster(c, scale) {
    return '位置约 (' + Math.round(c.bx * BLOCK * scale) + ', ' + Math.round(c.by * BLOCK * scale) + ') · 尺寸约 ' +
      Math.round(c.bw * BLOCK * scale) + '×' + Math.round(c.bh * BLOCK * scale) + ' 像素 · 占全图 ' +
      U.fmt(c.areaRatio * 100, 1) + '%';
  }

  /** 图像取证主入口：返回证据数组 + 可视化所需的热区数据 */
  async function imageForensics(img) {
    var prep = prepareCanvas(img);
    var w = prep.w, h = prep.h, data = prep.data;
    var signals = [];
    var t0 = performance.now();

    /* --- 2.1 ELA 误差水平分析：重压缩差分 --- */
    var elaBlockZ = null, elaHotRatio = 0, elaUniform = 0, elaMap = null, elaColds = [];
    try {
      var url = prep.canvas.toDataURL('image/jpeg', 0.9);
      var re = await decodeImage(url);
      var cv2 = document.createElement('canvas');
      cv2.width = w; cv2.height = h;
      var ctx2 = cv2.getContext('2d', { willReadFrequently: true });
      ctx2.drawImage(re, 0, 0, w, h);
      var d2 = ctx2.getImageData(0, 0, w, h).data;
      elaMap = new Float32Array(w * h);
      for (var i = 0, p = 0; i < elaMap.length; i++, p += 4) {
        elaMap[i] = (Math.abs(data[p] - d2[p]) + Math.abs(data[p + 1] - d2[p + 1]) + Math.abs(data[p + 2] - d2[p + 2])) / 3;
      }
      var es = blockStats(elaMap, w, h, BLOCK);
      var ez = zscores(es.means);
      elaBlockZ = { z: ez.z, means: es.means, bw: es.bw, bh: es.bh };
      var hot = 0;
      for (var q = 0; q < ez.z.length; q++) if (ez.z[q] > 2.5) hot++;
      elaHotRatio = hot / ez.z.length;
      elaUniform = ez.mean > 0 ? 1 - U.clamp(ez.std / ez.mean, 0, 1) : 1;
    } catch (e) { /* ELA 失败不阻断其他证据 */ }

    var elaHot = 0, elaHighC = [], elaLowC = [];
    if (elaBlockZ) {
      var pxScale = prep.ow / w;
      var elaHigh = clusterAnomalies(elaBlockZ.z, elaBlockZ.bw, elaBlockZ.bh, 1, 2.5, 8, 0.45, 0);
      // 低响应团块：该区域在重压缩下几乎不变，说明它已高度压缩或来自另一张更平滑的素材
      var elaLow = clusterAnomalies(elaBlockZ.z, elaBlockZ.bw, elaBlockZ.bh, -1, 2.5, 8, 0.45, 0.32);
      elaHighC = elaHigh; elaLowC = elaLow;

      if (elaHigh.length) {
        var c1 = elaHigh[0];
        signals.push({
          id: 'ela-hotspot', cat: 'image',
          severity: U.clamp(0.36 + c1.areaRatio * 2.4, 0.36, 0.86), confidence: 0.72,
          label: '存在成片的局部重压缩响应异常（疑似拼接/局部编辑）',
          detail: '对图像做质量 90 的 JPEG 重压缩并逐像素求差。真实照片整幅经过同一压缩链路，响应应大致均匀。' +
            '这里检出一块连成片的异常高响应区域（' + describeCluster(c1, pxScale) + '，填充率 ' + U.fmt(c1.fill, 2) + '），' +
            '形状呈实心团块而非沿物体轮廓的细线。局部高响应通常意味着该区域被单独编辑、替换或来自另一张图。',
          metric: '高响应团块 ' + elaHigh.length + ' 处 · 最大 ' + c1.size + ' 块'
        });
      }
      if (elaLow.length) {
        var c2 = elaLow[0];
        signals.push({
          id: 'ela-cold', cat: 'image',
          severity: U.clamp(0.3 + c2.areaRatio * 2.2, 0.3, 0.78), confidence: 0.6,
          label: '存在成片的过度平滑区域（疑似素材来源不一致）',
          detail: '检出一块在重压缩下几乎不发生变化、且连成片的区域（' + describeCluster(c2, pxScale) + '）。' +
            '该区域缺少与画面其余部分一致的压缩响应，常见成因是从另一张已高度压缩或本身过于平滑的图里裁取后贴入，' +
            '或者是局部重度磨皮。此项为中等置信度证据，需与噪声分布一并判读。',
          metric: '低响应团块 ' + elaLow.length + ' 处 · 最大 ' + c2.size + ' 块'
        });
      }
    }

    /* --- 2.2 噪声一致性：中值滤波残差 --- */
    var gray = toGray(data, w, h);
    var med = median3(gray, w, h);
    var resid = new Float32Array(w * h);
    for (var r2 = 0; r2 < resid.length; r2++) resid[r2] = Math.abs(gray[r2] - med[r2]);
    var ns = blockStats(resid, w, h, BLOCK);
    var nz = zscores(ns.means);
    var pxScaleN = prep.ow / w, noiseHighC = [], noiseLowC = [];

    /* 平坦度掩膜：中值滤波残差在物体轮廓、文字笔画处天然偏高，
     * 若不加区分，任何一张有主体的照片都会被判成「噪声不一致」。
     * 这里只保留局部梯度低于全图中位 2.2 倍的块（即缺少强边缘的平坦区），
     * 让检测聚焦在「本该均匀的平坦区域出现了噪声断层」这一真正可疑的现象上。 */
    var grad = new Float32Array(w * h);
    for (var gy = 0; gy < h - 1; gy++) {
      for (var gx = 0; gx < w - 1; gx++) {
        var go = gy * w + gx;
        grad[go] = Math.abs(gray[go + 1] - gray[go]) + Math.abs(gray[go + w] - gray[go]);
      }
    }
    var gs = blockStats(grad, w, h, BLOCK);
    var medGrad = U.median(gs.means);
    var gradLimit = Math.max(2, medGrad * 2.2);
    var flatMask = new Uint8Array(nz.z.length);
    for (var fm = 0; fm < flatMask.length; fm++) flatMask[fm] = gs.means[fm] <= gradLimit ? 1 : 0;

    var noiseHigh = clusterAnomalies(nz.z, ns.bw, ns.bh, 1, 2.8, 10, 0.45, 0, flatMask);
    var noiseLow = clusterAnomalies(nz.z, ns.bw, ns.bh, -1, 2.8, 10, 0.45, 0.32, flatMask);
    noiseHighC = noiseHigh; noiseLowC = noiseLow;

    if (noiseHigh.length) {
      var n1 = noiseHigh[0];
      signals.push({
        id: 'noise-high', cat: 'image',
        severity: U.clamp(0.34 + n1.areaRatio * 2.4, 0.34, 0.84), confidence: 0.68,
        label: '局部噪声显著高于全图基线（疑似拼接外来素材）',
        detail: '用 3×3 中值滤波提取高频残差，逐块比较噪声强度。检出成片的高噪声区域（' + describeCluster(n1, pxScaleN) +
          '，填充率 ' + U.fmt(n1.fill, 2) + '）。同一设备、同一光照、同一 ISO 下拍摄的整幅图像噪声水平应基本一致，' +
          '局部噪声断层意味着该区域来自另一张素材，或被单独施加了噪声以掩盖修改痕迹。',
        metric: '高噪声团块 ' + noiseHigh.length + ' 处 · 最大 ' + n1.size + ' 块'
      });
    }
    if (noiseLow.length) {
      var n2c = noiseLow[0];
      signals.push({
        id: 'noise-low', cat: 'image',
        severity: U.clamp(0.32 + n2c.areaRatio * 2.2, 0.32, 0.8), confidence: 0.64,
        label: '局部噪声显著低于全图基线（疑似局部磨皮或素材不一致）',
        detail: '检出成片的低噪声区域（' + describeCluster(n2c, pxScaleN) + '，填充率 ' + U.fmt(n2c.fill, 2) +
          '）。真实拍摄的噪声分布在整幅图上连续变化，出现一块「异常干净」的实心区域，通常来自局部重度美颜、' +
          '从更平滑的素材裁取后贴入，或该区域由生成模型单独补全。',
        metric: '低噪声团块 ' + noiseLow.length + ' 处 · 最大 ' + n2c.size + ' 块'
      });
    }

    var smoothBlocks = 0, lowNoise = nz.mean < 1.6;
    for (var s2 = 0; s2 < ns.means.length; s2++) if (ns.means[s2] < nz.mean * 0.35) smoothBlocks++;
    if (lowNoise) {
      signals.push({
        id: 'noise-absent', cat: 'image', severity: U.clamp((2.2 - nz.mean) / 2.2, 0.2, 0.75), confidence: 0.63,
        label: '高频噪声整体缺失（合成或强磨皮）',
        detail: '全图残差噪声均值仅 ' + U.fmt(nz.mean, 2) + '/255，且 ' + smoothBlocks + ' 个块的噪声低于基线 35%。' +
          '真实拍摄必然携带传感器噪声，数值过低说明图像要么由生成模型合成、要么经过了重度美颜/降噪处理，' +
          '两种情况都会让「图中所见」与「实物所见」产生距离。',
        metric: '噪声均值 ' + U.fmt(nz.mean, 2)
      });
    }

    /* --- 2.3 色度噪声：扩散模型常见缺失特征 --- */
    var cb = new Float32Array(w * h), cr = new Float32Array(w * h);
    for (var i3 = 0, p3 = 0; i3 < cb.length; i3++, p3 += 4) {
      cb[i3] = -0.169 * data[p3] - 0.331 * data[p3 + 1] + 0.5 * data[p3 + 2] + 128;
      cr[i3] = 0.5 * data[p3] - 0.419 * data[p3 + 1] - 0.081 * data[p3 + 2] + 128;
    }
    var cbS = blockStats(cb, w, h, BLOCK).stds, crS = blockStats(cr, w, h, BLOCK).stds;
    var chromaNoise = (U.mean(cbS) + U.mean(crS)) / 2;
    var lumaNoise = U.mean(blockStats(gray, w, h, BLOCK).stds) || 1;
    var chromaLumaRatio = chromaNoise / lumaNoise;

    if (chromaLumaRatio < 0.11) {
      signals.push({
        id: 'chroma-flat', cat: 'image', severity: U.clamp((0.11 - chromaLumaRatio) * 12 + 0.3, 0.3, 0.8), confidence: 0.6,
        label: '色度通道近乎无噪声（生成模型特征）',
        detail: '自然图像的色度分量（Cb/Cr）同样携带可测量的噪声，且与亮度分量保持相对稳定的比例。' +
          '本图色度噪声 / 亮度细节比仅 ' + U.fmt(chromaLumaRatio, 3) + '，色度面异常干净——' +
          '这是扩散类生成模型的典型指纹，因为它们在高频色度上倾向于输出确定性结果。',
        metric: 'Cb/Cr 噪声比 ' + U.fmt(chromaLumaRatio, 3)
      });
    }

    /* --- 2.4 直方图量化痕迹 --- */
    var hist = new Float32Array(256);
    for (var i4 = 0; i4 < gray.length; i4++) hist[U.clamp(Math.round(gray[i4]), 0, 255)]++;
    var lo = 0, hi = 255;
    while (lo < 255 && hist[lo] / gray.length < 0.0002) lo++;
    while (hi > 0 && hist[hi] / gray.length < 0.0002) hi--;
    var span = 0, empty = 0;
    for (var b2 = lo; b2 <= hi; b2++) { span++; if (hist[b2] === 0) empty++; }
    var gapRatio = span > 24 ? empty / span : 0;
    var peak = Math.max.apply(null, Array.prototype.slice.call(hist)) / gray.length;
    if (peak > 0.09 || gapRatio > 0.06) {
      signals.push({
        id: 'hist-quant', cat: 'image', severity: U.clamp(Math.max(peak * 3, gapRatio * 4), 0.25, 0.65), confidence: 0.5,
        label: '色阶分布存在量化/后处理痕迹',
        detail: '灰度直方图在有效区间 [' + lo + ', ' + hi + '] 内存在 ' + U.fmt(gapRatio * 100, 1) + '% 的空档，单峰占比达 ' +
          U.fmt(peak * 100, 1) + '%。过强的色阶断裂与尖峰常见于多层滤镜叠加、局部曲线拉伸或合成后处理。' +
          '（置信度较低，仅作辅助证据，需人工复核。）',
        metric: '空档率 ' + U.fmt(gapRatio * 100, 1) + '% / 峰值 ' + U.fmt(peak * 100, 1) + '%'
      });
    }

    /* --- 2.5 复制-移动粗检（低置信度辅助信号） --- */
    var CM = 128, cvv = document.createElement('canvas');
    cvv.width = CM; cvv.height = CM;
    cvv.getContext('2d', { willReadFrequently: true }).drawImage(prep.canvas, 0, 0, CM, CM);
    var gsmall = toGray(cvv.getContext('2d').getImageData(0, 0, CM, CM).data, CM, CM);
    var BS = 8, bCount = CM / BS, blocks = [];
    for (var by2 = 0; by2 < bCount; by2++) {
      for (var bx2 = 0; bx2 < bCount; bx2++) {
        var vals2 = [], mean2 = 0;
        for (var yy = 0; yy < BS; yy++) for (var xx = 0; xx < BS; xx++) { var vv = gsmall[(by2 * BS + yy) * CM + bx2 * BS + xx]; vals2.push(vv); mean2 += vv; }
        mean2 /= vals2.length;
        var varr = 0; for (var vi = 0; varr === 0 && vi < vals2.length; vi++) { var dd = vals2[vi] - mean2; varr += dd * dd; }
        varr /= vals2.length;
        if (varr < 2500) continue;   // 过滤平坦区域，显著降低误报
        var bits = '';
        for (var ty = 0; ty < BS; ty++) for (var tx = 0; tx < BS - 1; tx++) {
          bits += gsmall[(by2 * BS + ty) * CM + bx2 * BS + tx] < gsmall[(by2 * BS + ty) * CM + bx2 * BS + tx + 1] ? '1' : '0';
        }
        blocks.push({ x: bx2, y: by2, bits: bits, varr: varr });
      }
    }
    var matches = [];
    for (var m1 = 0; m1 < blocks.length; m1++) {
      for (var m2 = m1 + 1; m2 < blocks.length; m2++) {
        var A = blocks[m1], B = blocks[m2];
        if (Math.abs(A.x - B.x) < 4 && Math.abs(A.y - B.y) < 4) continue;
        var dist = 0;
        for (var bi = 0; bi < A.bits.length; bi++) if (A.bits[bi] !== B.bits[bi]) { if (++dist > 2) break; }
        if (dist <= 2) matches.push([A, B]);
        if (matches.length >= 6) break;
      }
      if (matches.length >= 6) break;
    }
    if (matches.length >= 2) {
      signals.push({
        id: 'copy-move', cat: 'image', severity: 0.42, confidence: 0.45,
        label: '存在高度相似的重复区块（疑似复制-移动）',
        detail: '在 128×128 归一化灰度图上做 8×8 块哈希比对，发现 ' + matches.length + ' 组汉明距离≤2 且空间距离较远的相似块。' +
          '这可能是复制-移动式修图（例如把某一处的高光/瑕疵搬到别处），也可能是天然重复纹理（大理石、格纹、蕾丝）。' +
          '本信号置信度低，仅用于提示人工复核，不应作为单独判据。',
        metric: '相似区块对 ' + matches.length + ' 组',
        lowConfidence: true
      });
    }

    /* --- 2.6 尺寸与元数据启发式 --- */
    var square = Math.abs(prep.ow - prep.oh) / Math.max(prep.ow, prep.oh) < 0.005;
    var aiSize = AI_SIZES.indexOf(prep.ow) >= 0 && AI_SIZES.indexOf(prep.oh) >= 0;
    if (square && aiSize) {
      signals.push({
        id: 'gen-size', cat: 'image', severity: 0.55, confidence: 0.62,
        label: '输出尺寸为生成模型典型规格',
        detail: '图像尺寸 ' + prep.ow + '×' + prep.oh + '，为正方形且长宽均落在生成模型的常用输出规格集（512/768/1024/1536/2048）中。' +
          '手机与相机拍摄通常输出 4:3、3:4、16:9 等比例且边长不规则。此项为概率性线索，需结合元数据一起判断。',
        metric: prep.ow + '×' + prep.oh
      });
    }

    var stats = {
      w: prep.ow, h: prep.oh, aspect: U.fmt(prep.ow / prep.oh, 3),
      dominant: dominantColors(data, w, h),
      noiseMean: nz.mean, chromaLumaRatio: chromaLumaRatio,
      elaHotRatio: elaHotRatio, elaUniform: elaUniform
    };

    return {
      signals: signals,
      stats: stats,
      visual: {
        w: w, h: h, block: BLOCK,
        ela: elaBlockZ,
        noiseGrid: { means: ns.means, z: nz.z, bw: ns.bw, bh: ns.bh },
        copyMove: matches,
        // 真正构成证据的团块，界面只画这些，避免「判定低风险却满图红框」的自相矛盾
        clusters: { elaHigh: elaHighC, elaLow: elaLowC, noiseHigh: noiseHighC, noiseLow: noiseLowC }
      },
      elapsed: performance.now() - t0
    };
  }

  /* ---------------- 3. 文本核验 ---------------- */
  var LEX = {
    absolute: /(?:最(?:好|佳|强|美|棒|新|高|大|低|快|专业|厉害|懂|值得|有效)|第一|No\.?1|顶级|极致|唯一|独家|绝对|100\s*%|永久|彻底|根治|史上|无敌|首选|天花板|封神|全网最低|秒杀一切)/g,
    medical: /(?:治疗|消炎|杀菌|抗菌|抑菌|抗炎|药用|处方|修复(?:受损)?细胞|祛斑|祛痘根|医美|整形|美白针|排毒|免疫调节|生发|除螨)/g,
    fakePromise: /(?:\d+\s*(?:天|周|日|次|小时)(?:见效|美白|祛痘|淡纹|变白|焕肤)|立即见效|立刻见效|马上见效|无效退款|包治|秒变|一夜)/g,
    shill: /(?:绝绝子|yyds|YYDS|闭眼入|无限回购|吹爆|封神|谁懂啊|救命|太绝了|绝了|无敌了|爱了爱了|回购一万年|没有之一|按头安利|血泪推荐)/g,
    connector: /(?:首先|其次|再者|然后|此外|与此同时|不仅如此|值得一提的是|需要注意的是|综上所述|总而言之|总的来说|因此|从而|第一\s*[、,，]|第二\s*[、,，]|第三\s*[、,，])/g,
    personal: /(?:我(?!们)|我自己|上周|上周[一二三四五六日]|昨天|前天|当时|结果|居然|本来|说实话|讲真|个人觉得|自用|空瓶|踩雷|回购了)/g,
    emotion: /(?:哈哈|嘿嘿|呜呜|啊啊|天啊|卧槽|真的会谢|绝了|救命|心动了|哭死|栓Q)/g,
    hedge: /(?:不过|但是|可是|然而|有一点点|一点点|有点|稍微|其实|可能|也许|感觉|算不上|不太|并没有|说实话|讲真|因人而异|介意|缺点|不足|不适合|不推荐|慎入|劝退|翻车)/g
  };

  var COLOR_WORDS = {
    '红': ['正红', '砖红', '车厘子', '番茄红', '中国红', '复古红', '红', '赤'],
    '粉': ['豆沙', '玫瑰', '樱花', '蜜桃', '桃粉', '芭比粉', '奶粉', '粉', '桃'],
    '橙': ['珊瑚', '西柚', '胡萝卜', '南瓜色', '橘', '橙', '阿宝色'],
    '棕': ['奶茶色', '吃土色', '摩卡', '巧克力', '焦糖', '栗棕', '枫叶', '咖', '棕', '奶茶'],
    '黄': ['柠檬黄', '姜黄', '蜜黄', '黄'],
    '绿': ['抹茶', '薄荷绿', '牛油果', '青提', '草绿', '绿'],
    '青': ['蒂芙尼', '湖蓝', '青色', '青'],
    '蓝': ['雾霾蓝', '海盐蓝', '星辰蓝', '克莱因', '蓝'],
    '紫': ['葡萄紫', '薰衣草', '香芋紫', '芋泥', '紫'],
    '黑': ['暗黑', '纯黑', '黑'],
    '白': ['奶白', '象牙白', '珍珠白', '白'],
    '灰': ['高级灰', '浅灰', '灰']
  };

  function splitSentences(text) {
    var raw = text.replace(/\r/g, '').split(/(?<=[。！？!?；;\n])/);
    var out = [];
    for (var i = 0; i < raw.length; i++) { var s = raw[i].trim(); if (s.length >= 2) out.push(s); }
    return out;
  }

  function countMatches(re, text) {
    var m = text.match(re);
    return m ? m.length : 0;
  }

  /** 文本核验：返回证据 + 可高亮的片段区间 */
  function textForensics(rawText, comments) {
    var t0 = performance.now();
    var text = (rawText || '').trim();
    var cmt = (comments || '').trim();
    var all = (text + '\n' + cmt).trim();
    var signals = [], marks = [];
    if (!all) return { signals: [], marks: [], stats: null, elapsed: 0 };

    var sents = splitSentences(text || all);
    var lens = sents.map(function (s) { return s.length; });
    var meanLen = U.mean(lens) || 1;
    var cv = U.std(lens) / meanLen;
    var chars = all.replace(/\s/g, '').length;

    /* 3.1 AI 生成倾向 —— 多特征加权 */
    var cConn = countMatches(LEX.connector, all);
    var cPers = countMatches(LEX.personal, all);
    var cEmo = countMatches(LEX.emotion, all);
    var cHedge = countMatches(LEX.hedge, all);
    var connDensity = cConn / Math.max(1, sents.length);

    var triad = 0;
    for (var i = 0; i + 2 < sents.length; i++) {
      var a = lens[i], b = lens[i + 1], c = lens[i + 2];
      if (Math.abs(a - b) <= 3 && Math.abs(b - c) <= 3 && a > 6) triad++;
    }

    var f = [];
    f.push(['句式长度过于均匀', U.clamp((0.62 - cv) / 0.42, 0, 1) * 0.9, '句长变异系数 ' + U.fmt(cv, 3)]);
    f.push(['模板化连接词密集', U.clamp(connDensity / 0.5, 0, 1) * 0.85, '连接词 ' + cConn + ' 处 / ' + sents.length + ' 句']);
    f.push(['缺少真实使用细节', (cPers === 0 && chars > 50) ? 0.7 : U.clamp(1 - cPers / 3, 0, 1) * 0.5, '第一人称/时间细节 ' + cPers + ' 处']);
    f.push(['排比式结构重复', U.clamp(triad / 2, 0, 1) * 0.6, '等长三连句 ' + triad + ' 组']);
    f.push(['缺少口语与情绪起伏', (cEmo === 0 && chars > 50) ? 0.25 : U.clamp(1 - cEmo / 3, 0, 1) * 0.3, '口语/情绪词 ' + cEmo + ' 处']);
    // 真人分享一定会带不确定性与负面表述（"不过""有一点点""介意的慎入"），
    // 这是区分人写文案与批量生成文案最强的单项特征，也是样本 C 不再被误报的关键。
    f.push(['缺少不确定性与负面表述', (cHedge === 0 && chars > 50) ? 0.65 : U.clamp(1 - cHedge / 2, 0, 1) * 0.4, '不确定/负面表述 ' + cHedge + ' 处']);

    var aiScore = 0, wsum = 0;
    for (var k = 0; k < f.length; k++) { aiScore += f[k][1] * (1 - wsum * 0.35); wsum += f[k][1]; }
    aiScore = U.clamp(aiScore / 2.8, 0, 1);

    if (aiScore > 0.42) {
      signals.push({
        id: 'text-ai', cat: 'text', severity: U.clamp(aiScore, 0.3, 0.85), confidence: 0.58,
        label: '文案存在机器批量生成特征',
        detail: '综合 ' + f.length + ' 项文体统计特征，机器生成倾向得分 ' + U.fmt(aiScore, 2) + '（>0.42 触发）。主要贡献项：' +
          f.filter(function (x) { return x[1] > 0.25; }).map(function (x) { return x[0] + '（' + x[2] + '）'; }).join('；') +
          '。LLM 生成的中文种草文案普遍句子长度收敛、连接词模板化、缺少具体的时间地点与真实翻车细节。' +
          '（文体特征是启发式判断，不能单独作为「AI 写作」的定论，但可作为内容同质化的强提示。）',
        metric: '生成倾向 ' + U.fmt(aiScore, 2),
        factors: f
      });
    }

    /* 3.2 广告合规风险 */
    var abs = [], med = [], fp = [];
    var m;
    LEX.absolute.lastIndex = 0;
    while ((m = LEX.absolute.exec(all)) !== null) abs.push({ w: m[0], i: m.index });
    LEX.medical.lastIndex = 0;
    while ((m = LEX.medical.exec(all)) !== null) med.push({ w: m[0], i: m.index });
    LEX.fakePromise.lastIndex = 0;
    while ((m = LEX.fakePromise.exec(all)) !== null) fp.push({ w: m[0], i: m.index });

    abs.slice(0, 12).forEach(function (x) { marks.push({ start: x.i, end: x.i + x.w.length, type: 'absolute', label: '绝对化用语' }); });
    med.slice(0, 12).forEach(function (x) { marks.push({ start: x.i, end: x.i + x.w.length, type: 'medical', label: '医疗/功效宣称' }); });
    fp.slice(0, 12).forEach(function (x) { marks.push({ start: x.i, end: x.i + x.w.length, type: 'promise', label: '效果承诺' }); });

    if (abs.length + med.length + fp.length > 0) {
      var adSev = U.clamp((abs.length * 0.22 + med.length * 0.34 + fp.length * 0.3), 0.2, 0.9);
      signals.push({
        id: 'text-adlaw', cat: 'text', severity: adSev, confidence: 0.8,
        label: '存在广告法合规风险表述',
        detail: '检出绝对化用语 ' + abs.length + ' 处' + (abs.length ? '（' + abs.slice(0, 4).map(function (x) { return '「' + x.w + '」'; }).join('') + '）' : '') +
          '、医疗或功效宣称 ' + med.length + ' 处' + (med.length ? '（' + med.slice(0, 4).map(function (x) { return '「' + x.w + '」'; }).join('') + '）' : '') +
          '、效果承诺 ' + fp.length + ' 处' + (fp.length ? '（' + fp.slice(0, 3).map(function (x) { return '「' + x.w + '」'; }).join('') + '）' : '') +
          '。化妆品功效宣称必须与备案信息一致，且不得使用「最」「第一」「根治」等绝对化或医疗化表述。这类内容一旦被平台判定违规，' +
          '会连带影响创作者账号权重，是创作者侧最现实的风险。',
        metric: '违规表述 ' + (abs.length + med.length + fp.length) + ' 处'
      });
    }

    /* 3.3 水军/刷评特征（评论区） */
    if (cmt) {
      var cmtLines = cmt.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      var shillHits = countMatches(LEX.shill, cmt);
      var emojiCount = (cmt.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
      var emojiDensity = cmtLines.length ? emojiCount / cmtLines.length : 0;
      var dupRate = 0;
      if (cmtLines.length >= 3) {
        var seen = {}, dup = 0;
        for (var ci = 0; ci < cmtLines.length; ci++) {
          var key = cmtLines[ci].slice(0, 8);
          if (seen[key]) dup++; else seen[key] = 1;
        }
        dupRate = dup / cmtLines.length;
      }
      var shillScore = U.clamp(shillHits / Math.max(2, cmtLines.length) * 1.6 + emojiDensity * 0.35 + dupRate * 1.2, 0, 1);
      if (shillScore > 0.35) {
        signals.push({
          id: 'text-shill', cat: 'text', severity: U.clamp(shillScore, 0.3, 0.85), confidence: 0.62,
          label: '评论区呈现刷评/水军特征',
          detail: '共 ' + cmtLines.length + ' 条评论：极端夸赞词 ' + shillHits + ' 处、平均每条 emoji ' + U.fmt(emojiDensity, 2) +
            ' 个、开头 8 字重复率 ' + U.fmt(dupRate * 100, 1) + '%。真实用户评论通常长短不一并包含具体使用场景或负面反馈；' +
            '高度统一的极端正向表达、emoji 位置模板化、句式重复，是组织化刷评的典型表现。',
          metric: '刷评倾向 ' + U.fmt(shillScore, 2)
        });
      }
    }

    /* 3.4 图文语义一致性（与图像主色对照） */
    var COLOR_ANTI = /[显变更美不假漂]/;   // 排除「显白」「变白」「美白」等非颜色描述
    var colorMention = [];
    for (var fam in COLOR_WORDS) {
      var words = COLOR_WORDS[fam];
      for (var wi = 0; wi < words.length; wi++) {
        var idx = all.indexOf(words[wi]);
        if (idx < 0) continue;
        var prev = idx > 0 ? all.charAt(idx - 1) : '';
        if (COLOR_ANTI.test(prev)) continue;
        colorMention.push({ family: fam, word: words[wi], idx: idx });
        break;
      }
    }
    // 同一色系只保留首个命中（长词优先匹配，避免「雾霾蓝」被「蓝」抢占）
    var famSet = {};
    colorMention.forEach(function (c) { if (!famSet[c.family]) famSet[c.family] = c; });
    colorMention = Object.keys(famSet).map(function (k) { return famSet[k]; });

    return {
      signals: signals,
      marks: marks,
      stats: {
        chars: chars, sentences: sents.length, sentCV: cv, aiScore: aiScore,
        connectors: cConn, personal: cPers, emotion: cEmo, hedge: cHedge, triad: triad,
        colorMention: colorMention
      },
      elapsed: performance.now() - t0
    };
  }

  /** 图文交叉核验：文本色号/颜色描述 与 图片主色 是否对得上
   *  注意：黑白灰属于无彩色，几乎任何画面都含有，不参与一致性判断，
   *        否则「显白」这类词会被画面的白色背景误当成匹配项，把真实冲突消解掉。 */
  function crossCheck(textRes, imgStats) {
    if (!textRes || !textRes.stats || !imgStats || !imgStats.dominant) return null;
    var ACHROMATIC = { '黑': 1, '白': 1, '灰': 1 };
    var mentions = (textRes.stats.colorMention || []).filter(function (m) { return !ACHROMATIC[m.family]; });
    if (mentions.length < 2) return null;

    var imgFams = imgStats.dominant
      .filter(function (d) { return d.share > 0.05 && !ACHROMATIC[d.family]; })
      .map(function (d) { return d.family; });
    if (!imgFams.length) return null;
    var NEIGHBOR = {
      '红': ['粉', '橙', '棕'], '粉': ['红', '紫'], '橙': ['红', '棕', '黄'], '棕': ['橙', '红', '黄'],
      '黄': ['橙', '棕', '绿'], '绿': ['黄', '青'], '青': ['蓝', '绿'], '蓝': ['青', '紫'],
      '紫': ['蓝', '粉'], '黑': ['灰'], '白': ['灰'], '灰': ['黑', '白']
    };
    var hit = 0, miss = [];
    mentions.forEach(function (m) {
      var ok = imgFams.indexOf(m.family) >= 0 ||
        (NEIGHBOR[m.family] || []).some(function (n) { return imgFams.indexOf(n) >= 0; });
      if (ok) hit++; else miss.push(m);
    });

    if (miss.length >= 2 && hit === 0) {
      return {
        id: 'cross-color', cat: 'cross', severity: 0.55, confidence: 0.55,
        label: '图文描述与画面主色不一致',
        detail: '文案提到 ' + mentions.map(function (m) { return '「' + m.word + '」'; }).join('、') +
          '（色系：' + mentions.map(function (m) { return m.family; }).join('/') + '），但图像主色系为 ' +
          imgFams.slice(0, 4).join('/') + '，两者无交集也无相邻色系关系。' +
          '种草内容中「色号描述」与「实拍成色」的偏差是消费者投诉最集中的问题之一，' +
          '典型成因是过度调色、使用官方渲染图代替实拍，或用他人图片配自家文案。',
        metric: '色系冲突 ' + miss.length + ' 处'
      };
    }
    return null;
  }

  global.VerifierEngine = {
    probeMetadata: probeMetadata,
    imageForensics: imageForensics,
    textForensics: textForensics,
    crossCheck: crossCheck,
    decodeImage: decodeImage,
    dominantColors: dominantColors,
    util: U
  };
})(window);
