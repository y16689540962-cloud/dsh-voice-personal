#!/usr/bin/env node
/**
 * Manage your own glossary — no source editing, no DSH restart.
 *
 * ## Why a CLI instead of "edit the file"
 *
 * User terms live in `<dataDir>/terms.json`, outside the package, so they survive upgrades
 * and never touch the hard-linked install. You can absolutely edit that file by hand; this
 * tool exists to make the common operations safe:
 *
 *   - it validates before writing, so a conflict is refused with an explanation rather
 *     than silently rewriting your text later;
 *   - it writes atomically, so a dictation that happens to land mid-write still reads a
 *     complete file;
 *   - it tells you *what the plugin will actually do*, which is the thing you cannot see
 *     when staring at JSON.
 *
 * ## Commands
 *
 *   node scripts/terms.mjs path                      # where the file is
 *   node scripts/terms.mjs list                      # user terms + shipped terms
 *   node scripts/terms.mjs add FlClash --heard flcash
 *   node scripts/terms.mjs remove FlClash
 *   node scripts/terms.mjs check                     # validate without changing anything
 *   node scripts/terms.mjs export [file]             # dump to JSON (stdout if no file)
 *   node scripts/terms.mjs import <file>             # merge from JSON or CSV
 *   node scripts/terms.mjs candidates                # what `learn.mjs` proposed
 *   node scripts/terms.mjs apply DSH GitHub          # accept candidates (casing only)
 *
 * The plugin re-reads the file on the next dictation, so nothing here needs a restart.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeTerms, mergeTerms, checkTerms, TERMS as BUILTIN_TERMS,
} from '../lib/correct/index.js';
import {
  createUserTermsLoader, mergeWithUserTerms, USER_TERMS_FILE, emptyDocument,
} from '../lib/correct/user-terms.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DSH_VOICE_PERSONAL_DIR
  || (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'voice-personal') : '')
  || path.join(os.homedir(), '.dsh', 'voice-personal');

const loader = createUserTermsLoader({ dir: DATA_DIR });
const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
/** Flags that consume the next argument, so it must not be mistaken for a positional. */
const VALUE_FLAGS = new Set(['heard', 'note', 'out']);
const positional = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    if (VALUE_FLAGS.has(a.slice(2))) i++;
    continue;
  }
  positional.push(a);
}

/**
 * Colour, but only when a human is looking. Redirecting this to a file or piping it into
 * another tool should give clean text — escape codes in a log are noise at best and
 * corrupt a `grep` at worst. Honours the `NO_COLOR` convention.
 */
