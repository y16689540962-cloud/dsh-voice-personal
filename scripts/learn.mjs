#!/usr/bin/env node
/**
 * Learn a personal profile from the user's own session history.
 *
 * This is the "根据我本人" step. It reads the session logs already on this machine and
 * produces two artefacts:
 *
 *   - `style.json`      writing habits (fillers, punctuation, spacing, casing),
 *                       consumed by `lib/style`.
 *   - `glossary.json`   candidate terms and likely mis-hearings, for the user to review
 *                       before any of them start rewriting text.
 *
 * Two deliberate design choices:
 *
 *   1. Only human-authored text is used. Session logs also contain injected runtime
 *      context, skill catalogues and subagent reports; those are boilerplate, and
 *      learning style from them would teach the wrong voice. Filters below drop them.
 *   2. Glossary candidates are *proposals*. Nothing is applied automatically, because a
 *      wrong rewrite is worse than no rewrite.
 *
 * Session logs are zstd streams that may hold several concatenated frames, so decoding
 * walks frame boundaries instead of decompressing once.
 *
 * Usage:
 *   node scripts/learn.mjs [--out <dir>] [--sessions <dir>] [--dry-run] [--max-chars N]
 *
 * `--max-chars` (default 600) is the longest message still treated as your own writing.
 * See DEFAULT_MAX_CHARS for the measured distribution it comes from.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { learnStyle } from '../lib/style/index.js';

/**
 * Longest message still treated as the user's own writing.
 *
 * Measured on this machine's corpus: p25 = 94, median = 254, p75 = 335 characters, then a
 * long tail from 1809 (p90) to 16,508 (max). Every sampled message above 600 characters was
 * a subagent dispatch, a runtime-context block or a job notification — not dictation. A
 * dictation layer that learns its style from 3,000-character task briefs learns the wrong
 * voice, so the cutoff sits in the gap the distribution actually has.
 *
 * Override with `--max-chars` when a corpus genuinely contains long hand-written messages.
 */
const DEFAULT_MAX_CHARS = 600;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

/**
 * Reject unknown flags instead of ignoring them.
 *
 * This is not defensive style — it is a bug that already bit. Typing
 * `learn.mjs --bad-arg` while checking argument handling did not fail: the unknown flag was
 * ignored, `--dry-run` was absent, and the script ran the full pipeline and **overwrote the
 * user's existing style profile**. A typo silently destroying the previous output is worse
 * than any error message, so an unrecognised flag is now a hard stop.
 */
const KNOWN_FLAGS = new Set(['--out', '--sessions', '--dry-run', '--max-chars', '--help']);
const unknownFlags = args.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
if (unknownFlags.length) {
  console.error(`未知参数：${unknownFlags.join(' ')}`);
  console.error('可用参数：--out <dir> --sessions <dir> --dry-run --max-chars <N>');
  console.error('提示：不确定会写什么就先加 --dry-run。');
  process.exit(2);
}
if (args.includes('--help')) {
  console.log(`用法：node scripts/learn.mjs [--out <dir>] [--sessions <dir>] [--dry-run] [--max-chars N]

从本机会话历史里学表达习惯与候选词。
  --dry-run        只预览，不写任何文件
  --max-chars N    超过 N 字的消息视为不是本人手写（默认 ${DEFAULT_MAX_CHARS}）
  --sessions <dir> 会话目录，默认 ~/.dsh/sessions
  --out <dir>      输出目录，默认 ~/.dsh/voice-personal`);
  process.exit(0);
}

