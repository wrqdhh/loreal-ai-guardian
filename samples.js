/* ============================================================
 * samples.js — 程序化构造演示样本
 * 目的：让 Agent 在没有任何外部素材的情况下也能被完整演示与录屏。
 * 三组样本覆盖三种典型判定结果：合成素材 / 拼接篡改 / 正常内容（对照）。
 * ============================================================ */
(function (global) {
  'use strict';

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  function addNoise(ctx, w, h, lumaAmp, chromaAmp) {
    var id = ctx.getImageData(0, 0, w, h), d = id.data;
    for (var i = 0; i < d.length; i += 4) {
      var n = (Math.random() - 0.5) * 2 * lumaAmp;
      var cb = (Math.random() - 0.5) * 2 * chromaAmp;
      var cr = (Math.random() - 0.5) * 2 * chromaAmp;
      d[i] = clamp255(d[i] + n + cb);
      d[i + 1] = clamp255(d[i + 1] + n - cr * 0.5);
      d[i + 2] = clamp255(d[i + 2] + n + cr);
    }
    ctx.putImageData(id, 0, 0);
  }

  function newCanvas(w, h) {
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    return { cv: cv, ctx: cv.getContext('2d', { willReadFrequently: true }) };
  }

  function loadSrc(url) {
    return new Promise(function (res) {
      var im = new Image(); im.onload = function () { res(im); }; im.src = url;
    });
  }

  /* ---------- 样本 A：AI 合成美妆素材 ---------- */
  async function buildAiImage() {
    var N = 1024, c = newCanvas(N, N), ctx = c.ctx;

    var g = ctx.createLinearGradient(0, 0, N, N);
    g.addColorStop(0, '#f6e4e8');
    g.addColorStop(0.45, '#f0cdd6');
    g.addColorStop(1, '#e6bfcb');
    ctx.fillStyle = g; ctx.fillRect(0, 0, N, N);

    var halo = ctx.createRadialGradient(N * 0.72, N * 0.24, 40, N * 0.72, N * 0.24, N * 0.62);
    halo.addColorStop(0, 'rgba(255,252,250,0.95)');
    halo.addColorStop(1, 'rgba(255,252,250,0)');
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(N * 0.72, N * 0.24, N * 0.62, 0, Math.PI * 2); ctx.fill();

    // 主体：一盒圆角粉饼
    var cx = N * 0.5, cy = N * 0.56, R = N * 0.28;
    var body = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    body.addColorStop(0, '#fbf7f4');
    body.addColorStop(1, '#dcc6c8');
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    var inner = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R * 0.82);
    inner.addColorStop(0, '#e8b7bd');
    inner.addColorStop(0.7, '#cf8d99');
    inner.addColorStop(1, '#b87684');
    ctx.fillStyle = inner;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.78, 0, Math.PI * 2); ctx.fill();

    var gloss = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.2, cy + R * 0.3);
    gloss.addColorStop(0, 'rgba(255,255,255,0.55)');
    gloss.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gloss;
    ctx.beginPath(); ctx.ellipse(cx - R * 0.22, cy - R * 0.3, R * 0.46, R * 0.26, -0.6, 0, Math.PI * 2); ctx.fill();

    // 亮度侧细节（细线 + 文字）：模仿生成模型「结构锐利、色度干净」的特征
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = 'rgba(90,72,76,0.75)';
    ctx.lineWidth = 1.6;
    for (var i = 0; i < 26; i++) {
      ctx.beginPath();
      ctx.moveTo(N * 0.12, N * 0.88 + i * 3.4);
      ctx.lineTo(N * 0.12 + 46 + (i % 5) * 12, N * 0.88 + i * 3.4);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.fillStyle = 'rgba(74,58,62,0.9)';
    ctx.font = '500 30px sans-serif';
    ctx.fillText('ROUGE  ·  01', N * 0.13, N * 0.10);
    ctx.font = '400 21px sans-serif';
    ctx.fillStyle = 'rgba(74,58,62,0.62)';
    ctx.fillText('cream blush  /  refillable', N * 0.13, N * 0.145);
    ctx.restore();

    // 刻意不加噪声 —— 这是合成素材最直观的特征
    return c.cv.toDataURL('image/png');
  }

  /* ---------- 样本 B：拼接篡改图（局部替换） ---------- */
  async function buildSplicedImage() {
    var W = 720, H = 540;
    var base = newCanvas(W, H), b = base.ctx;

    var bg = b.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#efe6dd');
    bg.addColorStop(0.6, '#e2d3c6');
    bg.addColorStop(1, '#d6c2b4');
    b.fillStyle = bg; b.fillRect(0, 0, W, H);

    // 桌面与摆放的道具，制造真实纹理
    b.fillStyle = '#c9b3a1'; b.fillRect(0, H * 0.68, W, H * 0.32);
    for (var i = 0; i < 5; i++) {
      var x = 60 + i * 145, y = 300 + (i % 2) * 34;
      var tube = b.createLinearGradient(x, y, x + 54, y + 150);
      tube.addColorStop(0, i % 2 ? '#e9c7bd' : '#d9a99e');
      tube.addColorStop(1, i % 2 ? '#c79c92' : '#b9867c');
      b.fillStyle = tube;
      b.beginPath();
      if (b.roundRect) b.roundRect(x, y, 54, 150, 14); else b.rect(x, y, 54, 150);
      b.fill();
    }
    addNoise(b, W, H, 8, 6);

    // 模拟「原图曾被压缩过一次」
    var baseUrl = base.cv.toDataURL('image/jpeg', 0.72);
    var baseImg = await loadSrc(baseUrl);

    // 局部替换素材：来自另一张图（更干净、更冷色、压缩链路不同）
    var patch = newCanvas(230, 190), p = patch.ctx;
    var pg = p.createLinearGradient(0, 0, 230, 190);
    pg.addColorStop(0, '#cfd8e2');
    pg.addColorStop(0.55, '#b9c6d4');
    pg.addColorStop(1, '#9fb0c2');
    p.fillStyle = pg; p.fillRect(0, 0, 230, 190);
    p.fillStyle = 'rgba(255,255,255,0.5)';
    p.beginPath(); p.ellipse(80, 62, 54, 32, -0.5, 0, Math.PI * 2); p.fill();
    p.strokeStyle = 'rgba(120,134,150,0.55)'; p.lineWidth = 2;
    p.strokeRect(18, 120, 194, 50);
    addNoise(p, 230, 190, 1.6, 1.2);   // 噪声水平明显低于底图

    var patchUrl = patch.cv.toDataURL('image/jpeg', 0.95);
    var patchImg = await loadSrc(patchUrl);

    // 合成：把补丁贴到右下角
    var out = newCanvas(W, H), o = out.ctx;
    o.drawImage(baseImg, 0, 0, W, H);
    o.drawImage(patchImg, 432, 316, 230, 190);
    o.strokeStyle = 'rgba(150,140,132,0.35)';
    o.lineWidth = 1;
    o.strokeRect(432, 316, 230, 190);

    return out.cv.toDataURL('image/jpeg', 0.92);
  }

  /* ---------- 样本 C：正常内容（对照） ---------- */
  async function buildCleanImage() {
    var W = 800, H = 600, c = newCanvas(W, H), ctx = c.ctx;
    var sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#dfe7ee');
    sky.addColorStop(0.55, '#e8e2da');
    sky.addColorStop(1, '#cbbfae');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(196,178,158,0.9)';
    ctx.beginPath(); ctx.ellipse(W * 0.5, H * 0.78, W * 0.52, H * 0.2, 0, 0, Math.PI * 2); ctx.fill();

    var obj = ctx.createLinearGradient(W * 0.36, H * 0.34, W * 0.62, H * 0.72);
    obj.addColorStop(0, '#b8766c');
    obj.addColorStop(1, '#8d554f');
    ctx.fillStyle = obj;
    ctx.beginPath(); ctx.ellipse(W * 0.5, H * 0.58, 96, 128, 0.06, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath(); ctx.ellipse(W * 0.45, H * 0.47, 26, 42, 0.3, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = 'rgba(90,78,68,0.5)';
    ctx.font = '400 24px sans-serif';
    ctx.fillText('shot on desk, natural light', 48, 68);

    addNoise(ctx, W, H, 9, 7);
    return c.cv.toDataURL('image/jpeg', 0.9);
  }

  /* ---------- 配套文案 ---------- */

  var TEXT_CLEAN_POST = [
    '上周在专柜试了这支，柜姐说这个色号断货很久了，我也就顺手摸了个样。',
    '颜色是那种雾霾蓝调，带一点点青绿，冷调上嘴是有高级感的，但不是荧光的蓝。',
    '质地我原本以为是干的，结果上嘴还挺润，推开也顺。我唇色偏深，涂出来比手臂试色要暗一点点，介意的姐妹可以先做功课。',
    '我在室内白光下拍了一张，又在窗边自然光下拍了一张，颜色差别还挺明显的。整体属于日常能用的冷调色，我自己是回购了的。'
  ].join('\n');

  var TEXT_CLEAN_COMMENTS = [
    '这个色号我也买了，确实挑唇色',
    '姐妹你唇色深的话试过打底吗',
    '我上周去专柜问说没有货了…',
    '感谢分享，正好在纠结冷调还是暖调'
  ].join('\n');

  var TEXT_AI_POST = [
    '姐妹们！今天必须给大家安利这款我最近的心头好～',
    '首先，它的质地真的绝了，上脸之后即刻呈现出高级的雾面感，完全不假面。',
    '其次，它的持妆能力堪称同级最强，实测8小时不脱妆、不斑驳，是真正的天花板级别。',
    '再者，它添加了核心精粹成分，能够消炎抑菌、修复受损细胞，坚持使用7天见效，彻底改善暗沉粗糙。',
    '值得一提的是，这款产品适合所有肤质，敏感肌也可以放心使用，绝对不会踩雷。',
    '综上所述，这是我今年用过最好用的一款底妆产品，没有之一，闭眼入就对了！'
  ].join('\n');

  var TEXT_AI_COMMENTS = [
    '绝绝子！已经回购一万年了',
    'yyds，闭眼入不踩雷',
    '救命，谁懂啊，太好用了',
    '无限回购，姐妹们冲就完了',
    '啊啊啊姐妹们冲就完了，真的绝'
  ].join('\n');

  var TEXT_SPLICE_POST = [
    '上周在专柜试了这支，柜姐说断货很久了。',
    '颜色是那种雾霾蓝调，带一点点青绿，冷调上嘴很有高级感。',
    '质地我以为是干的，结果上嘴还挺润，颜色也很顺。',
    '不过说实话，我唇色偏深，涂出来比手臂试色要暗一点点，介意的姐妹可以先做功课。'
  ].join('\n');

  var TEXT_SPLICE_COMMENTS = [
    '冷调色真的显白吗',
    '这个蓝调我有点hold不住',
    '楼主唇色深能出个对比图吗'
  ].join('\n');

  var SAMPLES = [
    {
      id: 'ai',
      label: '样本 A · AI 合成素材',
      hint: '1024×1024 正方形 · 无拍摄元数据 · 无传感器噪声 · 色度异常干净',
      expect: '预期判定：高风险（合成内容 + 违规文案 + 组织化刷评）',
      build: buildAiImage,
      name: 'blush-01.png',
      mime: 'image/png',
      text: TEXT_AI_POST,
      comments: TEXT_AI_COMMENTS
    },
    {
      id: 'splice',
      label: '样本 B · 局部拼接篡改',
      hint: '720×540 · 右下角区域来自另一张图，压缩链路与噪声水平不一致',
      expect: '预期判定：高风险（局部篡改 + 图文不一致）',
      build: buildSplicedImage,
      name: 'lip-swatch.jpg',
      mime: 'image/jpeg',
      text: TEXT_SPLICE_POST,
      comments: TEXT_SPLICE_COMMENTS
    },
    {
      id: 'clean',
      label: '样本 C · 正常内容（对照）',
      hint: '800×600 · 噪声与压缩特征自然 · 文案含具体时间地点与不确定性',
      expect: '预期判定：低风险（放行）',
      build: buildCleanImage,
      name: 'desk-shot.jpg',
      mime: 'image/jpeg',
      text: TEXT_CLEAN_POST,
      comments: TEXT_CLEAN_COMMENTS
    }
  ];

  async function load(id) {
    var s = null;
    for (var i = 0; i < SAMPLES.length; i++) if (SAMPLES[i].id === id) s = SAMPLES[i];
    if (!s) throw new Error('未找到样本 ' + id);
    var dataUrl = await s.build();
    var img = await new Promise(function (res) { var im = new Image(); im.onload = function () { res(im); }; im.src = dataUrl; });
    var buf = null;
    try { buf = await (await fetch(dataUrl)).arrayBuffer(); } catch (e) { buf = null; }
    return {
      meta: s, dataUrl: dataUrl, image: img, imageBuffer: buf,
      imageMime: s.mime, imageName: s.name,
      text: s.text, comments: s.comments
    };
  }

  global.Samples = { list: SAMPLES, load: load };
})(window);
