# `selftest.js`

> 源文件 `selftest.js` · 语言 `javascript` · 7517 字节 · 149 行

```javascript
/* ============================================================
 * selftest.js — 纯逻辑层自检（Node 环境，无需浏览器）
 * 覆盖：元数据探针 → 文本核验 → 图文交叉 → 证据融合 → 风险定级 → 处置建议
 * 图像取证依赖 Canvas，不在本脚本覆盖范围内（请在页面中可视化验证）。
 *
 * 运行： node selftest.js [输出报告路径]
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

global.window = global;
global.performance = global.performance || { now: () => Date.now() };
if (!global.document) global.document = { createElement: () => ({ getContext: () => null }) };

['engine.js', 'agent.js', 'samples.js'].forEach(function (f) {
  (0, eval)(fs.readFileSync(path.join(__dirname, f), 'utf8'));
});

const E = global.VerifierEngine;
const A = global.VerifierAgent;
const S = global.Samples.list;

const LINES = [];
function log(s) { LINES.push(s); console.log(s); }

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; log('  [PASS] ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; log('  [FAIL] ' + name + (extra ? '   ' + extra : '')); }
}

/* 用于交叉核验的假图像主色分布 */
const IMG_WARM = { dominant: [{ family: '橙', share: .40 }, { family: '棕', share: .28 }, { family: '白', share: .20 }] };
const IMG_COLD = { dominant: [{ family: '蓝', share: .50 }, { family: '白', share: .30 }, { family: '青', share: .08 }] };

const CASES = [
  { name: '样本 A · AI 合成素材', idx: 0, img: IMG_WARM, expect: 'critical' },
  { name: '样本 B · 拼接篡改', idx: 1, img: IMG_WARM, expect: 'medium' },
  { name: '样本 C · 正常内容', idx: 2, img: IMG_COLD, expect: 'low' }
];

log('');
log('=========== 内容核验 Agent · 逻辑层自检 ===========');
log('');

CASES.forEach(function (c) {
  const s = S[c.idx];
  log('【' + c.name + '】');
  const t = E.textForensics(s.text, s.comments);
  log('  文体统计：句长变异系数=' + t.stats.sentCV.toFixed(3) +
    '  生成倾向=' + t.stats.aiScore.toFixed(3) +
    '  连接词=' + t.stats.connectors +
    '  真实细节=' + t.stats.personal +
    '  等长三连=' + t.stats.triad);
  log('  违规标注：' + t.marks.length + ' 处（绝对化 ' + t.marks.filter(m => m.type === 'absolute').length +
    ' / 医疗功效 ' + t.marks.filter(m => m.type === 'medical').length +
    ' / 效果承诺 ' + t.marks.filter(m => m.type === 'promise').length + '）');

  let signals = t.signals.slice();
  const cross = E.crossCheck(t, c.img);
  if (cross) signals.push(cross);

  signals.forEach(function (x) {
    log('  · [' + x.cat + '] ' + x.label + '   严重度=' + x.severity.toFixed(2) +
      ' 置信度=' + x.confidence.toFixed(2) + '  (' + x.metric + ')');
  });
  if (!signals.length) log('  · 未触发任何证据');

  const agg = A.aggregate(signals);
  const lv = A.levelOf(agg.score);
  log('  → 图像 ' + agg.parts.image + ' / 文本 ' + agg.parts.text + ' / 跨模态 ' + agg.parts.cross +
    ' → 综合 ' + agg.score + ' → ' + lv.label);
  check('判定落在预期档位（' + c.expect + '）', lv.key === c.expect, '实际 ' + lv.key);

  if (signals.length) {
    const rec = A.recommend(agg.score, lv, signals);
    log('  处置建议 ' + rec.actions.length + ' 条，紧急度「' + rec.urgency + '」');
    rec.actions.slice(0, 3).forEach(function (a) { log('    - ' + a.text + '   ← ' + a.from); });
  }
  log('');
});

/* ---------------- 定向断言 ---------------- */
log('【定向断言 · 文本侧】');
const aiT = E.textForensics(S[0].text, S[0].comments);
check('AI 文案命中「机器批量生成特征」', aiT.signals.some(s => s.id === 'text-ai'));
check('AI 文案命中「广告法合规风险」', aiT.signals.some(s => s.id === 'text-adlaw'));
check('AI 文案命中「刷评特征」', aiT.signals.some(s => s.id === 'text-shill'));
check('AI 文案标注出绝对化用语', aiT.marks.some(m => m.type === 'absolute'));
check('AI 文案标注出医疗功效宣称', aiT.marks.some(m => m.type === 'medical'));
check('AI 文案标注出效果承诺', aiT.marks.some(m => m.type === 'promise'));

const clT = E.textForensics(S[2].text, S[2].comments);
check('正常文案未误报生成倾向', !clT.signals.some(s => s.id === 'text-ai'), '生成倾向=' + clT.stats.aiScore.toFixed(3));
check('正常文案未误报合规风险', !clT.signals.some(s => s.id === 'text-adlaw'));
check('正常文案未误报刷评', !clT.signals.some(s => s.id === 'text-shill'));

log('');
log('【定向断言 · 跨模态】');
const crossBad = E.crossCheck(E.textForensics(S[1].text, S[1].comments), IMG_WARM);
check('暖色图 + 冷调文案 → 命中图文不一致', !!crossBad, crossBad ? crossBad.metric : '未命中');
const crossOk = E.crossCheck(E.textForensics(S[1].text, S[1].comments), IMG_COLD);
check('冷调文案 + 冷色图 → 不误报不一致', !crossOk);

log('');
log('【定向断言 · 融合与健壮性】');
const base = E.textForensics('今天天气不错，出门散步了。', '');
const one = A.aggregate(base.signals).score;
const two = A.aggregate(base.signals.concat(aiT.signals)).score;
check('加入证据后风险分单调不降', two >= one, one + ' → ' + two);
check('AI 文案风险分高于正常文案',
  A.aggregate([].concat(E.textForensics(S[0].text, S[0].comments).signals)).score >
  A.aggregate([].concat(E.textForensics(S[2].text, S[2].comments).signals)).score);
check('空输入不崩溃且不产生证据', E.textForensics('', '').signals.length === 0);
check('空输入融合不产生风险', A.aggregate([]).score === 0);

log('');
log('【定向断言 · 元数据探针】');
function makePngWithText(keyword) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const data = Buffer.from(keyword, 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  return Buffer.concat([sig, len, Buffer.from('tEXt', 'latin1'), data, Buffer.alloc(4)]);
}
function ab(buf) { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length); }

const m1 = E.probeMetadata(ab(makePngWithText('parameters\u0000steps: 30, Sampler: DPM++ 2M, CFG scale: 7, Seed: 12345')), 'image/png', 'x.png');
check('PNG tEXt 生成管线参数残留被识别', !!m1.aiTool, '识别为：' + m1.aiTool);
const m2 = E.probeMetadata(ab(makePngWithText('Software\u0000Midjourney v6')), 'image/png', 'y.png');
check('Midjourney 签名被识别', m2.aiTool === 'Midjourney', '识别为：' + m2.aiTool);

const jpegExif = Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x20, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4D, 0x61, 0x6B, 0x65, 0x00, 0x41, 0x70, 0x70, 0x6C, 0x65]);
const m3 = E.probeMetadata(ab(jpegExif), 'image/jpeg', 'z.jpg');
check('JPEG EXIF 相机信息被识别', m3.hasExif && m3.camera === 'Apple', '设备=' + m3.camera);

const plainJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x43, 0x00]);
const m4 = E.probeMetadata(ab(plainJpeg), 'image/jpeg', 'q.jpg');
check('无 EXIF 的 JPEG 被判为缺失拍摄信息', !m4.hasExif && !m4.camera && !m4.aiTool);

log('');
log('==================================================');
log('结果：' + pass + ' 项通过，' + fail + ' 项失败');
log('==================================================');
log('');

if (process.argv[2]) fs.writeFileSync(process.argv[2], LINES.join('\n'), 'utf8');
process.exit(fail ? 1 : 0);

```