const dryRun = args.includes('--dry-run');
const SESSIONS = flag('--sessions', path.join(os.homedir(), '.dsh', 'sessions'));
const OUT = flag('--out', path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'voice-personal'));
const maxChars = (() => {
  const raw = flag('--max-chars', null);
  if (raw === null) return DEFAULT_MAX_CHARS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 20) {
    console.error(`--max-chars 需要一个 ≥20 的整数，收到 ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return n;
})();

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Decode a possibly multi-frame zstd file.
 * The session writer flushes a frame per append, so a single decompress call returns
 * only the first frame and silently loses the rest of the conversation.
 * @returns {string}
 */
function decodeZstdFrames(buf) {
  const parts = [];
  let pos = 0;
  while (pos < buf.length) {
    let next = buf.indexOf(ZSTD_MAGIC, pos + 4);
    if (next === -1) next = buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(pos, next)));
    } catch {
      // A truncated tail frame is normal for a session being written right now.
    }
    pos = next;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Extract plain text from a message content field. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n');
  }
  return '';
}

/**
 * Injected blocks, stripped from the text before it is judged.
 *
 * These are *removed* rather than used to reject the whole message, because the harness
 * appends them to the user's own turn: a dictated sentence followed by a `<system-reminder>`
 * is still that sentence. Rejecting the message would throw away real dictation — which is
 * exactly the material this script exists to collect.
 *
 * The earlier revision anchored its patterns at `^` and only ever rejected whole messages,
 * so anything appended after the user's text went straight into the profile. That is how
 * `goal`, `objective`, `round`, `justin`, `Users` and `Downloads` ended up as "the user's
 * vocabulary": they came from `<goal_round>` blocks and machine paths, not from anything
 * the user ever said.
 */
const INJECTED_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<goal_round>[\s\S]*?<\/goal_round>/g,
  /<compacted-summary>[\s\S]*?<\/compacted-summary>/g,
  // These are *appended* to the user's turn and run to the end of it, and they are
  // multi-paragraph. Stopping at the first blank line — the obvious first attempt — strips
  // only the header and leaves the whole body behind. That is how AGENTS.md's own prose
  // (`policy`, `workspace`, `available`, `claim`, `operation`) became "the user's vocabulary".
  /Instructions from: [^\n]*\.md[\s\S]*$/g,
  /Current runtime context\.[\s\S]*$/g,
  /^Time sampled while preparing[\s\S]*$/gm,
  /^The following workspace instructions[\s\S]*$/gm,
];

/**
 * Openers that mean the whole message is harness or agent output, never the user typing.
 * These are notifications *about* the session, not content in it.
 */
const NOT_HUMAN = [
  /^You are (researching|an?|一名|非常挑剔)/i,
  /^Background subagent\b/i,
  /^background job\b/i,
  /^Team message\b/i,
  /^Agent [0-9a-f-]{8,} sent a message/i,
  /^\[model changed:/i,
  /^The approval policy changed/i,
  // Scheduled-reminder injection. It says "from the user" but it is the harness speaking.
  /^\[SCHEDULE REMINDER BATCH\]/i,
  // Teammate task dispatches. They open like a user message and are long prose, so the only
  // reliable tell is the shared-task-board protocol they instruct the reader to use.
  /团队任务书|共享任务板|team_task_(get|update)/,
];

/** Remove injected blocks, leaving whatever the user actually wrote. */
function stripInjected(s) {
  let out = s;
  for (const re of INJECTED_BLOCKS) out = out.replace(re, '\n');
  return out.trim();
}

/** True when the text looks like the user's own writing rather than injected context. */
function isHumanText(s, maxChars = DEFAULT_MAX_CHARS) {
  const body = stripInjected(s);
  if (!body) return false;
  if (body.length > maxChars) return false;
  if (!/[\u4e00-\u9fff]/.test(body)) return false;
  return !NOT_HUMAN.some(re => re.test(body));
}

/**
 * Spans whose Latin tokens are never vocabulary: paths, URLs, emails, versions, flags and
 * code. Without this, `/Users/justin/Downloads/...` in a genuine message contributes
 * `Users`, `justin` and `Downloads` as "terms the user says".
 *
 * Same principle as the correction engine's protected spans — the same idea, applied to
 * learning rather than to rewriting.
 */
const NON_VOCABULARY = [
  /[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi,
  // Same rule as the correction engine's protected spans: a path starts at `~`, `/` or `./`
  // not preceded by a letter or digit. A delimiter list missed `@/Users/...` and
  // `工作目录：/Users/...`, and their directory names became "vocabulary the user says".
  /(?<![\w])(?:~|\/|\.{1,2}\/)[^\s)\]}>"'`]*/g,
  /[A-Za-z]:\\[^\s]*/g,
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  /\bv?\d+(?:\.\d+)+(?:[-+][\w.]+)?\b/g,
  /`[^`\n]*`/g,
  /\b[\w-]+\.(?:js|mjs|cjs|ts|json|jsonl|ya?ml|toml|md|txt|log|html?|css|sh|zsh|py|rs|go|lock|onnx|wav|mp3|png|jpe?g|svg|pdf)\b/gi,
];

/** Blank out non-vocabulary spans so their fragments are not counted as terms. */
function maskNonVocabulary(s) {
  let out = s;
  for (const re of NON_VOCABULARY) out = out.replace(re, ' ');
  return out;
}

/** Walk every session file under `root`. @returns {string[]} */
function sessionFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const dir of fs.readdirSync(root)) {
    const d = path.join(root, dir);
    let st;
    try { st = fs.statSync(d); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const sub of fs.readdirSync(d)) {
      const f = path.join(d, sub, 'session.v4.jsonl.zstd');
      if (fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

console.log(`读取会话目录：${SESSIONS}`);
const files = sessionFiles(SESSIONS);
console.log(`发现 ${files.length} 个会话文件`);

const human = [];
const allUser = [];
const dropped = { injectedOnly: 0, tooLong: 0, noChinese: 0, notification: 0 };
let events = 0;
let readErrors = 0;

for (const f of files) {
  let text;
  try {
    text = decodeZstdFrames(fs.readFileSync(f));
  } catch (error) {
    readErrors++;
    continue;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    events++;
    if (ev.type !== 'user/message') continue;
    const s = textOf(ev.data?.content ?? ev.data?.text).trim();
    if (!s) continue;
    allUser.push(s);

    // Judge the text *after* stripping injected blocks, and store the stripped form. The
    // harness appends context to the user's own turn, so the useful content is what is left
    // once the scaffolding is gone — not the whole message or nothing.
    const body = stripInjected(s);
    if (!body) { dropped.injectedOnly++; continue; }
    if (NOT_HUMAN.some(re => re.test(body))) { dropped.notification++; continue; }
    if (body.length > maxChars) { dropped.tooLong++; continue; }
    if (!/[\u4e00-\u9fff]/.test(body)) { dropped.noChinese++; continue; }
    human.push(body);
  }
}

const unique = [...new Set(human)];
const chars = unique.reduce((a, b) => a + b.length, 0);
console.log(`事件 ${events} 条 | 用户消息 ${allUser.length} 条 | 其中本人手写 ${unique.length} 条（${chars} 字）`);
console.log(`过滤掉的：纯注入 ${dropped.injectedOnly} · 通知 ${dropped.notification} · `
  + `超长(>${maxChars}字) ${dropped.tooLong} · 无中文 ${dropped.noChinese}`);
if (readErrors) console.log(`（${readErrors} 个文件读取失败，已跳过）`);

if (!unique.length) {
  console.error('没有找到可用的本人语料。请确认会话目录正确，或先用语音/键盘留下一些中文消息。');
  process.exit(1);
}

// --- style profile -----------------------------------------------------------
const profile = learnStyle(unique);
profile.learnedAt = new Date().toISOString();
profile.source = { sessions: SESSIONS, files: files.length, messages: unique.length, chars, maxChars, dropped };

// --- glossary candidates -----------------------------------------------------
// Latin tokens that recur are likely the user's real product/term vocabulary.
const latinCounts = new Map();
for (const s of unique) {
  // Mask paths/URLs/versions first: `/Users/justin/Downloads/x` must not contribute
  // `Users`, `justin` and `Downloads` as vocabulary the user "says".
  for (const m of maskNonVocabulary(s).matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) {
    const w = m[0];
    if (/^(the|and|for|not|you|are|with|this|that|from|have|will|can|but|all|any|use|get|set|out|new|var|const|function|return|echo|curl|true|false|null|http|https|com|www|json|txt|log|tmp|sh|py|js|md|background|job|output|exit|status|completed|finished|message|team|read)$/i.test(w)) continue;
    const key = w.toLowerCase();
    const rec = latinCounts.get(key) ?? { forms: new Map(), count: 0 };
    rec.forms.set(w, (rec.forms.get(w) ?? 0) + 1);
    rec.count++;
    latinCounts.set(key, rec);
  }
}
const glossaryCandidates = [...latinCounts.entries()]
  .filter(([, r]) => r.count >= 3)
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 80)
  .map(([key, r]) => {
    const forms = [...r.forms.entries()].sort((a, b) => b[1] - a[1]);
    return { term: forms[0][0], variants: forms.slice(1).map(f => f[0]), count: r.count, key };
  });

const glossary = {
  version: 1,
  note: '候选词表，供人工审阅。确认后请把词条加入 lib/correct/glossary.js 的 TERMS/PAIRS，本文件不会被自动加载。',
  generatedAt: new Date().toISOString(),
  candidates: glossaryCandidates,
};

if (dryRun) {
  console.log('\n--dry-run：不写入文件。\n');
  console.log('风格画像预览：');
  console.log(JSON.stringify({
    fillers: profile.fillerWords,
    spacing: profile.spacing,
    punctuation: profile.punctuation,
    stats: profile.stats,
  }, null, 2).slice(0, 1200));
  console.log(`\n候选词表前 20 条：`);
  for (const c of glossaryCandidates.slice(0, 20)) {
    console.log(`  ${c.term}  x${c.count}${c.variants.length ? `  (其他写法: ${c.variants.join(', ')})` : ''}`);
  }
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });

// Say what is being replaced, and keep a copy. The profile is derived data and can be
// rebuilt, but silently replacing it means a wrong run is invisible until something sounds
// wrong — which is exactly what happened when an unrecognised flag let a "check the args"
// invocation run for real.
const stylePath = path.join(OUT, 'style.json');
if (fs.existsSync(stylePath)) {
  try {
    const prev = JSON.parse(fs.readFileSync(stylePath, 'utf8'));
    const backupPath = `${stylePath}.prev`;
    fs.copyFileSync(stylePath, backupPath);
    console.log(`\n将覆盖已有画像：${prev.stats?.texts ?? '?'} 条 / ${prev.stats?.cjkChars ?? '?'} 汉字`
      + `（学于 ${prev.stats?.learnedAt ?? '未知'}）`);
    console.log(`旧画像已留一份：${backupPath}`);
  } catch {
    console.log('\n已有 style.json 无法解析，将被覆盖（未留备份）。');
  }
}

const writeAtomic = (p, value) => {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, value);
  fs.renameSync(tmp, p);
};
writeAtomic(stylePath, JSON.stringify(profile, null, 2));
writeAtomic(path.join(OUT, 'glossary.json'), JSON.stringify(glossary, null, 2));

console.log(`\n已写入：`);
console.log(`  ${path.join(OUT, 'style.json')}`);
console.log(`  ${path.join(OUT, 'glossary.json')}`);
console.log(`\n风格画像摘要：`);
console.log(`  口水词：${(profile.fillerWords ?? []).slice(0, 10).map(f => `${f.word}(${f.count})`).join(' ') || '无'}`);
console.log(`  中英空格习惯：${JSON.stringify(profile.spacing)}`);
console.log(`\n下一步：重开一个会话，插件会在下次听写时自动套用 style.json。`);
