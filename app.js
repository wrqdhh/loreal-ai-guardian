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
    renderCover(null);
    var al = $('askLog');
    if (al) al.innerHTML = '';
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

  /* ---------------- 检测覆盖矩阵 ----------------
   * 证据表只回答「发现了什么」。这里补上另一半：本次跑了哪些维度、
   * 哪些已查未发现、哪些因缺少输入而没有运行。未命中同样是有价值的结论——
   * 它说明该维度的造假特征未被检出，而不是没有检查。 */
  var CHECKS = [
    { cat: 'image', name: 'ELA 重压缩差分', ids: ['ela-hotspot', 'ela-cold'], miss: '局部编辑痕迹' },
    { cat: 'image', name: '噪声一致性', ids: ['noise-high', 'noise-low', 'noise-absent'], miss: '噪声断层' },
    { cat: 'image', name: '色度/亮度噪声比', ids: ['chroma-flat'], miss: '色度噪声缺失' },
    { cat: 'image', name: '直方图量化痕迹', ids: ['hist-quant'], miss: '后处理痕迹' },
    { cat: 'image', name: '复制-移动粗检', ids: ['copy-move'], miss: '重复区块' },
    // ids 需与 engine.js / agent.js 中实际 push 的证据 id 保持一致；新增检测器时同步此处。
    { cat: 'image', name: '生成规格画像', ids: ['gen-size'], miss: '生成规格特征' },
    { cat: 'image', name: '元数据溯源', ids: ['meta-ai', 'meta-noexif'], miss: '生成工具残签' },
    { cat: 'text', name: '文体生成倾向', ids: ['text-ai'], miss: '机器生成特征' },
    { cat: 'text', name: '广告法合规', ids: ['text-adlaw'], miss: '违规表述' },
    { cat: 'text', name: '评论区刷评', ids: ['text-shill'], miss: '刷评特征' },
    { cat: 'cross', name: '图文一致性', ids: ['cross-color'], miss: '图文矛盾' }
  ];

  function coverRuns(c, hasImg, hasTxt) {
    if (c.cat === 'cross') return hasImg && hasTxt;
    if (c.cat === 'image') return hasImg;
    return hasTxt;
  }

  function signalIndex(res) {
    var by = {};
    (res ? res.signals : []).forEach(function (s) {
      if (!by[s.id] || s.severity > by[s.id].severity) by[s.id] = s;
    });
    return by;
  }

  function renderCover(res) {
    var box = $('cover');
    if (!box) return;
    var by = signalIndex(res);
    var hasImg = !!(res && res.image), hasTxt = !!(res && res.text);

    var cells = CHECKS.map(function (c) {
      var hits = c.ids.filter(function (id) { return by[id]; });
      if (!coverRuns(c, hasImg, hasTxt)) {
        return '<div class="cover-cell skip"><div class="st"></div><div><b>' + c.name +
          '</b><em>未运行 · 未接入' + (c.cat === 'image' ? '图片' : c.cat === 'text' ? '文案' : '图文') + '</em></div></div>';
      }
      if (hits.length) {
        var best = null, top = 0;
        hits.forEach(function (id) {
          var w = by[id].severity * by[id].confidence;
          if (w > top) { top = w; best = by[id]; }
        });
        // 弱信号（如 EXIF 缺失）单独成档，避免与真正的造假证据视觉混同
        var weak = top < 0.30;
        var info = hits.length > 1
          ? hits.length + ' 条证据 · ' + c.miss
          : (best.metric ? best.metric.split(' · ')[0] : c.miss);
        return '<div class="cover-cell ' + (weak ? 'warn' : 'hit') + '"><div class="st"></div><div><b>' + c.name +
          '</b><em>' + (weak ? '弱信号 · ' : '') + esc(info) + '</em></div></div>';
      }
      return '<div class="cover-cell pass"><div class="st"></div><div><b>' + c.name +
        '</b><em>已查 · 未检出' + esc(c.miss) + '</em></div></div>';
    }).join('');

    var run = CHECKS.filter(function (c) { return coverRuns(c, hasImg, hasTxt); });
    var strong = 0, weak = 0;
    run.forEach(function (c) {
      var top = 0;
      c.ids.forEach(function (id) { if (by[id]) top = Math.max(top, by[id].severity * by[id].confidence); });
      if (top >= 0.30) strong++; else if (top > 0) weak++;
    });
    var sub = res
      ? (strong + ' 项命中' + (weak ? ' · ' + weak + ' 项弱信号' : '') + ' · 共 ' + run.length + ' 项已运行')
      : '等待核验';

    box.innerHTML = '<div class="cover" id="cardCover">' +
      '<h2 class="card-title"><span class="step-no">04</span>检测覆盖矩阵<span class="sub">' + sub + '</span></h2>' +
      '<p class="cover-note">上面的证据表只回答「发现了什么」。这一节补上另一半：<b>本次到底跑了哪些维度、哪些已查未发现、哪些因为没有输入而没有运行</b>。' +
      '未命中同样是有价值的结论——它说明该维度的造假特征未被检出，而不是没有检查。</p>' +
      '<div class="cover-grid">' + cells + '</div></div>';
  }

  /* ---------------- 核验历史 ----------------
   * 只留存结论摘要（分数 / 等级 / 证据 ID），不保存图片与原文。
   * 存在本机 localStorage，不上传；隐私模式或配额超限时静默降级为不留存。 */
  var HIST_KEY = 'tg_history_v1', HIST_MAX = 30;

  function readHistory() {
    try {
      var arr = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
    } catch (e) { return []; }
  }

  function saveHistory(arr) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(arr.slice(0, HIST_MAX))); } catch (e) { /* 静默降级 */ }
  }

  function histLabel() {
    if (state.imageName) return state.imageName;
    var t = (state.text || '').trim().replace(/\s+/g, ' ');
    if (t) return t.slice(0, 18) + (t.length > 18 ? '…' : '');
    var n = (state.comments || '').split('\n').filter(function (s) { return s.trim(); }).length;
    return '仅评论区 · ' + n + ' 条';
  }

  function pushHistory(res) {
    if (window.__tgNoHist) return;
    var arr = readHistory();
    arr.unshift({
      ts: Date.now(), label: histLabel(), score: res.aggregate.score,
      level: res.level.label, color: res.level.color,
      counts: res.aggregate.counts,
      sigIds: res.signals.map(function (s) { return s.id; })
    });
    saveHistory(arr);
    renderHistory();
  }

  function renderHistory() {
    var box = $('history');
    if (!box) return;
    var arr = readHistory();
    var items = arr.map(function (r, i) {
      var prev = arr[i + 1];
      var delta = !prev ? '首次核验'
        : r.score === prev.score ? '与上次持平（' + prev.score + ' 分）'
          : '较上次 ' + (r.score > prev.score ? '+' : '') + (r.score - prev.score);
      var dt = new Date(r.ts);
      var hh = ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2);
      return '<li title="本次命中的证据：' + esc((r.sigIds || []).join(', ') || '无') + '">' +
        '<div class="hist-top"><b>' + esc(r.label) + '</b><em style="color:' + r.color + '">' + r.score + '</em></div>' +
        '<div class="hist-meta">' + esc(r.level) + ' · 图像 ' + r.counts.image + ' / 文本 ' + r.counts.text +
        ' / 跨模态 ' + r.counts.cross + ' · ' + hh + '</div>' +
        '<div class="track"><i style="width:' + r.score + '%;background:' + r.color + '"></i></div>' +
        '<div class="hist-delta">' + delta + '</div></li>';
    }).join('');

    box.innerHTML = '<div class="card" id="cardHistory">' +
      '<h2 class="card-title"><span class="step-no">05</span>核验历史' +
      '<span class="sub">' + (arr.length ? '共 ' + arr.length + ' 次' : '暂无记录') + '</span></h2>' +
      '<p class="hist-note">只留存结论摘要（分数 / 等级 / 证据 ID），<b>不保存图片与原文</b>，全部留在本机浏览器，不上传。悬停任一条可查看该次命中的证据 ID。</p>' +
      (items ? '<ul class="hist-list">' + items + '</ul>'
        : '<div class="hist-empty">完成一次核验后，这里会留下可对比的记录。<br>多次核验之间能看出同一批素材的风险分布。</div>') +
      (arr.length ? '<div class="hist-actions"><button class="btn ghost" id="btnHistClear" style="font-size:12px">清空历史</button></div>' : '') +
      '</div>';

    var hc = $('btnHistClear');
    if (hc) hc.onclick = function () { saveHistory([]); renderHistory(); toast('核验历史已清空'); };
  }

  /* ---------------- 追问助手 ----------------
   * 规则驱动：回答只用本次已经算出的证据，不联网、不臆测、不编造。
   * 预留 window.TGModel 钩子——接入开源大模型后由模型接管自由问答，规则回答退化为断网兜底。 */
  var ASK_ITEMS = [
    { id: 'where', q: '可疑在哪里？' },
    { id: 'text', q: '文案有什么问题？' },
    { id: 'why', q: '为什么是这个等级？' },
    { id: 'todo', q: '我该怎么做？' },
    { id: 'pass', q: '哪些维度没查出问题？' },
    { id: 'trust', q: '这个结论可靠吗？' }
  ];

  function answerOf(id, res) {
    if (!res) return { html: '先完成一次核验，我就能基于本次证据回答。', src: '' };
    var agg = res.aggregate, by = signalIndex(res);
    var img = res.signals.filter(function (s) { return s.cat === 'image'; });
    var txt = res.signals.filter(function (s) { return s.cat === 'text'; });
    var listOf = function (arr) {
      return '<ul>' + arr.map(function (s) {
        return '<li>' + esc(s.label) + (s.metric ? '（' + esc(s.metric) + '）' : '') + '</li>';
      }).join('') + '</ul>';
    };
    var srcOf = function (arr) { return 'source: ' + arr.map(function (s) { return s.id; }).join(', '); };

    if (id === 'where') {
      if (!res.image) return { html: '本次没有上传图片，图像侧未参与核验。', src: 'source: content_parser · 无图像输入' };
      if (!img.length) return {
        html: '图像侧 6 个检测维度<b>均未检出</b>形成证据的异常，说明没有发现拼接或生成特征。<br>' +
          '这不等于图片一定为真——平台二次压缩会削弱 ELA 与噪声特征，重度美颜也会压低色度信号。',
        src: 'source: forensics_pipeline · 证据 0 条'
      };
      return {
        html: '图像侧检出 <b>' + img.length + ' 条</b>：' + listOf(img) +
          '可疑区域已在上方图像卡中圈出，可切换「可疑区块 / 压缩残差 / 噪声异常」三种视图核对。',
        src: srcOf(img)
      };
    }

    if (id === 'text') {
      if (!res.text) return { html: '本次没有填写正文或评论区，文本侧未参与核验。', src: 'source: content_parser · 无文本输入' };
      if (!txt.length) return {
        html: '文体统计与合规词表<b>均未命中</b>。文案在句长变化、真实细节密度、合规表述上未见异常。<br>' +
          '需要说明：「生成倾向」是启发式判断，真人写的营销软文也可能带有生成感。',
        src: 'source: text_pipeline · 证据 0 条'
      };
      return {
        html: '文本侧检出 <b>' + txt.length + ' 条</b>：' + listOf(txt) +
          '命中位置已在文本卡中逐处标注，鼠标悬停可看违规类型。',
        src: srcOf(txt)
      };
    }

    if (id === 'why') {
      var top = res.signals.slice().sort(function (a, b) {
        return b.severity * b.confidence - a.severity * a.confidence;
      })[0];
      return {
        html: '综合分 <b>' + agg.score + '/100</b>，落在「' + esc(res.level.label) + '」档。三个维度贡献：图像 ' +
          agg.parts.image + ' · 文本 ' + agg.parts.text + ' · 跨模态 ' + agg.parts.cross + '。<br>' +
          (top ? '权重最高的一条是<b>' + esc(top.label) + '</b>（严重度 ' + top.severity.toFixed(2) +
            ' × 置信度 ' + top.confidence.toFixed(2) + '）。' : '') +
          '同类证据按 1−∏(1−s·c) 概率叠加而非简单求和，所以多条中等证据不会直接顶到满分；辅助证据权重折半，文体类启发式整体降权。',
        src: 'source: evidence_fusion · 证据 ' + res.signals.length + ' 条' + (agg.corroborated ? ' · 已应用跨模态交叉印证' : '')
      };
    }

    if (id === 'todo') {
      if (!res.recommendation.actions.length) return { html: '当前无需处置动作。', src: 'source: decision_engine' };
      return {
        html: '处置等级：<b>' + esc(res.recommendation.urgency) + '</b><ul>' +
          res.recommendation.actions.map(function (a) {
            return '<li>' + esc(a.text) + '<span style="color:#8C8A82"> —— 触发证据：' + esc(a.from) + '</span></li>';
          }).join('') + '</ul>每条建议都能追溯到触发它的证据 ID，可反向核对。',
        src: 'source: decision_engine'
      };
    }

    if (id === 'pass') {
      var hasImg = !!res.image, hasTxt = !!res.text;
      var pass = [], skip = [];
      CHECKS.forEach(function (c) {
        if (!coverRuns(c, hasImg, hasTxt)) { skip.push(c.name); return; }
        if (!c.ids.some(function (x) { return by[x]; })) pass.push(c.name);
      });
      var h = '已查但未检出问题的维度共 <b>' + pass.length + ' 项</b>：' + (pass.length ? pass.join('、') : '（无）') + '。';
      if (skip.length) h += '<br>另有 <b>' + skip.length + ' 项</b>未运行：' + skip.join('、') + ' —— 本次缺少对应输入。';
      h += '<br>「未检出」只代表这些维度的造假特征没有被发现，不代表内容为真。';
      return { html: h, src: 'source: 覆盖矩阵 · 已查 ' + pass.length + ' 项 / 未运行 ' + skip.length + ' 项' };
    }

    if (id === 'trust') {
      var maxC = 0;
      res.signals.forEach(function (s) { maxC = Math.max(maxC, s.confidence); });
      return {
        html: '本次共 <b>' + res.signals.length + ' 条</b>证据，最高单条置信度 <b>' + maxC.toFixed(2) + '</b>' +
          (agg.corroborated ? '，并已出现跨模态交叉印证（图文两侧同时命中，可信度高于单侧）' : '') + '。<br>' +
          '需要提醒：本工具是<b>取证级启发式检测，不是训练过的深度伪造分类器</b>，输出的是「可疑证据」而非「真伪判决」。' +
          '平台转存会剥离 EXIF，重度美颜与滤镜会同时压低噪声与色度信号，因此存在误报与漏报。<br>' +
          '高风险结论务必人工复核；低分也不等于放行，只是把人工抽检的范围缩小了。',
        src: 'source: evidence_fusion + 能力边界声明'
      };
    }
    return { html: '暂不支持这个问题。', src: '' };
  }

  function renderAsk() {
    var box = $('ask');
    if (!box || box.dataset.built) return;
    box.dataset.built = '1';
    box.innerHTML = '<div class="card" id="cardAsk">' +
      '<h2 class="card-title"><span class="step-no">06</span>追问助手' +
      '<span class="sub" id="askMode">规则驱动 · 全部本地计算</span></h2>' +
      '<p class="hist-note">对结论有疑问就直接问。回答只用本次已经算出来的证据，<b>不联网、不臆测、不编造</b>，每条末尾都标出它读的是哪一步的输出。' +
      '接入开源大模型后，这里升级为自由问答，规则回答退化为断网兜底。</p>' +
      '<div class="ask-chips" id="askChips">' +
      ASK_ITEMS.map(function (it) { return '<button data-ask="' + it.id + '">' + it.q + '</button>'; }).join('') +
      '</div><div class="ask-log" id="askLog"></div></div>';

    $('askChips').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-ask]');
      if (b) askQuestion(b.dataset.ask, b.textContent);
    });

    if (window.TGModel && typeof window.TGModel.available === 'function') {
      var m = $('askMode');
      if (m) m.textContent = window.TGModel.available() ? '已接入模型 · 可自由问答' : '规则驱动 · 模型不可用';
    }
  }

  function askQuestion(id, q) {
    var log = $('askLog');
    if (!log) return;
    var a = answerOf(id, state.result);
    log.insertAdjacentHTML('beforeend',
      '<div class="ask-q">' + esc(q) + '</div>' +
      '<div class="ask-a">' + a.html + (a.src ? '<div class="src">' + esc(a.src) + '</div>' : '') + '</div>');
    log.lastElementChild.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    var askLog = $('askLog');
    if (askLog) askLog.innerHTML = '';   // 上一轮的问答已随旧结论失效，清空
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
      renderCover(res);
      pushHistory(res);
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
    window.__tgNoHist = true;   // 自检不写入核验历史，避免污染真实记录
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
        // 新增面板回归：卡片必须渲染，且追问助手每一条问题都要产出回答
        if (!document.getElementById('cardHistory')) __errs.push('核验历史卡未渲染');
        if (!document.getElementById('cardAsk')) __errs.push('追问助手卡未渲染');
        var chips = document.querySelectorAll('#askChips button');
        var answered = 0;
        for (var ci = 0; ci < chips.length; ci++) {
          var before = document.querySelectorAll('#askLog .ask-a').length;
          chips[ci].click();
          if (document.querySelectorAll('#askLog .ask-a').length > before) answered++;
        }
        if (answered !== chips.length) __errs.push('追问助手仅 ' + answered + '/' + chips.length + ' 条产出回答');

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
    renderCover(null);
    renderHistory();
    renderAsk();

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