const COLOUR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (s) => (COLOUR ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const dim = paint(2);
const bold = paint(1);
const red = paint(31);
const yellow = paint(33);
const green = paint(32);

/** Read the current document, or an empty one. Never throws on a missing file. */
function readDoc() {
  if (!fs.existsSync(loader.path)) return emptyDocument();
  const raw = JSON.parse(fs.readFileSync(loader.path, 'utf8'));
  if (Array.isArray(raw)) return { ...emptyDocument(), terms: raw };
  return { ...emptyDocument(), ...raw, terms: raw.terms ?? [], pairs: raw.pairs ?? [] };
}

/**
 * Validate a document the way the plugin will actually see it — merged with the shipped
 * glossary, not in isolation. Checking the user's file alone would miss a user term that
 * collides with a shipped one, which is precisely the case that rewrites text.
 *
 * Prints nothing and returns the lines, so the caller decides the stream: a refusal is an
 * error report and belongs on stderr, where a script or a human looking at a failed command
 * will actually find it.
 */
function report(doc) {
  const user = mergeTerms(normalizeTerms(doc.terms));
  const merged = mergeWithUserTerms(BUILTIN_TERMS, user);
  const issues = checkTerms(merged.terms);
  const errors = issues.filter((i) => i.severity === 'error');

  const lines = [];
  for (const issue of issues) {
    lines.push(`  ${issue.severity === 'error' ? red('✗') : yellow('!')} ${issue.message}`);
  }
  for (const s of merged.shadowed) {
    lines.push(`  ${yellow('!')} 「${s.forms.join('、')}」原本指向随插件附带的「${s.say}」，`
      + `你的词条把它指向了别处；「${s.say}」的其它形态不受影响。`);
  }
  return { user, merged: merged.terms, issues, errors, ok: errors.length === 0, lines };
}

/** Validate, then write. The summary is printed **after** validation on purpose: a refusal
 *  preceded by "已添加…" reads as though it succeeded. */
function writeOrRefuse(doc, { force = false, summary = '' } = {}) {
  const { errors, issues, lines } = report(doc);
  const refusing = errors.length > 0 && !force;

  const stream = (line) => (refusing ? process.stderr : process.stdout).write(`${line}\n`);
  for (const line of lines) stream(line);

  if (refusing) {
    stream('');
    stream(`${red('拒绝写入')}：${errors.length} 条冲突。`);
    stream(dim('这些条目会改坏正确的文本，所以没有写进去。'));
    stream(dim('确认要强行写入，加 --force。'));
    process.exit(1);
  }

  if (summary) console.log(summary);
  loader.write({ version: 1, ...doc });
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  console.log(`\n${green('已写入')} ${loader.path}`);
  console.log(`  词条 ${doc.terms.length} 条${warnings ? `，警告 ${warnings} 条` : ''}`);
  console.log(dim('  下一次听写就会生效，不需要重启 DSH。'));
}

function parseHeard(value) {
  if (!value) return [];
  return value.split(/[,|]/).map((s) => s.trim()).filter(Boolean);
}

// ── commands ────────────────────────────────────────────────────────────────────────

function cmdPath() {
  console.log(loader.path);
  console.log(fs.existsSync(loader.path)
    ? dim(`存在，${fs.statSync(loader.path).size} 字节`)
    : dim('尚不存在——第一次 add 时会创建'));
}

function cmdList() {
  const doc = fs.existsSync(loader.path) ? readDoc() : null;
  const user = doc ? mergeTerms(normalizeTerms(doc.terms)) : [];
  console.log(bold(`你的词条（${user.length} 条）`) + dim(`  ${loader.path}`));
  if (!user.length) {
    console.log(dim('  （空）用 `terms.mjs add <词> --heard <误听拼写>` 添加'));
  }
  for (const t of user) {
    console.log(`  ${t.say.padEnd(22)} ${t.heard.length ? `← ${t.heard.join(', ')}` : dim('（仅归一大小写）')}`);
  }
  console.log(`\n${bold(`随插件附带的词条（${mergeTerms(BUILTIN_TERMS).length} 条）`)}` + dim('  lib/correct/glossary.js'));
  const userCanon = new Set(user.map((t) => t.say));
  for (const t of mergeTerms(BUILTIN_TERMS)) {
    const overridden = userCanon.has(t.say) ? yellow(' ← 被你覆盖') : '';
    console.log(`  ${t.say.padEnd(22)} ${t.heard.length ? `← ${t.heard.join(', ')}` : dim('（仅归一大小写）')}${overridden}`);
  }
  if (doc?.pairs?.length) {
    console.log(`\n${bold(`显式替换（${doc.pairs.length} 条）`)}`);
    for (const p of doc.pairs) console.log(`  ${p.heard} → ${p.say}`);
  }
}

function cmdAdd() {
  const say = positional[0];
  if (!say) {
    console.error('用法：terms.mjs add <规范拼写> [--heard 误听1,误听2]');
    process.exit(2);
  }
  const heard = parseHeard(flag('heard'));
  const force = args.includes('--force');
  const doc = readDoc();
  const terms = mergeTerms(normalizeTerms(doc.terms));
  const existing = terms.find((t) => t.say === say);
  let summary;
  if (existing) {
    for (const h of heard) if (!existing.heard.includes(h)) existing.heard.push(h);
    summary = `已更新「${say}」：误听形态 ${existing.heard.join('、') || '（空，仅归一大小写）'}`;
  } else {
    terms.push({ say, heard });
    summary = `已添加「${say}」${heard.length ? `，误听形态 ${heard.join('、')}` : '（仅归一大小写）'}`;
  }
  writeOrRefuse({ ...doc, terms }, { summary, force });
}

function cmdRemove() {
  const say = positional[0];
  if (!say) { console.error('用法：terms.mjs remove <规范拼写>'); process.exit(2); }
  const doc = readDoc();
  const before = doc.terms.length;
  const terms = mergeTerms(normalizeTerms(doc.terms)).filter((t) => t.say !== say);
  if (terms.length === before) {
    console.error(`没有找到「${say}」。用 \`terms.mjs list\` 看看有哪些。`);
    process.exit(1);
  }
  writeOrRefuse({ ...doc, terms }, { summary: `已删除「${say}」`, force: args.includes('--force') });
}

function cmdCheck() {
  const doc = fs.existsSync(loader.path) ? readDoc() : emptyDocument();
  console.log(`文件：${loader.path}${fs.existsSync(loader.path) ? '' : dim('（不存在，视为空）')}`);
  if (!doc.terms.length) {
    console.log(green('没有用户词条，随插件附带的词条不受影响。'));
    return;
  }
  const { issues, errors, lines } = report(doc);
  for (const line of lines) console.log(line);
  console.log('');
  if (errors.length) {
    console.log(red(`✗ ${errors.length} 条冲突，插件会在听写时跳过它们`));
    process.exit(1);
  }
  console.log(green(`✓ ${doc.terms.length} 条词条全部可用`)
    + (issues.length ? yellow(`（${issues.length} 条警告）`) : ''));
}

function cmdExport() {
  const doc = readDoc();
  const text = `${JSON.stringify({ version: 1, ...doc }, null, 2)}\n`;
  const out = positional[0];
  if (out) { fs.writeFileSync(out, text); console.log(`已导出到 ${out}`); } else { process.stdout.write(text); }
}

function parseCsv(text) {
  const terms = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const [i, line] of lines.entries()) {
    const cells = line.split(',').map((c) => c.trim());
    if (i === 0 && /^(say|term|词条|规范拼写)$/i.test(cells[0])) continue; // header
    if (!cells[0]) continue;
    terms.push({ say: cells[0], heard: parseHeard(cells[1]) });
  }
  return terms;
}

