import { allRules, formats, VERSION } from './lib/index.js';

const $ = (id) => document.getElementById(id);
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const rules = new Map(allRules().map((r) => [r.code, r]));

// ------------------------------------------------------------------ interface language (diagnostics stay in English)
const I18N = {
  en: {
    title: 'Find out exactly what is wrong with a bioinformatics file',
    lede: 'Line, column, a plain explanation, the specification section, and how to fix it.',
    privacy: 'The file is read by this page and never leaves your computer.',
    drop: 'Drop a file here, or click to choose one',
    gz: '.gz and .bgz files are decompressed in the browser',
    format: 'Format', detect: 'detect automatically', strict: 'Strict: follow the specification to the letter',
    example: 'Try an example', pick: 'choose…', paste: '…or paste text', checkBtn: 'Check', copy: 'Copy report',
    footer: 'biolint is free software (GPL-3.0). It also runs on the command line and in CI:',
    supports: 'Supported: ', reading: 'Checking', done: 'checked in', lines: 'lines',
    noProblems: 'No problems found', errors: (n) => `${n} error${n === 1 ? '' : 's'}`, warnings: (n) => `${n} warning${n === 1 ? '' : 's'}`, notes: (n) => `${n} note${n === 1 ? '' : 's'}`,
    chip: { error: 'Errors', warning: 'Warnings', info: 'Notes' },
    help: 'Help', note: 'Note', spec: 'Specification', why: 'Why this matters', fixable: 'Can be repaired automatically',
    hidden: (n) => `${n} more occurrence${n === 1 ? '' : 's'} of the same rules are counted but not listed.`,
    fix: (n) => `Download repaired file (${n} fix${n === 1 ? '' : 'es'})`, copied: 'Copied', wholeFile: 'whole file',
    detectedBy: { option: 'format chosen by you', extension: 'format from the file name', content: 'format detected from the content', none: 'format not recognised' },
    failed: 'Something went wrong: ',
  },
  zh: {
    title: '精确指出生物信息学文件哪里出了错',
    lede: '给出行号、列号、通俗的解释、规范出处，以及怎么改。',
    privacy: '文件只在本页面内读取，不会离开你的电脑。',
    drop: '把文件拖到这里，或点击选择',
    gz: '.gz 和 .bgz 文件会在浏览器里直接解压',
    format: '格式', detect: '自动识别', strict: '严格模式：完全按规范条文检查',
    example: '试一个例子', pick: '选择…', paste: '…或者粘贴文本', checkBtn: '检查', copy: '复制报告',
    footer: 'biolint 是自由软件（GPL-3.0），也可以在命令行和 CI 里使用：',
    supports: '支持：', reading: '正在检查', done: '用时', lines: '行',
    noProblems: '没有发现问题', errors: (n) => `${n} 个错误`, warnings: (n) => `${n} 个警告`, notes: (n) => `${n} 条提示`,
    chip: { error: '错误', warning: '警告', info: '提示' },
    help: '建议', note: '说明', spec: '规范', why: '为什么要紧', fixable: '可以自动修复',
    hidden: (n) => `同类问题还有 ${n} 处，已计数但没有逐条列出。`,
    fix: (n) => `下载修复后的文件（${n} 处）`, copied: '已复制', wholeFile: '整个文件',
    detectedBy: { option: '格式由你指定', extension: '按文件名判断格式', content: '按内容识别格式', none: '无法识别格式' },
    failed: '出错了：',
  },
};
let lang = (() => { try { return localStorage.getItem('biolint-lang'); } catch { return null; } })() || (navigator.language.startsWith('zh') ? 'zh' : 'en');
const t = () => I18N[lang];

function applyLanguage() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t()[el.dataset.i18n];
  $('lang').textContent = lang === 'zh' ? 'English' : '中文';
  $('formats').textContent = t().supports + formats.map((f) => f.name).join(', ');
  if (last) render(last.result, last.fixed);
}

// ------------------------------------------------------------------ helpers
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rich = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const num = (n) => n.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US');

