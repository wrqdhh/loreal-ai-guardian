'use strict';
/**
 * to_markdown.js — 把项目里的文本文件逐个转成「同名 + .md」
 *
 * 采用与 image_tamper_detector-main-md/（09-20 那批）一致的规则：
 *   - 每个源文件 → <原文件名>.md
 *   - 标题 + 元信息行（源文件 / 语言 / 字节 / 行数）
 *   - 正文放进自适应长度的围栏代码块（围栏长度 = 正文中最长连续反引号 + 1，至少 3）
 *   - 已是 .md 的文件不转换，原样复制到镜像目录并在索引中单列
 *   - 二进制文件（图片等）跳过
 *   - 镜像目录根部生成 INDEX.md 列出全部条目
 *
 * 产出位置：默认写到源码目录内的 `md/`（即 `agent/md/`），这样 md 与源码同属一个 git 仓库，
 * 推到 GitHub 后可直接在线阅读。可用 --out 指定其他位置（如 --out ../agent-md 放回仓库外）。
 *
 * 注意：镜像目录位于 ROOT 内部，扫描源码时必须跳过它，否则会出现 md/md/… 自我嵌套。
 *
 * 用法：
 *   node tools/to_markdown.js
 *   node tools/to_markdown.js --out ../somewhere
 *
 * 零第三方依赖。
 */

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var MD_ROOT = path.resolve(ROOT, 'md');

// 二进制/无需转换的扩展名
var SKIP_EXT = { '.png': 1, '.jpg': 1, '.jpeg': 1, '.gif': 1, '.ico': 1, '.zip': 1, '.gz': 1 };
var SKIP_DIR = { '.git': 1, 'node_modules': 1, '.vscode': 1 };

var LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.json': 'json',
  '.html': 'html', '.htm': 'html', '.css': 'css',
  '.py': 'python', '.sh': 'bash', '.yml': 'yaml', '.yaml': 'yaml',
  '.txt': 'text', '.md': 'markdown'
};

function langOf(file) {
  var ext = path.extname(file).toLowerCase();
  // 点号开头的文件（如 .gitignore）在 Node 里 extname 为空串，需按 basename 判断
  var base = path.basename(file).toLowerCase();
  if (base === '.gitignore') return 'gitignore';
  if (base === '.gitattributes') return 'gitattributes';
  return LANG[ext] || 'text';
}

/** 正文里最长的连续反引号，决定围栏长度 */
function fenceFor(text) {
  var max = 0, cur = 0;
  for (var i = 0; i < text.length; i++) {
    if (text[i] === '`') { cur++; if (cur > max) max = cur; } else cur = 0;
  }
  var n = Math.max(3, max + 1);
  return new Array(n + 1).join('`');
}

/** 建目录并写文件 */
function put(dir, file, buf) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buf);
}

function walk(dir, out, skipAbs) {
  var items = fs.readdirSync(dir);
  items.sort();
  items.forEach(function (name) {
    if (SKIP_DIR[name]) return;
    var p = path.join(dir, name);
    // 镜像目录在 ROOT 内部时跳过，避免 md/md/… 自我嵌套
    if (skipAbs && p === skipAbs) return;
    var st = fs.statSync(p);
    if (st.isDirectory()) { walk(p, out, skipAbs); return; }
    out.push(p);
  });
  return out;
}

