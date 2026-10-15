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
 *   node scripts/learn.mjs [--out <dir>] [--sessions <dir>] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { learnStyle } from '../lib/style/index.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const dryRun = args.includes('--dry-run');
const SESSIONS = flag('--sessions', path.join(os.homedir(), '.dsh', 'sessions'));
const OUT = flag('--out', path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'voice-personal'));

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
 * Boilerplate that the harness injects into the user turn.
 * Kept as explicit patterns so the rule is auditable rather than a vague heuristic.
 */
const BOILERPLATE = [
  /^Current runtime context\./,
  /^<system-reminder>/,
  /^Time sampled while preparing/,
  /^You are (researching|a|an)\b/,
  /^Background subagent\b/,
  /^background job\b/,
  /^Team message\b/,
  /^Agent [0-9a-f-]{8,} sent a message/,
  /^\s*$/,
];

/** True when the text looks like the user's own writing rather than injected context. */
function isHumanText(s) {
  if (s.length > 4000) return false;
  if (!/[\u4e00-\u9fff]/.test(s)) return false;
  return !BOILERPLATE.some(re => re.test(s));
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
    if (isHumanText(s)) human.push(s);
  }
}

const unique = [...new Set(human)];
const chars = unique.reduce((a, b) => a + b.length, 0);
console.log(`事件 ${events} 条 | 用户消息 ${allUser.length} 条 | 其中本人手写 ${unique.length} 条（${chars} 字）`);
if (readErrors) console.log(`（${readErrors} 个文件读取失败，已跳过）`);

if (!unique.length) {
  console.error('没有找到可用的本人语料。请确认会话目录正确，或先用语音/键盘留下一些中文消息。');
  process.exit(1);
}

// --- style profile -----------------------------------------------------------
const profile = learnStyle(unique);
profile.learnedAt = new Date().toISOString();
profile.source = { sessions: SESSIONS, files: files.length, messages: unique.length, chars };

// --- glossary candidates -----------------------------------------------------
// Latin tokens that recur are likely the user's real product/term vocabulary.
const latinCounts = new Map();
for (const s of unique) {
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) {
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
const writeAtomic = (p, value) => {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, value);
  fs.renameSync(tmp, p);
};
writeAtomic(path.join(OUT, 'style.json'), JSON.stringify(profile, null, 2));
writeAtomic(path.join(OUT, 'glossary.json'), JSON.stringify(glossary, null, 2));

console.log(`\n已写入：`);
console.log(`  ${path.join(OUT, 'style.json')}`);
console.log(`  ${path.join(OUT, 'glossary.json')}`);
console.log(`\n风格画像摘要：`);
console.log(`  口水词：${(profile.fillerWords ?? []).slice(0, 10).map(f => `${f.word}(${f.count})`).join(' ') || '无'}`);
console.log(`  中英空格习惯：${JSON.stringify(profile.spacing)}`);
console.log(`\n下一步：重开一个会话，插件会在下次听写时自动套用 style.json。`);
