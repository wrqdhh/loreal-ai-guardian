'use strict';
// 临时校验：mask 是否与 manifest 中记录的 region 一致
var fs = require('fs'), path = require('path');
var png = require('./png.js');
var ROOT = path.resolve(__dirname, '..');
var m = JSON.parse(fs.readFileSync(path.join(ROOT, 'dataset', 'manifest.json'), 'utf8'));
var bad = 0;
m.samples.filter(function (s) { return s.category === 'splice_ai_into_real'; }).forEach(function (s) {
  var mk = png.decodePNG(fs.readFileSync(path.join(ROOT, 'dataset', s.mask)));
  var cnt = 0, sx = 0, sy = 0;
  for (var y = 0; y < mk.height; y++) for (var x = 0; x < mk.width; x++) {
    if (mk.data[(y * mk.width + x) * 4] > 127) { cnt++; sx += x; sy += y; }
  }
  var r = s.region;
  var cx = sx / cnt, cy = sy / cnt, rcx = r.x + r.w / 2, rcy = r.y + r.h / 2;
  var areaRatio = cnt / (mk.width * mk.height);
  var rectRatio = (r.w * r.h) / (mk.width * mk.height);
  var expect = r.shape === 'ellipse' ? rectRatio * 0.785 : rectRatio;
  var ratioErr = Math.abs(areaRatio - expect) / expect;
  var cenErr = Math.hypot(cx - rcx, cy - rcy);
  var ok = ratioErr < 0.12 && cenErr < 8;
  if (!ok) bad++;
  console.log(s.id + ' shape=' + r.shape +
    ' 实测占比=' + areaRatio.toFixed(4) + ' 期望=' + expect.toFixed(4) +
    ' 相对误差=' + (ratioErr * 100).toFixed(1) + '%' +
    ' 质心偏移=' + cenErr.toFixed(1) + 'px  ' + (ok ? 'OK' : 'BAD'));
});
console.log(bad === 0 ? 'VERIFY=PASS' : 'VERIFY=FAIL(' + bad + ')');