function main() {
  var argv = process.argv.slice(2);
  var oi = argv.indexOf('--out');
  if (oi >= 0 && argv[oi + 1]) MD_ROOT = path.resolve(ROOT, argv[oi + 1]);

  var files = walk(ROOT, [], MD_ROOT);
  var entries = [];

  files.forEach(function (p) {
    var rel = path.relative(ROOT, p).replace(/\\/g, '/');
    var base = path.basename(p);
    var ext = path.extname(p).toLowerCase();

    if (SKIP_EXT[ext]) { entries.push({ rel: rel, kind: 'skipped', note: '二进制文件' }); return; }

    var buf = fs.readFileSync(p);
    var text = buf.toString('utf8');
    var isMd = ext === '.md';
    var lang = langOf(p);
    var lines = text.split('\n').length;

    if (isMd) {
      // 已是 markdown：原样复制到镜像目录，不转换
      var cp = path.join(MD_ROOT, rel);
      put(path.dirname(cp), cp, buf);
      entries.push({ rel: rel, out: rel, kind: 'asis', lang: lang, bytes: buf.length, lines: lines });
      return;
    }

    var md = '# `' + base + '`\n\n' +
      '> 源文件 `' + rel + '` · 语言 `' + lang + '` · ' + buf.length + ' 字节 · ' + lines + ' 行\n\n' +
      fenceFor(text) + lang + '\n' + text + '\n' + fenceFor(text) + '\n';

    var op = path.join(MD_ROOT, rel + '.md');
    put(path.dirname(op), op, Buffer.from(md, 'utf8'));
    entries.push({ rel: rel, out: rel + '.md', kind: 'converted', lang: lang, bytes: buf.length, lines: lines });
  });

  // 仅存在于镜像目录的 .md（如手写文档 docs/*.md 已全部搬到镜像目录），源目录无同名文件
  var known = {};
  entries.forEach(function (e) { if (e.out) known[e.out] = 1; });
  walk(MD_ROOT, []).forEach(function (p) {
    var rel = path.relative(MD_ROOT, p).replace(/\\/g, '/');
    if (path.extname(p).toLowerCase() !== '.md' || rel === 'INDEX.md' || known[rel]) return;
    var buf = fs.readFileSync(p);
    entries.push({
      rel: rel, out: rel, kind: 'mirroronly', lang: 'markdown',
      bytes: buf.length, lines: buf.toString('utf8').split('\n').length
    });
  });

  // 生成索引
  var converted = entries.filter(function (e) { return e.kind === 'converted'; });
  var asis = entries.filter(function (e) { return e.kind === 'asis'; });
  var mirrorOnly = entries.filter(function (e) { return e.kind === 'mirroronly'; });
  var skipped = entries.filter(function (e) { return e.kind === 'skipped'; });

  var L = [];
  L.push('# ' + path.basename(ROOT) + ' → Markdown 转换结果');
  L.push('');
  L.push('源目录：`' + path.basename(ROOT) + '/`　本目录：`' + path.basename(MD_ROOT) + '/`（目录结构一一对应）');
  L.push('');
  L.push('每个文本文件产出「同名 + `.md`」，源码放进围栏代码块；');
  L.push('已是 markdown 的文件原样复制；二进制文件（PNG 图片）不转换。');
  L.push('');
  L.push('生成方式：`node tools/to_markdown.js`（可重复执行，结果覆盖）');
  L.push('');
  L.push('统计：转换 ' + converted.length + ' 个 · 原样复制 ' + (asis.length + mirrorOnly.length) +
    ' 个 · 跳过 ' + skipped.length + ' 个');
  L.push('');
  L.push('| # | 源文件 | 转换后 | 语言 | 大小 | 行数 |');
  L.push('|---:|---|---|---|---:|---:|');
  converted.forEach(function (e, i) {
    L.push('| ' + (i + 1) + ' | `' + e.rel + '` | [`' + e.out + '`](' + e.out + ') | ' + e.lang +
      ' | ' + e.bytes + ' B | ' + e.lines + ' |');
  });
  L.push('');
  L.push('## 原样复制（已是 markdown）');
  L.push('');
  L.push('| 文件 | 大小 | 行数 |');
  L.push('|---|---:|---:|');
  asis.concat(mirrorOnly).forEach(function (e) {
    L.push('| [`' + e.rel + '`](' + e.rel + ') | ' + e.bytes + ' B | ' + e.lines + ' |');
  });
  if (skipped.length) {
    L.push('');
    L.push('## 跳过（二进制）');
    L.push('');
    L.push('共 ' + skipped.length + ' 个图片文件，未转换。');
  }
  put(MD_ROOT, path.join(MD_ROOT, 'INDEX.md'), Buffer.from(L.join('\n') + '\n', 'utf8'));

  console.log('转换 ' + converted.length + ' 个 · 原样复制 ' + (asis.length + mirrorOnly.length) +
    ' 个 · 跳过 ' + skipped.length + ' 个');
  console.log('镜像目录 → ' + MD_ROOT);
}

main();