function cmdImport() {
  const file = positional[0];
  if (!file) { console.error('用法：terms.mjs import <file.json|file.csv>'); process.exit(2); }
  if (!fs.existsSync(file)) { console.error(`找不到文件：${file}`); process.exit(1); }
  const text = fs.readFileSync(file, 'utf8');
  let incoming;
  if (/\.csv$/i.test(file)) {
    incoming = parseCsv(text);
  } else {
    const raw = JSON.parse(text);
    if (Array.isArray(raw)) incoming = raw;
    else if (Array.isArray(raw.terms)) incoming = raw.terms;
    else if (Array.isArray(raw.candidates)) incoming = raw.candidates.map((c) => ({ say: c.term, heard: [] }));
    else { console.error('无法识别的格式：需要数组、{terms:[...]} 或 {candidates:[...]}'); process.exit(1); }
  }
  const doc = readDoc();
  const merged = mergeTerms([...normalizeTerms(doc.terms), ...normalizeTerms(incoming)]);
  writeOrRefuse({ ...doc, terms: merged }, {
    summary: `已导入 ${incoming.length} 条，合并后共 ${merged.length} 条。`,
    force: args.includes('--force'),
  });
}

function candidatesPath() {
  return path.join(DATA_DIR, 'glossary.json');
}

