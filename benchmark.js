/**
 * benchmark.js — 用 dataset/ 里的测试数据评估 Agent
 *
 * 与 selftest.js 的区别：selftest 是「功能对不对」的断言，
 * benchmark 是「效果有多好」的量化指标 —— 精确率、召回率、误报率、定位 IoU。
 *
 * 三个评测维度：
 *   1) 图像级：内容是否被判为可疑（二分类）
 *   2) 区域级：篡改样本上，标出的可疑区域与 ground truth mask 的 IoU
 *   3) 文本级：ai_written / ad_violation / shill 三类判定各自的 P / R / F1
 *
 * 必须在 http 下运行（fetch 读取 dataset），不支持 file:// 直接打开。
 */
(function () {
  'use strict';

  var TH_HIGH = 48;   // 「高风险」档阈值，作为判定为正类（可疑）的默认门槛
  var TH_MID = 26;    // 「中风险」档阈值，用于报告另一组工作点
  var IOU_HIT = 0.30; // 定位成功线

  function $(id) { return document.getElementById(id); }

  function fetchJSON(u) {
    return fetch(u, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('无法读取 ' + u + '（HTTP ' + r.status + '）');
      return r.json();
    });
  }

  function loadImage(src) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error('图片加载失败 ' + src)); };
      im.src = src;
    });
  }

  function fetchBuffer(u) {
    return fetch(u, { cache: 'no-store' }).then(function (r) { return r.arrayBuffer(); });
  }

  /** 把 mask PNG 读成 0/1 二值数组 */
  function loadMask(src, w, h) {
    return loadImage(src).then(function (im) {
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(im, 0, 0, w, h);
      var d = ctx.getImageData(0, 0, w, h).data;
      var out = new Uint8Array(w * h);
      for (var i = 0; i < w * h; i++) out[i] = d[i * 4] > 127 ? 1 : 0;
      return out;
    });
  }

  /** 把 Agent 输出的团块栅格化为原图尺寸的 0/1 预测图（用 bbox 近似） */
  function clustersToMask(clusters, visW, visH, block, outW, outH) {
    var m = new Uint8Array(outW * outH);
    if (!clusters || !clusters.length) return m;
    var sx = outW / visW, sy = outH / visH;
    clusters.forEach(function (c) {
      var x0 = Math.max(0, Math.round(c.bx * block * sx));
      var y0 = Math.max(0, Math.round(c.by * block * sy));
      var x1 = Math.min(outW, Math.round((c.bx + c.bw) * block * sx));
      var y1 = Math.min(outH, Math.round((c.by + c.bh) * block * sy));
      for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) m[y * outW + x] = 1;
    });
    return m;
  }

  function iou(a, b) {
    var inter = 0, uni = 0;
    for (var i = 0; i < a.length; i++) {
      var x = a[i], y = b[i];
      if (x || y) uni++;
      if (x && y) inter++;
    }
    return uni === 0 ? 0 : inter / uni;
  }

  function prf(tp, fp, fn) {
    var p = (tp + fp) ? tp / (tp + fp) : 0;
    var r = (tp + fn) ? tp / (tp + fn) : 0;
    var f = (p + r) ? 2 * p * r / (p + r) : 0;
    return { tp: tp, fp: fp, fn: fn, precision: p, recall: r, f1: f };
  }
  function pct(v) { return (v * 100).toFixed(1) + '%'; }

  /* ---------------- 主流程 ---------------- */

  async function run(opts) {
    opts = opts || {};
    var th = opts.threshold || TH_HIGH;
    var log = opts.onLog || function () { };

    var man = await fetchJSON('dataset/manifest.json');
    var tset = await fetchJSON('dataset/text/text_set.json');

    var rows = [];
    var skippedSynthetic = 0;

    for (var i = 0; i < man.samples.length; i++) {
      var s = man.samples[i];
      if (s.synthetic && !opts.includeSynthetic) { skippedSynthetic++; continue; }

      // 图文配对：manifest 样本可用 text_case 显式指定配套文本。
      // 未指定时退回循环取模——取模只保证「有文本输入」，并不代表图文语义相关；
      // 正式评测应在 manifest 里逐条显式配对，否则图文交叉证据的评测结果不可信。
      var pairing = 'explicit', tc = null;
      if (s.text_case) {
        for (var ci = 0; ci < tset.cases.length; ci++) if (tset.cases[ci].id === s.text_case) tc = tset.cases[ci];
        if (!tc) { tc = tset.cases[i % tset.cases.length]; pairing = 'fallback'; }
      } else {
        tc = tset.cases[i % tset.cases.length];
        pairing = 'roundrobin';
      }
      log('[' + (i + 1) + '/' + man.samples.length + '] ' + s.id + ' … 配对=' + pairing + ':' + tc.id);

      // manifest 里的路径相对 dataset/，URL 需要补上前缀
      var imgUrl = 'dataset/' + s.image;
      var img = await loadImage(imgUrl);
      var buf = await fetchBuffer(imgUrl);
      var comments = (tc.comments || []).join('\n');

      var res = await window.VerifierAgent.run({
        image: img, imageBuffer: buf, imageMime: 'image/png',
        imageName: s.id + '.png', text: tc.body, comments: comments,
        fast: true
      }, null);

      var truthPositive = s.label !== 'authentic';
      var predPositive = res.aggregate.score >= th;

      var row = {
        id: s.id, category: s.category, label: s.label,
        score: res.aggregate.score, level: res.level.label,
        truth: truthPositive ? 'suspicious' : 'authentic',
        pred: predPositive ? 'suspicious' : 'authentic',
        correct: truthPositive === predPositive,
        signals: res.signals.map(function (x) { return x.id; }),
        textCase: tc.id,
        pairing: pairing
      };

      // 区域级定位
      if (s.mask) {
        var gt = await loadMask('dataset/' + s.mask, s.width, s.height);
        var vis = res.image && res.image.visual;
        var cl = vis && vis.clusters ? vis.clusters : null;
        row.cl = {
          elaLow: cl ? (cl.elaLow || []).length : -1,
          noiseLow: cl ? (cl.noiseLow || []).length : -1,
          elaHigh: cl ? (cl.elaHigh || []).length : -1,
          noiseHigh: cl ? (cl.noiseHigh || []).length : -1
        };
        // 篡改区的表现方向不唯一：AI 贴片通常低噪声/低 ELA，但换背景、局部重绘也可能相反。
        // 先用低响应团块定位，若为空再退回高响应团块。
        var cand = (cl ? (cl.elaLow || []).concat(cl.noiseLow || []) : []);
        if (!cand.length) cand = (cl ? (cl.elaHigh || []).concat(cl.noiseHigh || []) : []);
        var pred = clustersToMask(cand,
          vis ? vis.w : s.width, vis ? vis.h : s.height,
          vis ? vis.block : 16, s.width, s.height);
        row.iou = iou(pred, gt);
        row.located = row.iou >= IOU_HIT;
      }
      rows.push(row);
    }

    /* --- 图像级汇总 --- */
    var tp = 0, fp = 0, tn = 0, fn = 0;
    rows.forEach(function (r) {
      if (r.truth === 'suspicious' && r.pred === 'suspicious') tp++;
      else if (r.truth === 'authentic' && r.pred === 'suspicious') fp++;
      else if (r.truth === 'authentic' && r.pred === 'authentic') tn++;
      else fn++;
    });
    var imgMetrics = prf(tp, fp, fn);
    imgMetrics.tn = tn;
    imgMetrics.accuracy = rows.length ? (tp + tn) / rows.length : 0;
    imgMetrics.fpr = (fp + tn) ? fp / (fp + tn) : 0;   // 误报率：真实内容被错判的比例

    // 分 category 统计（重点看美颜类的误报）
    var byCat = {};
    rows.forEach(function (r) {
      var c = byCat[r.category] || (byCat[r.category] = { n: 0, correct: 0, falseAlarm: 0, missRate: 0 });
      c.n++;
      if (r.correct) c.correct++;
      if (r.truth === 'authentic' && r.pred === 'suspicious') c.falseAlarm++;
      if (r.truth === 'suspicious' && r.pred === 'authentic') c.missRate++;
    });

    /* --- 区域级汇总 --- */
    var withMask = rows.filter(function (r) { return r.iou !== undefined; });
    var locMetrics = {
      n: withMask.length,
      meanIou: withMask.length ? withMask.reduce(function (a, r) { return a + r.iou; }, 0) / withMask.length : 0,
      hit: withMask.filter(function (r) { return r.located; }).length
    };
    locMetrics.hitRate = withMask.length ? locMetrics.hit / withMask.length : 0;

    /* --- 文本级汇总 --- */
    var textRows = [], tm = { ai_written: prf(0, 0, 0), ad_violation: prf(0, 0, 0), shill: prf(0, 0, 0) };
    for (var t = 0; t < tset.cases.length; t++) {
      var c = tset.cases[t];
      var r2 = window.VerifierEngine.textForensics(c.body, (c.comments || []).join('\n'));
      var ids = r2.signals.map(function (x) { return x.id; });
      var got = { ai_written: ids.indexOf('text-ai') >= 0, ad_violation: ids.indexOf('text-adlaw') >= 0, shill: ids.indexOf('text-shill') >= 0 };
      textRows.push({ id: c.id, truth: c.labels, pred: got, aiScore: r2.stats ? r2.stats.aiScore : null });
      ['ai_written', 'ad_violation', 'shill'].forEach(function (k) {
        var tt = !!c.labels[k], pp = !!got[k];
        if (tt && pp) tm[k].tp++;
        else if (!tt && pp) tm[k].fp++;
        else if (tt && !pp) tm[k].fn++;
      });
    }
    ['ai_written', 'ad_violation', 'shill'].forEach(function (k) {
      var v = tm[k];
      var p = (v.tp + v.fp) ? v.tp / (v.tp + v.fp) : 0;
      var rr = (v.tp + v.fn) ? v.tp / (v.tp + v.fn) : 0;
      v.precision = p; v.recall = rr; v.f1 = (p + rr) ? 2 * p * rr / (p + rr) : 0;
    });

    var report = {
      generated: new Date().toISOString(),
      threshold: th,
      dataset: { total: man.samples.length, evaluated: rows.length, skippedSynthetic: skippedSynthetic, synthetic: man.synthetic },
      image: imgMetrics,
      byCategory: byCat,
      localization: locMetrics,
      text: tm,
      rows: rows,
      textRows: textRows
    };
    return report;
  }

  /* ---------------- 页面渲染 ---------------- */

  function render(report) {
    var h = '';
    function card(title, val, sub) {
      return '<div class="card"><div class="k">' + title + '</div><div class="v">' + val + '</div><div class="s">' + (sub || '') + '</div></div>';
    }
    var im = report.image;
    h += '<div class="grid">';
    h += card('图像级精确率', pct(im.precision), '报警的样本中真正有问题的比例');
    h += card('图像级召回率', pct(im.recall), '有问题的样本中被抓到的比例');
    h += card('F1', pct(im.f1), '精确率与召回率的调和平均');
    h += card('误报率', pct(im.fpr), '真实内容被错判为可疑的比例');
    h += card('定位平均 IoU', pct(report.localization.meanIou), '仅在带 mask 的篡改样本上计算');
    h += card('定位成功率', pct(report.localization.hitRate), 'IoU ≥ ' + IOU_HIT + ' 视为定位到');
    h += '</div>';

    h += '<h3>分类别表现</h3><table><thead><tr><th>类别</th><th>样本数</th><th>判定正确</th><th>误报</th><th>漏检</th></tr></thead><tbody>';
    for (var k in report.byCategory) {
      var c = report.byCategory[k];
      h += '<tr><td>' + k + '</td><td>' + c.n + '</td><td>' + c.correct + '</td><td>' + c.falseAlarm + '</td><td>' + c.missRate + '</td></tr>';
    }
    h += '</tbody></table>';

    h += '<h3>文本侧</h3><table><thead><tr><th>判定维度</th><th>精确率</th><th>召回率</th><th>F1</th></tr></thead><tbody>';
    ['ai_written', 'ad_violation', 'shill'].forEach(function (k) {
      var v = report.text[k];
      h += '<tr><td>' + k + '</td><td>' + pct(v.precision) + '</td><td>' + pct(v.recall) + '</td><td>' + pct(v.f1) + '</td></tr>';
    });
    h += '</tbody></table>';

    h += '<h3>逐样本明细</h3><table class="sm"><thead><tr><th>样本</th><th>类别</th><th>真值</th><th>判定</th><th>得分</th><th>IoU</th><th>触发证据</th></tr></thead><tbody>';
    report.rows.forEach(function (r) {
      h += '<tr class="' + (r.correct ? 'ok' : 'bad') + '"><td>' + r.id + '</td><td>' + r.category + '</td><td>' + r.truth +
        '</td><td>' + r.pred + '</td><td>' + r.score + '</td><td>' + (r.iou === undefined ? '—' : r.iou.toFixed(3)) +
        '</td><td class="sig">' + r.signals.join(', ') + '</td></tr>';
    });
    h += '</tbody></table>';

    var box = $('report');
    if (box) box.innerHTML = h;
  }

  /** 无头/深链接模式：#benchmark 自动跑，结果写进隐藏节点供 --dump-dom 抓取 */
  async function auto() {
    var pre = document.createElement('pre');
    pre.id = 'benchmark-output';
    pre.style.cssText = 'position:absolute;left:-99999px;top:0';
    document.body.appendChild(pre);
    var L = [];
    try {
      // 无头/深链接模式默认连 synthetic 一起跑，以便验证工具链；报告里会显式标注
      var rep = await run({ includeSynthetic: true, onLog: function (m) { L.push(m); } });
      L.push('BENCH_BEGIN');
      if (rep.dataset.synthetic) {
        L.push('WARN 数据集为程序化素材（synthetic=true），以下数字仅证明工具链跑通，不代表真实检测能力');
      }
      L.push('DATASET total=' + rep.dataset.total + ' evaluated=' + rep.dataset.evaluated +
        ' skipped_synthetic=' + rep.dataset.skippedSynthetic + ' synthetic=' + rep.dataset.synthetic);
      var im = rep.image;
      L.push('IMAGE th=' + rep.threshold + ' TP=' + im.tp + ' FP=' + im.fp + ' TN=' + im.tn + ' FN=' + im.fn +
        ' P=' + im.precision.toFixed(3) + ' R=' + im.recall.toFixed(3) + ' F1=' + im.f1.toFixed(3) +
        ' ACC=' + im.accuracy.toFixed(3) + ' FPR=' + im.fpr.toFixed(3));
      for (var k in rep.byCategory) {
        var c = rep.byCategory[k];
        L.push('  CAT=' + k + ' n=' + c.n + ' correct=' + c.correct + ' falseAlarm=' + c.falseAlarm + ' miss=' + c.missRate);
      }
      L.push('LOCAL n=' + rep.localization.n + ' meanIoU=' + rep.localization.meanIou.toFixed(3) +
        ' hit=' + rep.localization.hit + ' hitRate=' + rep.localization.hitRate.toFixed(3));
      ['ai_written', 'ad_violation', 'shill'].forEach(function (kk) {
        var v = rep.text[kk];
        L.push('TEXT ' + kk + ' P=' + v.precision.toFixed(3) + ' R=' + v.recall.toFixed(3) + ' F1=' + v.f1.toFixed(3));
      });
      rep.textRows.forEach(function (r) {
        ['ai_written', 'ad_violation', 'shill'].forEach(function (kk) {
          var t = !!r.truth[kk], p = !!r.pred[kk];
          if (t !== p) L.push('TEXTMISS ' + r.id + ' dim=' + kk + ' truth=' + t + ' pred=' + p +
            (kk === 'ai_written' && r.aiScore !== null ? ' aiScore=' + r.aiScore.toFixed(3) : ''));
        });
      });
      rep.rows.forEach(function (r) {
        L.push('ROW ' + r.id + ' cat=' + r.category + ' truth=' + r.truth + ' pred=' + r.pred +
          ' score=' + r.score + ' sig=[' + r.signals.join(',') + ']' +
          ' pairing=' + r.pairing + ':' + r.textCase + (r.iou === undefined ? '' : ' iou=' + r.iou.toFixed(3) +
            (r.cl ? ' clusters[elaLow=' + r.cl.elaLow + ' noiseLow=' + r.cl.noiseLow +
              ' elaHigh=' + r.cl.elaHigh + ' noiseHigh=' + r.cl.noiseHigh + ']' : '')) + ' ' + (r.correct ? 'OK' : 'MISS'));
      });
      L.push('BENCH_END');
      window.__benchmarkReport = rep;
      render(rep);
    } catch (e) {
      L.push('BENCH_BEGIN');
      L.push('ERROR ' + e.message);
      L.push('BENCH_END');
    }
    pre.textContent = L.join('\n');
  }

  window.Benchmark = { run: run, auto: auto, render: render };
})();
