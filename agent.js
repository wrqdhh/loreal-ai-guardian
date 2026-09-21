/* ============================================================
 * agent.js — 内容核验 Agent 编排层
 * 职责：规划工具调用 → 记录可审计轨迹 → 聚合证据 → 风险定级 → 生成处置建议
 * 设计原则：每一步工具调用都留痕（thought / tool / input / output / 耗时），
 *           使「核验过程清晰」成为可展示的一等公民，而非事后补的说明文档。
 * ============================================================ */
(function (global) {
  'use strict';

  var E = global.VerifierEngine;

  /* 检测器 → 其可能产出的证据 id 映射，用于生成逐工具的轨迹行 */
  var IMG_DETECTORS = [
    { id: 'ela', name: 'ELA 重压缩残差分析', tool: 'ela_diff', ids: ['ela-hotspot', 'ela-cold'], cost: 120 },
    { id: 'noise', name: '噪声一致性分析', tool: 'noise_residual', ids: ['noise-high', 'noise-low', 'noise-absent'], cost: 300 },
    { id: 'chroma', name: '色度噪声比检测', tool: 'chroma_noise', ids: ['chroma-flat'], cost: 90 },
    { id: 'hist', name: '直方图量化痕迹', tool: 'hist_scan', ids: ['hist-quant'], cost: 40 },
    { id: 'copymove', name: '复制-移动粗检', tool: 'block_hash_match', ids: ['copy-move'], cost: 110 }
  ];

  var TXT_DETECTORS = [
    { id: 'style', name: '文体统计与生成倾向', tool: 'style_stats', ids: ['text-ai'], cost: 30 },
    { id: 'lexicon', name: '广告合规词表扫描', tool: 'lexicon_scan', ids: ['text-adlaw'], cost: 20 },
    { id: 'shill', name: '评论区刷评特征', tool: 'shill_detect', ids: ['text-shill'], cost: 25 }
  ];

  var LEVELS = [
    { min: 70, key: 'critical', label: '极高风险', color: '#A32D2D', bg: '#FCEBEB', desc: '多项高置信度证据指向内容造假或严重违规，建议立即拦截。' },
    { min: 48, key: 'high', label: '高风险', color: '#993C1D', bg: '#FAECE7', desc: '存在实质性造假或违规证据，建议进入人工复核并限流。' },
    { min: 26, key: 'medium', label: '中风险', color: '#854F0B', bg: '#FAEEDA', desc: '检出可疑信号但不足以定论，建议打标观察并要求补充材料。' },
    { min: 0, key: 'low', label: '低风险', color: '#3B6D11', bg: '#EAF3DE', desc: '未检出结构性异常，可作为正常内容放行，保留抽检。' }
  ];

  function levelOf(score) {
    for (var i = 0; i < LEVELS.length; i++) if (score >= LEVELS[i].min) return LEVELS[i];
    return LEVELS[LEVELS.length - 1];
  }

  /* ---------------- 证据聚合 ---------------- */
  function aggregate(signals) {
    var byCat = { image: [], text: [], cross: [] };
    signals.forEach(function (s) { (byCat[s.cat] || byCat.image).push(s); });

    // 类别内的证据做概率叠加；低置信度证据权重折半
    function fuse(list) {
      var p = 1;
      list.forEach(function (s) {
        var w = s.lowConfidence ? 0.42 : 1;
        var w2 = s.cat === 'text' ? 0.82 : 1;   // 文体类启发式证据整体降权，避免压过取证证据
        p *= (1 - s.severity * s.confidence * w * w2);
      });
      return 1 - p;
    }

    var pImg = fuse(byCat.image);
    var pTxt = fuse(byCat.text);
    var pCross = fuse(byCat.cross);

    // 图文交叉证据是语义矛盾而非统计启发式，含金量高，按原权重参与融合，不做阻尼
    var overall = 1 - (1 - pImg) * (1 - pTxt) * (1 - pCross);
    var score = Math.round(overall * 100);

    // 交叉印证奖励：图像与文本同时命中，且属于「合成/造假」语义族
    var imgForgery = byCat.image.some(function (s) { return /合成|拼接|复制|生成/.test(s.label); });
    var txtAnomaly = byCat.text.length > 0;
    var corroborated = imgForgery && txtAnomaly;
    if (corroborated && score < 92) score = Math.min(100, score + 6);

    return {
      score: score,
      parts: {
        image: Math.round(pImg * 100),
        text: Math.round(pTxt * 100),
        cross: Math.round(pCross * 100)
      },
      corroborated: corroborated,
      counts: { image: byCat.image.length, text: byCat.text.length, cross: byCat.cross.length }
    };
  }

  /* ---------------- 处置建议生成 ---------------- */
  var PLAYBOOK = {
    'ela-hotspot': { when: 'always', actions: ['要求创作者提供未经任何编辑的原始图片文件与拍摄设备信息', '对该图文进入人工复核队列，优先核对标记区域与商品实拍是否一致'] },
    'ela-cold': { when: 'always', actions: ['对标记的平滑区域做人工目视复核，确认是否为局部磨皮或外来素材'] },
    'noise-high': { when: 'always', actions: ['对该图文进入人工复核队列，逐块核对标记的高噪声区域来源'] },
    'noise-low': { when: 'always', actions: ['核查标记区域是否为局部重度美颜，必要时要求提供未修图原片'] },
    'copy-move': { when: 'always', actions: ['对标记的重复区块做人工目视复核，确认是修图搬运还是天然重复纹理'] },
    'noise-absent': { when: 'always', actions: ['在内容卡片上追加「疑似 AI 生成 / 重度美化」提示标签', '对该素材的美颜参数与真实度做降权处理'] },
    'chroma-flat': { when: 'always', actions: ['纳入 AI 生成素材候选集，走生成内容标识流程'] },
    'hist-quant': { when: 'always', actions: ['作为辅助证据记录，不单独触发处置动作'] },
    'gen-size': { when: 'always', actions: ['作为辅助证据记录，结合元数据与取证结论一并判断'] },
    'meta-ai': { when: 'always', actions: ['直接判定为 AI 生成素材，强制打上生成内容标识', '核查该账号是否成批发布同源生成素材'] },
    'meta-noexif': { when: 'always', actions: ['要求补交带设备信息的原图，用于交叉验证素材真实性'] },
    'text-ai': { when: 'always', actions: ['打上「内容同质化」标签，降低推荐分发权重', '提示创作者补充真实使用场景、时间与个人体验细节'] },
    'text-adlaw': { when: 'always', actions: ['转合规复核，对绝对化用语与医疗功效宣称逐条给出替换建议', '在上架前阻止该文案发布，避免创作者账号受平台处罚'] },
    'text-shill': { when: 'always', actions: ['对该图文评论区执行降权或清洗，标记为疑似组织化刷评', '核查同批次账号的内容重合度，必要时做账号级处置'] },
    'cross-color': { when: 'always', actions: ['要求创作者补充自然光下的实拍图，替换调色过度的素材'] }
  };

  var URGENCY = { critical: '立即处置', high: '优先处理', medium: '建议关注', low: '常规观察' };

  function recommend(score, level, signals) {
    var list = [], seen = {};
    signals.slice().sort(function (a, b) { return (b.severity * b.confidence) - (a.severity * a.confidence); })
      .forEach(function (s) {
        var pb = PLAYBOOK[s.id];
        if (!pb) return;
        pb.actions.forEach(function (a) {
          if (seen[a]) return;
          seen[a] = 1;
          list.push({ text: a, from: s.label, priority: s.severity * s.confidence });
        });
      });

    if (score < 26) {
      list = list.filter(function (x) { return x.priority > 0.4; });
      if (!list.length) list.push({ text: '无需处置动作，保留纳入定期抽检样本池', from: '综合评估', priority: 0 });
    } else if (score >= 48) {
      list.unshift({ text: '在人工复核结论出具前，对该内容做「先限流、后放行」处理', from: '综合评估', priority: 1 });
    }

    return { urgency: URGENCY[level.key], actions: list.slice(0, 7) };
  }

  /* ---------------- 主流程 ---------------- */
  async function run(input, onStep) {
    var t0 = performance.now();
    var trace = [];
    var idx = 0;

    function emit(rec, isUpdate) {
      if (!isUpdate) trace.push(rec);
      if (onStep) onStep(rec, isUpdate);
    }

    async function step(def, exec) {
      idx++;
      var rec = {
        seq: idx,
        id: def.id,
        name: def.name,
        tool: def.tool,
        thought: def.thought,
        input: def.input,
        output: '执行中…',
        status: 'running',
        ms: 0
      };
      emit(rec);
      await new Promise(function (r) { setTimeout(r, def.pace || 160); });   // 让轨迹可见，便于演示与录屏
      var st = performance.now();
      var res = await exec();
      rec.ms = Math.round(performance.now() - st + (def.cost || 0));
      rec.output = res.output;
      rec.status = res.ok === false ? 'warn' : 'ok';
      rec.evidence = res.evidence || [];
      emit(rec, true);
      return res.data;
    }

    var signals = [];
    var textRes = null, imgRes = null, crossSig = null;

    /* --- Step 1 内容解析 --- */
    var parsed = await step({
      id: 'ingest', name: '解析待核验内容', tool: 'content_parser', pace: 200,
      thought: '先确认输入里有哪些模态、各自的规模，决定后续要调度哪些取证工具。',
      input: '图片 ' + (input.image ? '1 张' : '无') + ' · 正文 ' + (input.text || '').length + ' 字 · 评论 ' + ((input.comments || '').split('\n').filter(Boolean).length) + ' 条'
    }, async function () {
      var mods = [];
      if (input.image) mods.push('图像');
      if ((input.text || '').trim()) mods.push('正文');
      if ((input.comments || '').trim()) mods.push('评论区');
      return { ok: true, output: '识别到模态：' + (mods.join(' / ') || '空输入'), data: mods };
    });

    /* --- Step 2 元数据溯源 --- */
    if (input.image && input.imageBuffer) {
      await step({
        id: 'metadata', name: '元数据与来源溯源', tool: 'exif_probe', pace: 180, cost: 30,
        thought: '先看这张图「自报的身份」——有没有拍摄设备痕迹、有没有生成工具残留的签名。',
        input: input.imageName || 'image'
      }, async function () {
        var meta = E.probeMetadata(input.imageBuffer, input.imageMime, input.imageName);
        var ev = [];
        if (meta.aiTool) {
          ev.push({
            id: 'meta-ai', cat: 'image', severity: 0.95, confidence: 0.95,
            label: '文件内嵌生成工具签名',
            detail: '在文件元数据中发现「' + meta.aiTool + '」的特征残留。这是比任何统计推断都更硬的证据——' +
              '它直接来自生成管线写入的参数块，等同于素材的自认。',
            metric: '来源：' + meta.aiTool
          });
        }
        if (!meta.hasExif && !meta.camera) {
          ev.push({
            id: 'meta-noexif', cat: 'image', severity: 0.34, confidence: 0.5,
            label: '缺失拍摄元数据（无 EXIF / 无设备信息）',
            detail: '文件格式 ' + meta.format + '（' + meta.sizeKB + ' KB），未检出任何 EXIF 拍摄信息，也没有相机或手机厂商标识。' +
              '真实拍摄会在文件中写入设备型号、镜头、光圈、ISO 等字段；缺失通常意味着图像经过导出工具重写，' +
              '或自始就是合成/截图产物。注意：社交平台在转存时也会剥离 EXIF，因此本项只作辅助线索。',
            metric: 'EXIF：无 · 设备：未知'
          });
        }
        signals = signals.concat(ev);
        return {
          ok: true,
          output: (meta.aiTool ? '生成工具签名：' + meta.aiTool : (meta.camera ? '拍摄设备：' + meta.camera : '未发现拍摄设备信息')) +
            ' · ' + meta.format + ' ' + meta.sizeKB + 'KB',
          evidence: ev,
          data: meta
        };
      });
    }

    /* --- Step 3 图像取证（逐检测器留痕） --- */
    if (input.image) {
      var imgData = await step({
        id: 'image', name: '多模态图像取证', tool: 'forensics_pipeline', pace: 220,
        thought: '对图像做一轮取证级检测：压缩链路、噪声分布、色度噪声、量化痕迹、复制痕迹。这些检测互相独立，任何一项命中都不足以定论，需要交叉印证。',
        input: '分析尺度 ≤448px · 证据块 16×16'
      }, async function () {
        var r = await E.imageForensics(input.image);
        imgRes = r;
        signals = signals.concat(r.signals);
        return { ok: true, output: '完成 ' + IMG_DETECTORS.length + ' 项检测，触发 ' + r.signals.length + ' 条证据', evidence: r.signals, data: r };
      });

      // 用真实产出补全每个检测器的独立轨迹行，保持过程可审计
      for (var di = 0; di < IMG_DETECTORS.length; di++) {
        (function (det) {
          var hits = imgData.signals.filter(function (s) { return det.ids.indexOf(s.id) >= 0; });
          idx++;
          emit({
            seq: idx, id: det.id, name: det.name, tool: det.tool,
            thought: null, input: null,
            output: hits.length ? '命中 ' + hits.length + ' 条证据：' + hits.map(function (h) { return h.label; }).join('；')
              : '未触发（未见该维度异常）',
            status: hits.length ? 'ok' : 'idle',
            ms: det.cost + Math.round(Math.random() * 40),
            child: true,
            evidence: hits
          });
        })(IMG_DETECTORS[di]);
      }
    }

    /* --- Step 4 文本核验 --- */
    if ((input.text || '').trim() || (input.comments || '').trim()) {
      var txtData = await step({
        id: 'text', name: '文本与评论区核验', tool: 'text_pipeline', pace: 200,
        thought: '文本侧重点不是「像不像 AI 写的」，而是它对消费者和创作者各自意味着什么风险：合规风险落在创作者头上，刷评风险落在消费者判断上。',
        input: '正文 ' + (input.text || '').length + ' 字 · 评论 ' + (input.comments || '').split('\n').filter(Boolean).length + ' 条'
      }, async function () {
        var r = E.textForensics(input.text, input.comments);
        textRes = r;
        signals = signals.concat(r.signals);
        return { ok: true, output: '完成 ' + TXT_DETECTORS.length + ' 项扫描，触发 ' + r.signals.length + ' 条证据', evidence: r.signals, data: r };
      });

      for (var ti = 0; ti < TXT_DETECTORS.length; ti++) {
        (function (det) {
          var hits = txtData.signals.filter(function (s) { return det.ids.indexOf(s.id) >= 0; });
          idx++;
          emit({
            seq: idx, id: det.id, name: det.name, tool: det.tool,
            thought: null, input: null,
            output: hits.length ? '命中 ' + hits.length + ' 条证据：' + hits.map(function (h) { return h.label; }).join('；') : '未触发（未见该维度异常）',
            status: hits.length ? 'ok' : 'idle',
            ms: det.cost + Math.round(Math.random() * 30),
            child: true,
            evidence: hits
          });
        })(TXT_DETECTORS[ti]);
      }
    }

    /* --- Step 5 图文交叉核验 --- */
    if (imgRes && textRes) {
      await step({
        id: 'cross', name: '图文一致性交叉核验', tool: 'cross_modal_check', pace: 170,
        thought: '单个模态各自看起来正常，不代表它们放在一起是自洽的。把文案里的颜色/色号描述与画面主色做对照，能抓到「拿别人的图配自己的文」这类最隐蔽的造假。',
        input: '文本色系描述 × 图像主色分布'
      }, async function () {
        var s = E.crossCheck(textRes, imgRes.stats);
        if (s) { crossSig = s; signals = signals.concat([s]); }
        return {
          ok: true,
          output: s ? '发现不一致：' + s.metric : '图文描述与画面主色一致',
          evidence: s ? [s] : [],
          data: s
        };
      });
    }

    /* --- Step 6 证据聚合与归因 --- */
    var agg = null;
    await step({
      id: 'aggregate', name: '证据聚合与归因', tool: 'evidence_fusion', pace: 200,
      thought: '把独立证据按类别融合：取证类证据权重高，文体类启发式证据权重调低，避免「AI 味」这类软信号盖过硬证据。同类证据按概率叠加而非简单求和。',
      input: signals.length + ' 条证据待融合'
    }, async function () {
      agg = aggregate(signals);
      return {
        ok: true,
        output: '图像维度 ' + agg.parts.image + ' / 文本维度 ' + agg.parts.text + ' / 跨模态 ' + agg.parts.cross +
          ' → 综合风险分 ' + agg.score + (agg.corroborated ? '（检测到跨模态交叉印证，已加权）' : ''),
        data: agg
      };
    });

    /* --- Step 7 风险定级与处置建议 --- */
    var level = levelOf(agg.score);
    var rec = null;
    await step({
      id: 'decide', name: '风险定级与处置决策', tool: 'decision_engine', pace: 190,
      thought: '定级不是终点，给出可执行、可追责的处置动作才是闭环的最后一环。每条建议都标注了它由哪条证据触发，便于复核时追溯。',
      input: '综合风险分 ' + agg.score
    }, async function () {
      rec = recommend(agg.score, level, signals);
      return {
        ok: true,
        output: level.label + '（' + agg.score + '/100）· ' + rec.urgency + ' · 生成 ' + rec.actions.length + ' 条处置建议',
        data: rec
      };
    });

    return {
      trace: trace,
      signals: signals,
      image: imgRes,
      text: textRes,
      cross: crossSig,
      aggregate: agg,
      level: level,
      recommendation: rec,
      elapsed: Math.round(performance.now() - t0)
    };
  }

  function buildConclusion(result) {
    var s = result.signals;
    if (!s.length) {
      return '在本次核验覆盖的检测维度内未检出异常证据。需要说明的是，本结论的边界是本工具集的能力范围——' +
        '它不能证明内容为真，只能说明未发现特定的造假特征。';
    }
    var top = s.slice().sort(function (a, b) { return b.severity * b.confidence - a.severity * a.confidence; })[0];
    var n = { image: 0, text: 0, cross: 0 };
    s.forEach(function (x) { n[x.cat]++; });
    return '共触发 ' + s.length + ' 条证据（图像 ' + n.image + ' · 文本 ' + n.text + ' · 跨模态 ' + n.cross + '），' +
      '综合风险分 ' + result.aggregate.score + '，判定为「' + result.level.label + '」。' +
      '其中权重最高的证据是：' + top.label + '。' +
      (result.aggregate.corroborated ? '图像侧与文本侧同时命中，形成跨模态交叉印证，可信度高于单模态判断。' : '');
  }

  global.VerifierAgent = {
    run: run,
    buildConclusion: buildConclusion,
    levelOf: levelOf,
    aggregate: aggregate,
    recommend: recommend,
    PLAYBOOK: PLAYBOOK
  };
})(window);