function frameHtml(d) {
  const ex = d.excerpt;
  if (!ex) return '';
  let html = `<span class="no">${d.line}</span>`;
  if (ex.clippedStart) html += '<span class="tab">…</span>';
  let i = 1, open = false, any = false;
  for (const ch of ex.text) {
    if (i === ex.column && ex.endColumn > ex.column) { html += '<mark>'; open = true; any = true; }
    if (i === ex.endColumn && open) { html += '</mark>'; open = false; }
    const cp = ch.codePointAt(0);
    if (cp === 9) html += '<span class="tab">→</span>';
    else if (cp < 0x20 || cp === 0x7f || cp === 0xa0 || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff) html += `<span class="tab" title="U+${cp.toString(16).toUpperCase().padStart(4, '0')}">␣</span>`;
    else html += esc(ch);
    i++;
  }
  if (open) html += '</mark>';
  if (!any) html += '<span class="caret">▲</span>';
  if (ex.clippedEnd) html += '<span class="tab">…</span>';
  return `<pre class="frame">${html}</pre>`;
}

// ------------------------------------------------------------------ running
let nextId = 0;
let last = null;
let current = null;
const shown = { error: true, warning: true, info: true };

function run(payload) {
  const id = ++nextId;
  current = payload;
  $('results').hidden = true;
  $('status').hidden = false;
  $('progress').value = 0;
  $('statusText').textContent = `${t().reading} ${payload.file ? payload.file.name : ''}…`;
  const options = { profile: $('strict').checked ? 'strict' : 'default' };
  if ($('type').value) options.format = $('type').value;
  if (!payload.file) options.filename = payload.filename || 'pasted';
  if (payload.formatOptions) options.formatOptions = payload.formatOptions;
  const small = payload.file ? payload.file.size <= 64 * 1024 * 1024 && !/\.(gz|bgz|bgzf)$/i.test(payload.file.name) : true;
  worker.postMessage({ id, file: payload.file, text: payload.text, options, wantFix: small });
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.id !== id) return;
    if (m.progress !== undefined) { $('progress').value = m.progress; return; }
    $('status').hidden = true;
    if (m.error) { $('status').hidden = false; $('statusText').textContent = t().failed + m.error; return; }
    last = { result: m.result, fixed: m.fixed };
    render(m.result, m.fixed);
  };
}

function render(r, fixed) {
  const s = t();
  const { error, warning, info } = r.counts;
  const cls = error ? 'bad' : warning ? 'meh' : 'ok';
  const parts = [];
  if (error) parts.push(s.errors(error));
  if (warning) parts.push(s.warnings(warning));
  if (info) parts.push(s.notes(info));
  const facts = [r.stats.version || r.format.toUpperCase(), `${num(r.lines)} ${s.lines}`];
  for (const k of ['records', 'sequences', 'reads', 'features', 'samples']) if (typeof r.stats[k] === 'number') facts.push(`${num(r.stats[k])} ${k}`);
  facts.push(s.detectedBy[r.formatSource]);
  if (r.ms !== undefined) facts.push(`${s.done} ${r.ms < 1000 ? Math.round(r.ms) + ' ms' : (r.ms / 1000).toFixed(1) + ' s'}`);
  $('summary').innerHTML = `<div class="verdict ${cls}">${error ? '✖' : warning ? '⚠' : '✔'} ${esc(r.filename)}: ${parts.length ? parts.join(', ') : s.noProblems}</div><div class="facts">${facts.map((f) => esc(String(f))).join(' · ')}</div>`;

  for (const chip of document.querySelectorAll('.chip')) {
    const sev = chip.dataset.sev;
    chip.textContent = `${s.chip[sev]} ${num(r.counts[sev])}`;
    chip.hidden = r.counts[sev] === 0;
    chip.classList.toggle('on', shown[sev]);
  }
  const list = $('list');
  list.innerHTML = '';
  for (const d of r.diagnostics) {
    if (!shown[d.severity]) continue;
    const li = document.createElement('li');
    li.className = `diag ${d.severity}`;
    const where = d.line > 0 ? `${d.line}:${d.column || 1}` : s.wholeFile;
    let html = `<div class="head"><button class="badge" type="button" title="${esc(d.name)}">${d.code}</button><span class="msg">${rich(d.message)}</span><span class="loc">${where}</span></div>`;
    html += frameHtml(d);
    if (d.hint) html += `<p class="kv"><b>${s.help}:</b> ${rich(d.hint)}</p>`;
    for (const n of d.notes || []) html += `<p class="kv"><b>${s.note}:</b> ${rich(n)}</p>`;
    if (d.spec) html += `<div class="spec">${s.spec}: ${esc(d.spec)}</div>`;
    li.innerHTML = html;
    li.querySelector('.badge').addEventListener('click', () => toggleExplain(li, d.code));
    list.appendChild(li);
  }
  const hiddenCount = Object.values(r.byRule).reduce((n, x) => n + (x.count - x.shown), 0);
  $('hidden').textContent = hiddenCount > 0 ? s.hidden(num(hiddenCount)) : '';
  const fixBtn = $('fix');
  if (fixed && fixed.applied > 0) {
    fixBtn.hidden = false;
    fixBtn.textContent = s.fix(fixed.applied);
    fixBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([fixed.bytes]));
      a.download = r.filename.replace(/(\.[^.]+)?$/, '.fixed$1');
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
  } else fixBtn.hidden = true;
  $('results').hidden = false;
}

