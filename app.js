/* ============================================================
 * app.js — 界面层
 * 目标：让「核验过程」肉眼可见——工具调用逐条留痕、可疑区域可叠加查看、
 *      每条处置建议都能追溯到触发它的那条证据。
 * ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    image: null, imageBuffer: null, imageMime: null, imageName: null,
    text: '', comments: '', result: null, overlay: 'suspect', running: false
  };
  var traceEls = {};

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var toastTimer;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2200);
  }

  /* ---------------- 输入 ---------------- */
  function setImage(o) {
    state.image = o.image; state.imageBuffer = o.buffer;
    state.imageMime = o.mime; state.imageName = o.name;
    var pv = $('preview');
    pv.src = o.dataUrl; pv.hidden = false;
    $('dropHint').hidden = true;
    $('drop').classList.add('has');
  }

  function clearAll() {
    state.image = null; state.imageBuffer = null; state.result = null;
    $('preview').hidden = true; $('preview').src = '';
    $('dropHint').hidden = false;
    $('drop').classList.remove('has');
    $('txt').value = ''; $('cmt').value = '';
    $('output').hidden = true; $('output').innerHTML = '';
    $('placeholder').hidden = false;
    $('btnRun').textContent = '开始核验';
    var sb = document.querySelectorAll('#samples button');
    for (var i = 0; i < sb.length; i++) sb[i].classList.remove('on');
    updateIoHint();
  }

  function updateIoHint() {
    var n = (($('cmt').value || '').split('\n').filter(function (s) { return s.trim(); })).length;
    var parts = [];
    if (state.image) parts.push('图片 1 张');
    if (($('txt').value || '').trim()) parts.push('正文 ' + $('txt').value.trim().length + ' 字');
    if (n) parts.push('评论 ' + n + ' 条');
    $('ioHint').textContent = parts.join(' · ');
  }

  function handleFile(f) {
    if (!f) return;
    if (!/^image\//.test(f.type)) { toast('请选择图片文件（JPG / PNG / WebP）'); return; }
    var url = URL.createObjectURL(f);
    var im = new Image();
    im.onload = function () {
      f.arrayBuffer().then(function (buf) {
        setImage({ image: im, buffer: buf, mime: f.type, name: f.name, dataUrl: url });
        updateIoHint();
        toast('已载入 ' + f.name + '（' + im.naturalWidth + '×' + im.naturalHeight + '）');
      });
    };
    im.onerror = function () { toast('图片无法解码'); };
    im.src = url;
  }

  /* ---------------- 样本 ---------------- */
  function buildSampleButtons() {
    var box = $('samples');
    window.Samples.list.forEach(function (s) {
      var b = document.createElement('button');
      b.textContent = s.label.replace('样本 ', '').replace(' · ', ' ');
      b.title = s.hint + '\n' + s.expect;
      b.onclick = function () { loadSample(s.id, b); };
      box.appendChild(b);
    });
  }

  async function loadSample(id, btn) {
    var all = document.querySelectorAll('#samples button');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('on');
    if (btn) btn.classList.add('on');
    toast('正在生成示例素材…');
    try {
      var s = await window.Samples.load(id);
      setImage({ image: s.image, buffer: s.imageBuffer, mime: s.imageMime, name: s.imageName, dataUrl: s.dataUrl });
      $('txt').value = s.text; $('cmt').value = s.comments;
      updateIoHint();
      toast('已载入 ' + s.meta.label + ' · ' + s.meta.hint);
    } catch (e) {
      toast('示例生成失败：' + e.message);
      console.error(e);
    }
  }

  /* ---------------- 轨迹渲染 ---------------- */
  function traceShell() {
    return '<div class="card" id="cardTrace">' +
      '<h2 class="card-title"><span class="step-no">·</span>Agent 工具调用轨迹' +
      '<span class="sub"><button class="btn ghost" id="btnExport" style="font-size:12px">导出 JSON 报告</button></span></h2>' +
      '<ul class="trace" id="traceList"></ul></div>';
  }

  function rowHTML(rec, done) {
    var ms = done ? rec.ms + ' ms' : '执行中';
    return '<div class="dot">' + (rec.child ? '·' : rec.seq) + '</div>' +
      '<div class="tr-head"><b>' + esc(rec.name) + '</b><code>' + esc(rec.tool) + '</code><span class="ms">' + ms + '</span></div>' +
      (rec.thought ? '<p class="tr-thought">' + esc(rec.thought) + '</p>' : '') +
      (rec.input ? '<div class="tr-io"><span>输入</span><code>' + esc(rec.input) + '</code></div>' : '') +
      '<div class="tr-io"><span>结果</span><code>' + esc(done ? rec.output : '执行中…') + '</code></div>';
  }

  function onStep(rec, isUpdate) {
    if (isUpdate) {
      var el = traceEls[rec.seq];
      if (el) {
        el.className = 'trace-row ' + (rec.child ? 'tr-child ' : '') + rec.status;
        el.innerHTML = rowHTML(rec, true);
      }
      return;
    }
    var ul = $('traceList');
    if (!ul) return;
    var li = document.createElement('li');
    li.className = (rec.child ? 'tr-child ' : '') + 'running';
    li.innerHTML = rowHTML(rec, false);
    ul.appendChild(li);
    traceEls[rec.seq] = li;
    var box = li.getBoundingClientRect();
    if (box.bottom > window.innerHeight) li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ---------------- 证据渲染 ---------------- */
  function evidenceHTML(list) {
    if (!list.length) {
      return '<div class="ev" style="background:#F6FBF6;border-color:#D9E9CF"><div class="ev-head">' +
        '<h3 style="color:#3B6D11">该维度未触发证据</h3></div>' +
        '<p>在本工具集覆盖的检测维度内没有发现异常。这不等于「内容为真」，只说明未检出特定的造假特征。</p></div>';
    }
    var CAT = { image: '图像', text: '文本', cross: '跨模态' };
    return list.slice().sort(function (a, b) { return b.severity * b.confidence - a.severity * a.confidence; })
      .map(function (s) {
        var conf = Math.round(s.confidence * 100);
        return '<div class="ev"><div class="ev-head">' +
          '<span class="tag ' + s.cat + '">' + CAT[s.cat] + '</span>' +
          '<h3>' + esc(s.label) + '</h3></div>' +
          '<p>' + esc(s.detail) + '</p>' +
          '<div class="ev-meta"><span>' + esc(s.metric || '') + '</span>' +
          '<span class="conf">严重度 ' + s.severity.toFixed(2) + '</span>' +
          '<span class="conf">置信度 <i><b style="width:' + conf + '%"></b></i>' + s.confidence.toFixed(2) + '</span>' +
          (s.lowConfidence ? '<span>辅助证据 · 不单独触发处置</span>' : '') +
          '</div></div>';
      }).join('');
  }

  /* ---------------- 结论卡 ---------------- */
  function verdictCard(res) {
    var lv = res.level, agg = res.aggregate;
    var R = 44, C = 2 * Math.PI * R, dash = C * agg.score / 100;
    var bars = [
      ['图像取证', agg.parts.image, '#534AB7'],
      ['文本核验', agg.parts.text, '#1D9E75'],
      ['跨模态交叉', agg.parts.cross, '#BA7517']
    ].map(function (b) {
      return '<div class="bar"><span>' + b[0] + '<b>' + b[1] + '</b></span>' +
        '<div class="track"><i style="width:' + b[1] + '%;background:' + b[2] + '"></i></div></div>';
    }).join('');

    var acts = res.recommendation.actions.map(function (a) {
      return '<li><span class="pill">' + esc(res.recommendation.urgency) + '</span>' +
        '<div>' + esc(a.text) + '<em>触发证据：' + esc(a.from) + '</em></div></li>';
    }).join('');

    return '<div class="card verdict" id="cardVerdict" style="border-left-color:' + lv.color + '">' +
      '<div class="verdict-top">' +
      '<div class="gauge"><svg width="104" height="104" viewBox="0 0 104 104">' +
      '<circle cx="52" cy="52" r="44" fill="none" stroke="#EDEBE6" stroke-width="9"/>' +
      '<circle cx="52" cy="52" r="44" fill="none" stroke="' + lv.color + '" stroke-width="9" stroke-linecap="round" ' +
      'stroke-dasharray="' + dash.toFixed(1) + ' ' + C.toFixed(1) + '"/></svg>' +
      '<div class="val"><b style="color:' + lv.color + '">' + agg.score + '</b><span>综合风险分</span></div></div>' +
      '<div class="verdict-txt"><h2 style="color:' + lv.color + '">' + lv.label + ' · ' + esc(res.recommendation.urgency) + '</h2>' +
      '<p>' + esc(window.VerifierAgent.buildConclusion(res)) + '</p></div></div>' +
      '<div class="bars">' + bars + '</div>' +
      '<ul class="actions-list">' + acts + '</ul>' +
      '<div class="ev-meta" style="border:0;margin-top:4px;padding-top:0">' +
      '<span>证据总数 ' + res.signals.length + ' 条（图像 ' + agg.counts.image + ' / 文本 ' + agg.counts.text + ' / 跨模态 ' + agg.counts.cross + '）</span>' +
      '<span>Agent 端到端耗时 ' + res.elapsed + ' ms</span>' +
      (agg.corroborated ? '<span>已应用跨模态交叉印证加权</span>' : '') +
      '</div></div>';
  }

  /* ---------------- 图像卡 ---------------- */
  function propsHTML(st) {
    var sw = (st.dominant || []).slice(0, 5).map(function (d) {
      return '<i style="background:' + d.hex + '" title="' + d.hex + ' ' + d.family + ' ' + Math.round(d.share * 100) + '%"></i>';
    }).join('');
    var fams = (st.dominant || []).slice(0, 4).map(function (d) { return d.family + Math.round(d.share * 100) + '%'; }).join(' · ');
    function cell(label, val) { return '<div><span>' + label + '</span><b>' + val + '</b></div>'; }
    return '<div class="props">' +
      cell('原始尺寸', st.w + ' × ' + st.h) +
      cell('宽高比', st.aspect) +
      cell('ELA 高响应块', (st.elaHotRatio * 100).toFixed(1) + '%') +
      cell('ELA 均匀度', st.elaUniform.toFixed(3)) +
      cell('噪声残差均值', st.noiseMean.toFixed(2)) +
      cell('色度/亮度噪声比', st.chromaLumaRatio.toFixed(3)) +
      '<div><span>画面主色系</span><b style="font-size:12px">' + esc(fams) + '</b><div class="swatches">' + sw + '</div></div>' +
      '</div>';
  }

  function imageCard(res) {
    if (!res.image) return '';
    var v = res.image.visual;
    return '<div class="card" id="cardImage">' +
      '<h2 class="card-title"><span class="step-no">02</span>图像取证与可疑区域' +
      '<span class="sub">分析尺度 ' + v.w + '×' + v.h + ' · 证据块 ' + v.block + '×' + v.block + '</span></h2>' +
      '<div class="canvas-tools"><div class="seg" id="ovSeg">' +
      '<button data-ov="suspect" class="on">可疑区块</button>' +
      '<button data-ov="ela">压缩残差</button>' +
      '<button data-ov="noise">噪声异常</button>' +
      '</div><div class="legend" id="ovLegend"></div></div>' +
      '<div id="cvWrap"></div>' +
      propsHTML(res.image.stats) +
      evidenceHTML(res.signals.filter(function (s) { return s.cat === 'image'; })) +
      '</div>';
  }

  var LEGEND = {
    suspect: '<span>逐块热力图仅为诊断视图，判定只用下面这些<b>通过几何过滤的实心团块</b>：</span>',
    ela: '<span><i style="background:rgba(55,138,221,.8)"></i>轻度</span><span><i style="background:rgba(239,159,39,.8)"></i>中度</span><span><i style="background:rgba(226,75,74,.85)"></i>显著</span><span>诊断视图 · 按重压缩响应 z 值着色，未做几何过滤</span>',
    noise: '<span><i style="background:rgba(55,138,221,.8)"></i>轻度</span><span><i style="background:rgba(239,159,39,.8)"></i>中度</span><span><i style="background:rgba(226,75,74,.85)"></i>显著</span><span>诊断视图 · 按噪声残差 z 值着色，未做几何过滤</span>'
  };

  var CLUSTER_STYLE = {
    elaHigh: { fill: 'rgba(226,75,74,.18)', stroke: 'rgba(226,75,74,.9)', name: '压缩响应偏高（疑似拼接）' },
    noiseHigh: { fill: 'rgba(83,74,183,.16)', stroke: 'rgba(83,74,183,.9)', name: '局部噪声偏高' },
    elaLow: { fill: 'rgba(239,159,39,.18)', stroke: 'rgba(186,117,23,.9)', name: '过度平滑区域' },
    noiseLow: { fill: 'rgba(55,138,221,.16)', stroke: 'rgba(24,95,165,.9)', name: '局部噪声偏低' }
  };

  function heatColor(z, a) {
    if (z <= 0.7) return null;
    if (z < 1.8) return 'rgba(55,138,221,' + a + ')';
    if (z < 2.8) return 'rgba(239,159,39,' + a + ')';
    return 'rgba(226,75,74,' + a + ')';
  }

  function drawOverlay() {
    var res = state.result;
    var wrap = $('cvWrap');
    if (!res || !res.image || !wrap) return;
    var v = res.image.visual, B = v.block;
    wrap.innerHTML = '';

    var base = document.createElement('canvas');
    base.width = v.w; base.height = v.h;
    base.getContext('2d').drawImage(state.image, 0, 0, v.w, v.h);
    wrap.appendChild(base);

    var ov = document.createElement('canvas');
    ov.width = v.w; ov.height = v.h;
    var ctx = ov.getContext('2d');
    var eZ = v.ela ? v.ela.z : null, nZ = v.noiseGrid ? v.noiseGrid.z : null;

    if (state.overlay === 'suspect') {
      var cl = (v.clusters || {});
      var order = ['elaHigh', 'noiseHigh', 'elaLow', 'noiseLow'];
      var shown = [];
      order.forEach(function (key) {
        var st2 = CLUSTER_STYLE[key];
        (cl[key] || []).forEach(function (c, i) {
          var x = c.bx * B, y = c.by * B, ww = c.bw * B, hh = c.bh * B;
          ctx.fillStyle = st2.fill;
          ctx.fillRect(x, y, ww, hh);
          ctx.strokeStyle = st2.stroke;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 0.75, y + 0.75, ww - 1.5, hh - 1.5);
          if (i === 0) shown.push('<span><i style="background:' + st2.stroke + '"></i>' + st2.name + ' · ' + c.size + ' 块</span>');
        });
      });
      $('ovLegend').innerHTML = LEGEND.suspect + (shown.length
        ? shown.join('')
        : '<span>未检出形成证据的团块（零散异常块已按填充率与面积上限过滤）</span>');
    } else {
      var z = state.overlay === 'ela' ? eZ : nZ;
      var grid = state.overlay === 'ela' ? v.ela : v.noiseGrid;
      if (!z || !grid) { $('ovLegend').innerHTML = '<span>该模式数据不可用</span>'; }
      else {
        for (var k = 0; k < z.length; k++) {
          var c = heatColor(z[k], 0.55);
          if (!c) continue;
          ctx.fillStyle = c;
          ctx.fillRect((k % grid.bw) * B, Math.floor(k / grid.bw) * B, B, B);
        }
        $('ovLegend').innerHTML = LEGEND[state.overlay];
      }
    }
    wrap.appendChild(ov);
  }

  function bindOverlaySeg() {
    var seg = $('ovSeg');
    if (!seg) return;
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      state.overlay = b.dataset.ov;
      var all = seg.querySelectorAll('button');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i] === b);
      drawOverlay();
    });
  }

  /* ---------------- 文本卡 ---------------- */
  function highlight(text, marks) {
    var ms = marks.slice().sort(function (a, b) { return a.start - b.start; });
    var out = '', pos = 0;
    ms.forEach(function (m) {
      if (m.start < pos || m.start >= text.length) return;
      out += esc(text.slice(pos, m.start));
      out += '<mark class="mk ' + m.type + '" title="' + esc(m.label) + '">' + esc(text.slice(m.start, m.end)) + '</mark>';
      pos = m.end;
    });
    out += esc(text.slice(pos));
    return out.replace(/\n/g, '<br>');
  }

  function textCard(res) {
    if (!res.text) return '';
    var t = res.text, st = t.stats;
    var textLen = (state.text || '').length;
    var post = t.marks.filter(function (m) { return m.end <= textLen; });
    var cmt = t.marks.filter(function (m) { return m.start > textLen; })
      .map(function (m) { return { start: m.start - textLen - 1, end: m.end - textLen - 1, type: m.type, label: m.label }; });

    var body = '';
    if ((state.text || '').trim()) {
      body += '<div class="doc-label">正文标注（' + post.length + ' 处命中）</div>' +
        '<div class="doc">' + highlight(state.text, post) + '</div>';
    }
    if ((state.comments || '').trim()) {
      body += '<div class="doc-label">评论区标注（' + cmt.length + ' 处命中）</div>' +
        '<div class="doc">' + highlight(state.comments, cmt) + '</div>';
    }

    var props = '<div class="props">' +
      '<div><span>有效字数</span><b>' + st.chars + '</b></div>' +
      '<div><span>句数</span><b>' + st.sentences + '</b></div>' +
      '<div><span>句长变异系数</span><b>' + st.sentCV.toFixed(3) + '</b></div>' +
      '<div><span>生成倾向得分</span><b>' + st.aiScore.toFixed(3) + '</b></div>' +
      '<div><span>模板连接词</span><b>' + st.connectors + ' 处</b></div>' +
      '<div><span>真实使用细节</span><b>' + st.personal + ' 处</b></div>' +
      '</div>';

    return '<div class="card" id="cardText">' +
      '<h2 class="card-title"><span class="step-no">03</span>文本与评论区核验' +
      '<span class="sub">按判据逐处标注，点击标黄处可查看违规类型</span></h2>' +
      body + props +
      evidenceHTML(res.signals.filter(function (s) { return s.cat === 'text' || s.cat === 'cross'; })) +
      '</div>';
  }

  /* ---------------- 方法学 ---------------- */
  function methodHTML() {
    return '<details class="method" id="methodBox">' +
      '<summary>方法学与能力边界<small>建议评委与复核同学先看这一节</small></summary>' +
      '<div class="method-body"><dl>' +
      '<dt>1 · ELA 误差水平分析</dt>' +
      '<dd>把图像按质量 90 重新编码一次再逐像素求差，并放大呈现。同一张真实照片整幅经过一致的压缩链路，响应应大致均匀；局部区域响应显著偏离基线，通常意味着该区域被单独编辑、替换或来自另一张图。本引擎同时检测「异常偏高」（疑似拼接）与「异常偏低」（疑似贴入已压缩素材或局部磨皮）两个方向。</dd>' +
      '<dt>2 · 噪声一致性分析</dt>' +
      '<dd>用 3×3 中值滤波提取高频残差，逐块（16×16）比较噪声强度。相机成像在整幅图上噪声水平基本一致，区块间出现噪声断层是拼接、局部替换或局部磨皮的典型特征。</dd>' +
      '<dt>关键一步 · 异常块聚类与几何过滤</dt>' +
      '<dd>单看「哪些块异常」会产生大量误报——物体边缘、文字笔画同样会造成零散异常块。因此本引擎把异常块按四连通聚成区块，再用两个几何判据过滤：<b>填充率 ≥ 0.45</b>（真实拼接是实心团块，沿物体轮廓的细线/空心环会被剔除）与<b>面积占比上限 32%</b>（排除天空、背景墙等天然平滑的大片区域）。只有同时满足的团块才会成为证据。这一步是把误报率从「不可用」压到「可交付」的关键。</dd>' +
      '<dt>3 · 色度噪声比检测</dt>' +
      '<dd>自然图像的色度分量同样携带噪声，并与亮度细节保持相对稳定的比例。扩散类生成模型在高频色度上倾向输出确定性结果，因此色度噪声 / 亮度细节比会异常偏低。</dd>' +
      '<dt>4 · 直方图量化痕迹</dt>' +
      '<dd>统计灰度直方图的空档率与峰值占比，用于发现多层滤镜叠加、局部曲线拉伸等后处理痕迹。本项置信度较低，只作辅助证据。</dd>' +
      '<dt>5 · 复制-移动粗检</dt>' +
      '<dd>在 128×128 归一化灰度图上做 8×8 块哈希比对，寻找空间距离较远但内容高度相似的区块。天然重复纹理（格纹、大理石）会带来误报，因此本信号固定为低置信度，不单独触发任何处置动作。</dd>' +
      '<dt>6 · 元数据与来源溯源</dt>' +
      '<dd>解析 JPEG EXIF 字段与 PNG tEXt 块。生成管线常会把参数写进文件（如 AUTOMATIC1111 的 parameters 块、ComfyUI 的 prompt），这类残留是比任何统计推断都更硬的证据。</dd>' +
      '<dt>7 · 文体统计与生成倾向</dt>' +
      '<dd>综合句长变异系数、模板连接词密度、排比结构重复度、真实使用细节缺失度四项指标。这是启发式判断，在证据融合时已整体降权至 0.82。</dd>' +
      '<dt>8 · 广告合规词表扫描</dt>' +
      '<dd>依据《广告法》与化妆品功效宣称要求，扫描绝对化用语、医疗化功效宣称与效果承诺，并给出逐处标注与替换方向。</dd>' +
      '<dt>9 · 图文一致性交叉核验</dt>' +
      '<dd>把文案中的颜色 / 色号描述与图像主色分布做对照。两者无交集也无相邻色系关系时，提示「拿别人的图配自己的文案」或过度调色。</dd>' +
      '<dt>证据融合与定级</dt>' +
      '<dd>同类证据按概率叠加（1−∏(1−s·c)）而非简单求和；辅助证据权重折半；文体类启发式证据整体降权。图像侧与文本侧同时命中时，视为跨模态交叉印证并小幅加权。等级阈值：≥70 极高 / ≥48 高 / ≥26 中 / &lt;26 低。</dd>' +
      '</dl>' +
      '<div class="warn"><b>能力边界（必须向使用者说明）</b><br>' +
      '本工具全部为取证级启发式检测，<b>不是训练过的深度伪造分类器</b>，输出的是「可疑证据」而非「真伪判决」。' +
      '社交平台转存会剥离 EXIF，重度美颜与滤镜会同时压低噪声与色度信号，因此可能出现误报与漏报。' +
      '所有高风险结论都必须经过人工复核，本工具的作用是把人工复核从「全量盲审」缩小到「定向抽检」。</div>' +
      '</div></details>';
  }

  /* ---------------- 导出 ---------------- */
  function exportReport() {
    var res = state.result;
    if (!res) return;
    var report = {
      generatedAt: new Date().toISOString(),
      engine: 'Content-Verifier-Agent/0.1 (client-side forensics, no external model)',
      input: {
        image: state.imageName, imageSize: res.image ? [res.image.stats.w, res.image.stats.h] : null,
        textChars: (state.text || '').length
      },
      verdict: {
        score: res.aggregate.score,
        level: res.level.label,
        levelKey: res.level.key,
        dimensions: res.aggregate.parts,
        corroborated: res.aggregate.corroborated,
        conclusion: window.VerifierAgent.buildConclusion(res)
      },
      dispositions: res.recommendation.actions.map(function (a) { return { urgency: res.recommendation.urgency, action: a.text, triggeredBy: a.from }; }),
      evidences: res.signals.map(function (s) {
        return { id: s.id, category: s.cat, label: s.label, severity: s.severity, confidence: s.confidence, metric: s.metric, detail: s.detail, lowConfidence: !!s.lowConfidence };
      }),
      textMarks: res.text ? res.text.marks : [],
      imageStats: res.image ? {
        dominantColors: res.image.stats.dominant, elaHotRatio: res.image.stats.elaHotRatio,
        elaUniformity: res.image.stats.elaUniform, noiseMean: res.image.stats.noiseMean,
        chromaLumaRatio: res.image.stats.chromaLumaRatio
      } : null,
      trace: res.trace.map(function (t) { return { seq: t.seq, tool: t.tool, name: t.name, ms: t.ms, status: t.status, output: t.output }; })
    };
    var blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'verification-report-' + Date.now() + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast('报告已导出');
  }

  /* ---------------- 主流程 ---------------- */
  async function run() {
    if (state.running) return;
    var text = $('txt').value, cmt = $('cmt').value;
    if (!state.image && !text.trim() && !cmt.trim()) { toast('请先上传图片或粘贴待核验文案'); return; }

    state.running = true;
    $('btnRun').disabled = true;
    $('btnRun').innerHTML = '<span class="spin"></span> 核验中';
    $('placeholder').hidden = true;
    var out = $('output');
    out.hidden = false;
    out.innerHTML = traceShell();
    traceEls = {};
    $('btnExport').onclick = exportReport;

    try {
      var res = await window.VerifierAgent.run({
        image: state.image, imageBuffer: state.imageBuffer, imageMime: state.imageMime,
        imageName: state.imageName, text: text, comments: cmt
      }, onStep);

      state.result = res;
      state.text = text; state.comments = cmt;

      var traceCard = $('cardTrace');
      var holder = document.createElement('div');
      holder.innerHTML = verdictCard(res) + imageCard(res) + textCard(res);
      while (holder.firstChild) out.insertBefore(holder.firstChild, traceCard);

      bindOverlaySeg();
      state.overlay = 'suspect';
      drawOverlay();
      $('btnRun').textContent = '重新核验';
      toast('核验完成 · ' + res.level.label + '（' + res.aggregate.score + '/100）');
      out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      toast('核验出错：' + e.message);
      console.error(e);
      $('btnRun').textContent = '开始核验';
    }
    state.running = false;
    $('btnRun').disabled = false;
  }

  /* ---------------- 内置自检（在地址后加 #selfcheck 触发） ----------------
   * 依次载入三组内置样本、走完整条 UI 链路，并把结果写入隐藏节点，
   * 便于用无头浏览器（--dump-dom）做回归验证，也便于评委现场自查。 */
  var __errs = [];
  window.addEventListener('error', function (e) {
    __errs.push((e.message || 'unknown') + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
  });

  async function selfCheck() {
    var box = document.createElement('pre');
    box.id = 'selfcheck-output';
    box.style.cssText = 'position:absolute;left:-99999px;top:0';
    document.body.appendChild(box);
    var lines = [];
    for (var i = 0; i < window.Samples.list.length; i++) {
      var s = window.Samples.list[i];
      __errs = [];
      try {
        var raw = await window.Samples.load(s.id);
        setImage({ image: raw.image, buffer: raw.imageBuffer, mime: raw.imageMime, name: raw.imageName, dataUrl: raw.dataUrl });
        $('txt').value = s.text; $('cmt').value = s.comments;
        await run();
        var h2 = document.querySelector('#cardVerdict .verdict-txt h2');
        var sc = document.querySelector('#cardVerdict .gauge .val b');
        var sig = (state.result ? state.result.signals : []).map(function (x) {
          return x.id + '(' + x.severity.toFixed(2) + '/' + x.confidence.toFixed(2) + ')' + (x.metric ? '[' + x.metric + ']' : '');
        }).join(' ');
        var ist = state.result && state.result.image ? state.result.image.stats : null;
        // 验证叠加层真的被绘制：统计覆盖画布上的非透明像素
        var cvInfo = 'NA';
        var cvs = document.querySelectorAll('#cvWrap canvas');
        if (cvs.length === 2) {
          var oc = cvs[1];
          try {
            var od = oc.getContext('2d').getImageData(0, 0, oc.width, oc.height).data;
            var painted = 0;
            for (var q = 3; q < od.length; q += 4) if (od[q] > 0) painted++;
            cvInfo = oc.width + 'x' + oc.height + ',painted=' + painted;
          } catch (e2) { cvInfo = 'read-failed'; }
        }
        lines.push('CASE=' + s.id +
          ' | SCORE=' + (sc ? sc.textContent : 'NA') +
          ' | VERDICT=' + (h2 ? h2.textContent : 'NA') +
          ' | CARDS=' + document.querySelectorAll('#output > .card').length +
          ' | CANVAS=' + document.querySelectorAll('#cvWrap canvas').length +
          ' | OVERLAY=' + cvInfo +
          ' | EVID=' + document.querySelectorAll('#cardVerdict ~ .card .ev').length +
          ' | MARKS=' + document.querySelectorAll('.doc mark').length +
          ' | TRACE=' + document.querySelectorAll('#traceList li').length +
          ' | ERRS=' + __errs.length + (__errs.length ? ' [' + __errs.join(' ; ') + ']' : ''));
        lines.push('  SIGNALS: ' + (sig || '(none)'));
        if (ist) {
          lines.push('  IMGSTAT: elaHot=' + ist.elaHotRatio.toFixed(4) +
            ' elaUnif=' + ist.elaUniform.toFixed(4) +
            ' noiseMean=' + ist.noiseMean.toFixed(3) +
            ' chromaLuma=' + ist.chromaLumaRatio.toFixed(4) +
            ' dominant=' + ist.dominant.slice(0, 3).map(function (d) { return d.family + Math.round(d.share * 100) + '%'; }).join(','));
        }
        var tr = state.result ? state.result.text : null;
        if (tr && tr.stats) {
          lines.push('  TXTSTAT: cv=' + tr.stats.sentCV.toFixed(3) + ' ai=' + tr.stats.aiScore.toFixed(3) +
            ' conn=' + tr.stats.connectors + ' pers=' + tr.stats.personal +
            ' emo=' + (tr.stats.emotion || 0) + ' hedge=' + (tr.stats.hedge || 0) +
            ' colors=' + (tr.stats.colorMention || []).map(function (c) { return c.family; }).join('/'));
        }
      } catch (e) {
        lines.push('CASE=' + s.id + ' | FATAL=' + e.message);
      }
    }
    box.textContent = '\nSELFCHECK_BEGIN\n' + lines.join('\n') + '\nSELFCHECK_END\n';
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    buildSampleButtons();

    var drop = $('drop');
    drop.addEventListener('click', function () { $('file').click(); });
    $('file').addEventListener('change', function (e) { handleFile(e.target.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

    $('txt').addEventListener('input', updateIoHint);
    $('cmt').addEventListener('input', updateIoHint);
    $('btnRun').onclick = run;
    $('btnClear').onclick = clearAll;

    var mb = document.createElement('div');
    mb.innerHTML = methodHTML();
    document.querySelector('.pane-left').appendChild(mb.firstChild);
    $('btnMethod').onclick = function () {
      var d = $('methodBox');
      d.open = !d.open;
      if (d.open) d.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    updateIoHint();

    if (location.hash.indexOf('selfcheck') >= 0) { setTimeout(selfCheck, 60); return; }

    // 深链接：index.html#sample=ai 可直接打开并核验指定样本
    var m = location.hash.match(/sample=([a-z]+)/);
    if (m && window.Samples.list.some(function (s) { return s.id === m[1]; })) {
      setTimeout(async function () {
        var btn = null, btns = document.querySelectorAll('#samples button');
        for (var i = 0; i < window.Samples.list.length; i++) if (window.Samples.list[i].id === m[1]) btn = btns[i];
        await loadSample(m[1], btn);
        await run();
      }, 60);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