function cmdCandidates() {
  const p = candidatesPath();
  if (!fs.existsSync(p)) {
    console.error(`没有候选词表：${p}\n先运行：node scripts/learn.mjs`);
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  const list = doc.candidates ?? [];
  console.log(bold(`候选词（${list.length} 条）`) + dim(`  ${p}`));
  console.log(dim(`生成于 ${doc.generatedAt ?? '未知'}`));
  console.log('');
  for (const c of list.slice(0, 40)) {
    console.log(`  ${c.term.padEnd(26)} x${String(c.count).padEnd(5)} ${dim((c.variants ?? []).join(', '))}`);
  }
  if (list.length > 40) console.log(dim(`  …还有 ${list.length - 40} 条`));
  console.log(`\n用 \`terms.mjs apply ${list.slice(0, 2).map((c) => c.term).join(' ')}\` 接受其中几个。`);
}

/**
 * Accept candidates as **casing-only** terms.
 *
 * Candidates come from words the user typed themselves, so their `variants` are alternative
 * capitalisations, not mis-hearings. Turning those into `heard` entries would make the
 * plugin rewrite them everywhere, which is exactly the D2 defect class. So only the
 * canonical spelling is adopted, and the user can add a genuine mis-hearing afterwards with
 * `add --heard`.
 */
function cmdApply() {
  const wanted = positional;
  if (!wanted.length) { console.error('用法：terms.mjs apply <候选词> [更多…]'); process.exit(2); }
  const p = candidatesPath();
  const known = fs.existsSync(p)
    ? new Set((JSON.parse(fs.readFileSync(p, 'utf8')).candidates ?? []).map((c) => c.term))
    : new Set();
  const doc = readDoc();
  const terms = mergeTerms(normalizeTerms(doc.terms));
  let added = 0;
  for (const w of wanted) {
    if (!known.has(w)) console.log(yellow(`  ! 「${w}」不在候选表里，仍然添加`));
    if (terms.some((t) => t.say === w)) { console.log(dim(`  = 「${w}」已存在`)); continue; }
    terms.push({ say: w, heard: [] });
    added++;
  }
  writeOrRefuse({ ...doc, terms }, {
    summary: `新增 ${added} 条（仅归一大小写；误听形态请用 add --heard 单独加）。`,
    force: args.includes('--force'),
  });
}

function cmdHelp() {
  const self = path.relative(process.cwd(), fileURLToPath(import.meta.url));
  console.log(`${bold('个人词库管理')}   ${dim(`文件：${loader.path}`)}
${dim('加词不需要改源码、不需要重启 DSH。')}

用法：node ${self} <命令> [参数]

  ${bold('list')}                          列出用户词条与随插件附带的词条
  ${bold('add')} <拼写> [--heard a,b]      添加或更新一条（--heard 是观察到的误听形态）
  ${bold('remove')} <拼写>                 删除一条
  ${bold('check')}                         校验，不改动任何东西
  ${bold('export')} [文件]                 导出为 JSON
  ${bold('import')} <文件>                 从 JSON 或 CSV 合并导入
  ${bold('candidates')}                    查看 learn.mjs 生成的候选词
  ${bold('apply')} <词…>                   接受候选（只归一大小写，不当作误听）
  ${bold('path')}                          打印词库文件位置

通用参数：
  ${bold('--force')}                       跳过冲突校验强行写入（不建议；这些条目会改坏正确文本）
  ${dim('NO_COLOR=1')}                     关掉颜色

示例：
  node ${self} add FlClash --heard flcash
  node ${self} add "PlantMerge"
  node ${self} candidates && node ${self} apply PlantMerge TapTap
  node ${self} check

${dim('文件格式（也可以手改）：')}
${dim('  { "version": 1, "terms": [ "DSH", { "say": "FlClash", "heard": ["flcash"] } ] }')}
${dim('  或者直接写一个数组。冲突条目会被拒绝写入，并在听写时被跳过。')}`);
}

const COMMANDS = {
  path: cmdPath,
  list: cmdList,
  add: cmdAdd,
  remove: cmdRemove,
  check: cmdCheck,
  export: cmdExport,
  import: cmdImport,
  candidates: cmdCandidates,
  apply: cmdApply,
  help: cmdHelp,
};

const run = COMMANDS[command];
if (!run) {
  console.error(`未知命令：${command}\n`);
  cmdHelp();
  process.exit(2);
}

try {
  run();
} catch (error) {
  // A malformed file should read as a helpful message, not a stack trace.
  console.error(red(`出错：${error?.message ?? error}`));
  if (error instanceof SyntaxError) console.error(dim(`文件可能不是合法 JSON：${loader.path}`));
  process.exit(1);
}