function toggleExplain(li, code) {
  const old = li.querySelector('.explain');
  if (old) { old.remove(); return; }
  const r = rules.get(code);
  if (!r) return;
  const div = document.createElement('div');
  div.className = 'explain';
  div.innerHTML = `<h4>${code} · ${esc(r.name)} — ${esc(r.title)}</h4><p><b>${t().why}.</b> ${rich(r.explanation)}</p>${r.fixable ? `<p>${t().fixable}: <code>biolint --fix</code></p>` : ''}`;
  li.appendChild(div);
}

function report(r) {
  return r.diagnostics.map((d) => `${r.filename}:${d.line}:${d.column}: ${d.severity}[${d.code}] ${d.message}${d.hint ? `\n    help: ${d.hint}` : ''}`).join('\n');
}

// ------------------------------------------------------------------ wiring
$('version').textContent = 'v' + VERSION;
for (const f of formats) $('type').add(new Option(f.name, f.id));
const groups = new Map();
for (const r of allRules()) {
  const bad = r.examples && r.examples.bad && r.examples.bad[0];
  if (!bad) continue;
  const key = r.format === 'text' ? 'Any format' : (formats.find((f) => f.id === r.format) || { name: r.format }).name;
  if (!groups.has(key)) { const g = document.createElement('optgroup'); g.label = key; groups.set(key, g); $('examples').appendChild(g); }
  const o = new Option(`${r.code}  ${r.title}`, r.code);
  groups.get(key).appendChild(o);
}
$('examples').addEventListener('change', (e) => {
  const r = rules.get(e.target.value);
  if (!r) return;
  const ex = r.examples.bad[0];
  const fmt = r.format === 'text' ? ex.format || 'fasta' : r.format;
  $('text').value = ex.text;
  document.querySelector('.paste').open = true;
  $('strict').checked = ex.profile === 'strict' || r.level === 'off';
  $('type').value = formats.some((f) => f.id === fmt) ? fmt : '';
  run({ text: ex.text, filename: `example.${fmt}`, formatOptions: ex.options ? { [fmt]: ex.options } : undefined });
});
$('file').addEventListener('change', (e) => { if (e.target.files[0]) run({ file: e.target.files[0] }); });
$('check').addEventListener('click', () => { if ($('text').value) run({ text: $('text').value, filename: 'pasted' + ($('type').value ? '.' + $('type').value : '') }); });
for (const el of [$('strict'), $('type')]) el.addEventListener('change', () => { if (current) run(current); });
const drop = $('drop');
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
for (const ev of ['dragenter', 'dragover']) window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
window.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) run({ file: f }); });
for (const chip of document.querySelectorAll('.chip')) chip.addEventListener('click', () => { shown[chip.dataset.sev] = !shown[chip.dataset.sev]; if (last) render(last.result, last.fixed); });
$('copy').addEventListener('click', async () => {
  if (!last) return;
  try { await navigator.clipboard.writeText(report(last.result)); $('copy').textContent = t().copied; setTimeout(() => { $('copy').textContent = t().copy; }, 1200); } catch { /* clipboard unavailable */ }
});
$('lang').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; try { localStorage.setItem('biolint-lang', lang); } catch { /* private mode */ } applyLanguage(); });
applyLanguage();
