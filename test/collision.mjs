#!/usr/bin/env node
/**
 * 碰撞面测量器 —— 「整词全拼音完全匹配」在中文同音纠错中的假阳性空间。
 *
 * 背景
 * ----
 * 本插件早期用无调拼音做中文同音纠正，2 音节键命中所有同音词（`人物`/`任务`、
 * `一部`/`异步`），上线过的 12 组两音节词条的碰撞面是 160,454 个不同的两字组合，
 * 于是整个 pass 被删除。后来要评估的收紧版本是：
 *
 *   1. 整词全拼音完全匹配（跨度每个字都要有读音，键串完全相等，非子串、非部分匹配）
 *   2. 音节数下限 L
 *   3. 词条人工确认
 *   4. 沿用现有无声调表
 *
 * 本脚本回答的唯一问题：**给定一个 L 音节的拼音键，语言里/语料里有多少个不同的
 * L 字串会共用这个键。** 数字越大，词条越危险。
 *
 * 四种口径（必须分清，结论完全不同）
 * ----------------------------------
 *   A 全表枚举  ∏|chars(音节)|：键对应多少个「表中任意字组成」的 L 字串。
 *                这是 160,454 那个数字的口径。**随 L 增长而增长**，因为因子变多。
 *                它是上界，不是风险：绝大多数组合是没人会写的生僻字串。
 *   B 语料实测  真实语料里实际出现过的、共用该键的不同 L 字串数。
 *                这才是「会不会真的改错」的直接证据。**随 L 增长而急剧下降。**
 *   C 常用字枚举 把字表限制在语料里出现频次最高的 K 个字，再算 ∏。
 *                介于 A 与 B 之间，用来估计「像人写的」串有多少。是模型，不是实测。
 *   D 词表对撞  给一份真实词表，找同键词对。与语料无关，专抓「两个都是正经词」
 *                的最小对立对——最有说服力的反例来源。
 *
 * A 涨、B 降，两者之差的来源是「生僻字不可能被写出来」，不是音节数本身。
 * 所以「L 取几」不能只看 A，也不能只看 B。
 *
 * 用法
 * ----
 *   node test/collision.mjs                                  # 默认读 ~/.dsh/sessions
 *   node test/collision.mjs --corpus <路径> --lengths 2,3,4,5
 *   node test/collision.mjs --json                           # 结构化输出，便于比较
 *   node test/collision.mjs --top 20 --split-half
 *   node test/collision.mjs --keys renwu,yibu,gongzuotai     # 只算给定键的口径 A
 *   node test/collision.mjs --wordlist words.txt             # 口径 D，一行一个词
 *   node test/collision.mjs --scope user                     # user | assistant | all
 *   node test/collision.mjs --examples                       # 打印同键串（默认关闭）
 *
 * 隐私
 * ----
 * 语料只在本机读取。默认输出**只有音节拼写和计数，没有任何汉字原文**。
 * 只有显式加 `--examples` 才会打印汉字，且只打印在该键下出现次数 ≥ --min-freq 的串
 * （高频串基本是常见词，不是隐私内容）。`--json` 同样不含原文。
 *
 * 依赖
 * ----
 * 纯 Node ESM，零依赖。只读 `lib/data/pinyin-table.txt`（经 `lib/correct/pinyin.js`）。
 * 会话文件是**多帧** zstd（Node 的 zlib 只解第一帧），这里自带帧遍历解压。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadTable } from '../lib/correct/pinyin.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ══════════════════════════ 1. 多帧 zstd ══════════════════════════ */

const ZSTD_MAGIC = 0xfd2fb528;

/**
 * 找出 `buf` 里每个 zstd 帧的 [start, end)。走块头，不解压——因此对拼接帧、
 * 截断帧都安全，也不会被压缩数据里偶然出现的 magic 骗到。
 * @returns {Array<[number, number]>}
 */
export function zstdFrameRanges(buf) {
  const out = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    if (buf.readUInt32LE(pos) !== ZSTD_MAGIC) { pos++; continue; }
    const start = pos;
    let p = pos + 4;
    const fhd = buf[p]; p++;
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!single) p++;                                  // Window_Descriptor
    p += [0, 1, 2, 4][dictFlag];                       // Dictionary_ID
    p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
    if (p > buf.length) { pos = start + 1; continue; }
    let ok = true;
    for (;;) {
      if (p + 3 > buf.length) { ok = false; break; }
      const h = buf.readUIntLE(p, 3); p += 3;
      const last = h & 1;
      const type = (h >> 1) & 3;
      const size = h >> 3;
      if (type === 0) p += size;            // Raw_Block
      else if (type === 1) p += 1;          // RLE_Block
      else if (type === 2) p += size;       // Compressed_Block
      else { ok = false; break; }           // Reserved：不是真帧
      if (p > buf.length) { ok = false; break; }
      if (last) break;
    }
    if (!ok) { pos = start + 1; continue; }
    if (checksum) p += 4;
    out.push([start, Math.min(p, buf.length)]);
    pos = p;
  }
  return out;
}

/** 解压一个（可能是多帧拼接的）zstd 文件。 */
export function readZstdAll(file) {
  const buf = fs.readFileSync(file);
  const ranges = zstdFrameRanges(buf);
  if (ranges.length <= 1) return zlib.zstdDecompressSync(buf);
  const parts = [];
  let failed = 0;
  for (const [a, b] of ranges) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(a, b))); } catch { failed++; }
  }
  if (failed) process.stderr.write(`  ! ${failed}/${ranges.length} 帧解压失败：${file}\n`);
  return Buffer.concat(parts);
}

/* ══════════════════════════ 2. 拼音表 ══════════════════════════ */

/** 无声调拼音表 + 反查：音节 -> 该读音的字集，键 -> 全表碰撞数。 */
export class PinyinIndex {
  constructor() {
    this.table = loadTable();                    // 字 -> 拼音
    /** @type {Map<string, string[]>} 音节 -> 字数组 */
    this.bySyllable = new Map();
    for (const [ch, py] of this.table) {
      let arr = this.bySyllable.get(py);
      if (!arr) { arr = []; this.bySyllable.set(py, arr); }
      arr.push(ch);
    }
    this.syllables = new Set(this.bySyllable.keys());
    this.maxSyllableLength = Math.max(...[...this.syllables].map((s) => s.length));
    this._segCache = new Map();
  }

  /** 一个 L 字串的键；跨度里有字不在表里则返回 null（「整词全拼音」要求全都有读音）。 */
  keyOf(gram) {
    const out = [];
    for (const ch of gram) {
      const py = this.table.get(ch);
      if (!py) return null;
      out.push(py);
    }
    return out.join('');
  }

  /** 读音数组，用于口径 A：保留音节边界，才能算 ∏|chars(音节)|。 */
  syllablesOf(gram) {
    const out = [];
    for (const ch of gram) {
      const py = this.table.get(ch);
      if (!py) return null;
      out.push(py);
    }
    return out;
  }

  /**
   * 把键串切成恰好 n 个音节的所有切法。作用：一个键串可能有多种切分
   * （`xian` = `xi`+`an`），不同切分对应不同的字串集合，碰撞数要相加。
   */
  segmentations(key, n) {
    const ck = `${key}|${n}`;
    const hit = this._segCache.get(ck);
    if (hit) return hit;
    const out = [];
    const walk = (i, left, acc) => {
      if (left === 0) { if (i === key.length) out.push(acc.slice()); return; }
      const maxL = Math.min(this.maxSyllableLength, key.length - i);
      for (let L = 1; L <= maxL; L++) {
        const s = key.slice(i, i + L);
        if (!this.syllables.has(s)) continue;
        acc.push(s);
        walk(i + L, left - 1, acc);
        acc.pop();
      }
    };
    walk(0, n, []);
    this._segCache.set(ck, out);
    return out;
  }

  /**
   * 口径 A：全表里有多少个不同的 n 字串的键等于 `key`。不枚举，直接乘。
   * 这是 160,454 的口径，也正是它随 L 增长的原因。
   */
  languageCollisions(key, n) {
    let total = 0;
    for (const seg of this.segmentations(key, n)) {
      let p = 1;
      for (const s of seg) p *= this.bySyllable.get(s).length;
      total += p;
    }
    return total;
  }

  /** 口径 C 的单键版本：只在 `universe`（常用字集）里数。 */
  universeCollisions(key, n, universe) {
    const counts = new Map();
    for (const ch of universe) {
      const py = this.table.get(ch);
      if (py) counts.set(py, (counts.get(py) ?? 0) + 1);
    }
    let total = 0;
    for (const seg of this.segmentations(key, n)) {
      let p = 1;
      for (const s of seg) p *= counts.get(s) ?? 0;
      total += p;
    }
    return total;
  }
}

/* ══════════════════════════ 3. 语料读取 ══════════════════════════ */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;

/** 递归找出语料目录下的会话文件（.jsonl.zstd / .jsonl / .txt / .md）。 */
export function walkCorpus(root) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jsonl\.zstd|jsonl|txt|md)$/.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * 读一个 DSH 会话文件，抽出可当语料的文本。
 * scope: `user` = 用户/委托人发出的消息；`assistant` = 模型可见正文（不含思维链）。
 * 工具的调用参数与返回结果都不算语料——那是代码和日志，不是中文散文。
 */
export function readSession(file) {
  let txt;
  try {
    txt = file.endsWith('.zstd') ? readZstdAll(file).toString('utf8') : fs.readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`  ! 读取失败 ${file}: ${err.message}\n`);
    return null;
  }
  const docs = [];
  let createdAt = 0;
  let origin = 'human';
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'session') { createdAt = o.createdAt ?? 0; origin = o.origin ?? 'human'; continue; }
    if (o.type === 'user/message' && o.data?.source?.kind === 'user') {
      for (const c of o.data.content ?? []) if (c.type === 'text' && c.text) docs.push({ text: c.text, scope: 'user' });
    } else if (o.type === 'assistant/message') {
      for (const c of o.data?.message?.content ?? []) if (c.type === 'text' && c.text) docs.push({ text: c.text, scope: 'assistant' });
    }
  }
  return { createdAt, origin, docs, file };
}

/* ══════════════════════════ 4. 统计 ══════════════════════════ */

/** 分位数摘要。入参会原地排序。 */
export function summarize(values) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const n = values.length;
  const at = (q) => values[Math.min(n - 1, Math.floor(q * n))];
  return {
    n,
    mean: values.reduce((a, b) => a + b, 0) / n,
    min: values[0],
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    p99: at(0.99),
    max: values[n - 1],
  };
}

/**
 * 对给定长度的所有音节键做「语料实测」统计。
 * 返回的 keys 里同时带上了口径 A/C 的数字，便于逐键比较。
 */
export function measureLength(docs, L, py, { topChars = 1000, minFreq = 5 } = {}) {
  const grams = new Map();          // 串 -> 出现次数
  let windows = 0;
  let skipped = 0;
  for (const { text } of docs) {
    for (const run of text.match(CJK_RUN) ?? []) {
      if (run.length < L) continue;
      for (let i = 0; i + L <= run.length; i++) {
        const gram = run.slice(i, i + L);
        const key = py.keyOf(gram);
        if (key === null) { skipped++; continue; }
        windows++;
        grams.set(gram, (grams.get(gram) ?? 0) + 1);
      }
    }
  }
  const byKey = new Map();          // 键 -> Map(串 -> 次数)
  const syllables = new Map();      // 键 -> 音节数组（口径 A 用）
  for (const [gram, n] of grams) {
    const syls = py.syllablesOf(gram);
    const key = syls.join('');
    if (!byKey.has(key)) { byKey.set(key, new Map()); syllables.set(key, syls); }
    byKey.get(key).set(gram, n);
  }
  return { L, windows, skipped, grams, byKey, syllables };
}

/* ══════════════════════════ 5. 命令行 ══════════════════════════ */

function parseArgs(argv) {
  const opts = {
    corpus: path.join(process.env.HOME ?? '', '.dsh', 'sessions'),
    lengths: [2, 3, 4, 5],
    top: 20,
    json: false,
    splitHalf: false,
    scope: 'all',
    keys: [],
    wordlist: null,
    examples: false,
    minFreq: 5,
    topChars: 1000,
    exclude: null,
    excludeText: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--corpus') opts.corpus = val();
    else if (a === '--lengths') opts.lengths = val().split(',').map(Number).filter((n) => n >= 1);
    else if (a === '--top') opts.top = Number(val());
    else if (a === '--json') opts.json = true;
    else if (a === '--split-half') opts.splitHalf = true;
    else if (a === '--scope') opts.scope = val();
    else if (a === '--keys') opts.keys = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--wordlist') opts.wordlist = val();
    else if (a === '--examples') opts.examples = true;
    else if (a === '--min-freq') opts.minFreq = Number(val());
    else if (a === '--top-chars') opts.topChars = Number(val());
    else if (a === '--exclude') opts.exclude = new RegExp(val());
    else if (a === '--exclude-text') opts.excludeText = new RegExp(val());
    else if (a === '--help' || a === '-h') { process.stdout.write(HELP); process.exit(0); }
    else { process.stderr.write(`未知参数：${a}\n\n${HELP}`); process.exit(2); }
  }
  return opts;
}

const HELP = `碰撞面测量器 —— 中文同音纠错「整词全拼音完全匹配」的假阳性空间

  node test/collision.mjs [选项]

  --corpus <路径>     语料目录，默认 ~/.dsh/sessions
  --lengths 2,3,4,5   要测的音节数
  --scope user|assistant|all
                      用哪部分语料，默认 all
  --top N             打印前 N 个最坏键（只输出音节拼写），默认 20
  --split-half        按会话时间对半切，看碰撞面稳不稳
  --keys a,b,c        只算这几个键的口径 A（全表碰撞数）
  --wordlist <文件>   口径 D：一行一个真实词，找同键词对（反例来源）
  --examples          打印同键串原文（默认关闭，见文件头「隐私」）
  --min-freq N        --examples 的最低出现次数，默认 5
  --top-chars N       口径 C 的常用字规模，默认 1000
  --exclude <正则>    跳过路径匹配的会话文件
  --exclude-text <正则>
                      整份跳过正文匹配的会话（元污染防护：讨论本题的会话里
                      会出现被测词对本身）
  --json              结构化输出
  --help
`;

/* ══════════════════════════ 6. 主流程 ══════════════════════════ */

/* 主流程。作为库被 import 时不会自动执行——`main()` 只在直接运行时调用。 */
export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const py = new PinyinIndex();
  const report = {
    generatedAt: new Date().toISOString(),
    corpusPath: opts.corpus,
    scope: opts.scope,
    tableChars: py.table.size,
    tableSyllables: py.syllables.size,
    corpus: {},
    lengths: {},
    calibration: {},
    wordlist: null,
    keys: null,
    splitHalf: null,
  };

  if (!fs.existsSync(opts.corpus)) {
    const msg = [
      `语料路径不存在：${opts.corpus}`,
      '',
      '本脚本默认读本机 DSH 会话（~/.dsh/sessions），那里是 *.jsonl.zstd。',
      '换一个语料请用：',
      '  node test/collision.mjs --corpus /path/to/corpus',
      '语料可以是 .jsonl.zstd / .jsonl / .txt / .md，目录会被递归扫描。',
      opts.corpus.startsWith(process.env.HOME ?? '\u0000')
        ? '（路径在 HOME 下，可能是这个工作区还没产生过会话。）'
        : '（绝对路径不存在，检查一下拼写。）',
    ].join('\n');
    if (opts.json) {
      report.error = 'corpus-missing';
      report.message = msg;
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
    process.exit(1);
  }

  /* --- 读语料 --- */
  const allFiles = walkCorpus(opts.corpus);
  const files = opts.exclude ? allFiles.filter((f) => !opts.exclude.test(f)) : allFiles;
  const excluded = allFiles.length - files.length;
  const sessions = [];
  let skippedByText = 0;
  for (const f of files) {
    const s = readSession(f);
    if (!s || !s.docs.length) continue;
    // 元污染防护：讨论本题的会话里会出现被测词对本身（工作台/工作太、人物/任务），
    // 把它们算进语料会让碰撞面自己证明自己。--exclude-text 按内容整份剔除。
    if (opts.excludeText && s.docs.some((d) => opts.excludeText.test(d.text))) { skippedByText++; continue; }
    sessions.push(s);
  }
  let docs = [];
  for (const s of sessions) {
    for (const d of s.docs) docs.push({ text: d.text, scope: d.scope, createdAt: s.createdAt, origin: s.origin });
  }
  if (opts.scope !== 'all') docs = docs.filter((d) => d.scope === opts.scope);
  if (!docs.length) {
    const msg = `在 ${opts.corpus} 找到 ${files.length} 个文件，但 scope=${opts.scope} 下没有可用的中文文本。`;
    if (opts.json) { report.error = 'corpus-empty'; report.message = msg; process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); }
    else process.stderr.write(`${msg}\n`);
    process.exit(1);
  }

  const cjkCount = (arr) => arr.reduce((n, d) => n + (d.text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length, 0);
  const cjkAll = docs.reduce((n, d) => n + (d.text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length, 0);
  report.corpus = {
    files: files.length,
    excludedFiles: excluded,
    excludedByText: skippedByText,
    sessions: sessions.length,
    documents: docs.length,
    messages: { user: docs.filter((d) => d.scope === 'user').length, assistant: docs.filter((d) => d.scope === 'assistant').length },
    cjkChars: cjkAll,
    cjkCharsByScope: { user: cjkCount(docs.filter((d) => d.scope === 'user')), assistant: cjkCount(docs.filter((d) => d.scope === 'assistant')) },
    timeRange: (() => {
      const t = docs.map((d) => d.createdAt).filter(Boolean).sort((a, b) => a - b);
      return t.length ? { from: new Date(t[0]).toISOString(), to: new Date(t[t.length - 1]).toISOString() } : null;
    })(),
  };

  /* --- 常用字表（口径 C 的字集）：按语料内字频排序 --- */
  const charFreq = new Map();
  for (const d of docs) for (const ch of d.text) if (CJK.test(ch)) charFreq.set(ch, (charFreq.get(ch) ?? 0) + 1);
  const rankedChars = [...charFreq.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const commonUniverse = new Set(rankedChars.slice(0, opts.topChars));

  /* --- 逐长度测量 --- */
  for (const L of opts.lengths) {
    const m = measureLength(docs, L, py);
    const attested = [];        // 每键的不同串数（按键平均）
    const tokenWeighted = [];   // 每个 token 所在键的串数（按文本出现平均）
    const fullTable = [];       // 口径 A
    const commonTable = [];     // 口径 C
    const histogram = {};
    let ambiguousKeys = 0;
    let ambiguousTokens = 0;
    let tokens = 0;

    for (const [key, gramMap] of m.byKey) {
      const size = gramMap.size;
      attested.push(size);
      histogram[size] = (histogram[size] ?? 0) + 1;
      const syls = m.syllables.get(key);
      fullTable.push(py.languageCollisions(syls.join(''), L));
      commonTable.push(py.universeCollisions(syls.join(''), L, commonUniverse));
      if (size >= 2) ambiguousKeys++;
      for (const n of gramMap.values()) {
        tokens += n;
        tokenWeighted.push(size);
        if (size >= 2) ambiguousTokens += n;
      }
    }

    const top = [...m.byKey.entries()]
      .map(([key, g]) => ({ key, distinctStrings: g.size, hits: [...g.values()].reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.distinctStrings - a.distinctStrings || b.hits - a.hits)
      .slice(0, opts.top);

    report.lengths[L] = {
      windows: m.windows,
      skippedNoReading: m.skipped,
      distinctStrings: m.grams.size,
      distinctKeys: m.byKey.size,
      fullTableCollisions: summarize(fullTable),
      commonCharCollisions: summarize(commonTable),
      attestedPerKey: summarize(attested),
      attestedTokenWeighted: summarize(tokenWeighted),
      keysWithCollision: ambiguousKeys,
      keysWithCollisionPct: (100 * ambiguousKeys) / m.byKey.size,
      tokenAmbiguityRatePct: (100 * ambiguousTokens) / Math.max(1, tokens),
      ambiguityTokens: ambiguousTokens,
      tokenCount: tokens,
      keySizeHistogram: histogram,
      topKeys: top.map((t) => ({
        key: t.key,
        distinctStrings: t.distinctStrings,
        hits: t.hits,
        fullTableCollisions: py.languageCollisions(t.key, L),
        ...(opts.examples ? {
          strings: [...m.byKey.get(t.key).entries()]
            .filter(([, n]) => n >= opts.minFreq)
            .sort((a, b) => b[1] - a[1])
            .map(([g, n]) => ({ text: g, count: n })),
        } : {}),
      })),
    };
  }

  /* --- 对半切稳定性 --- */
  if (opts.splitHalf && sessions.length >= 4) {
    const dated = sessions.filter((s) => s.createdAt).sort((a, b) => a.createdAt - b.createdAt);
    const mid = Math.floor(dated.length / 2);
    const halves = { older: dated.slice(0, mid), newer: dated.slice(mid) };
    const out = {};
    for (const [name, group] of Object.entries(halves)) {
      const d = [];
      for (const s of group) for (const x of s.docs) d.push({ text: x.text, scope: x.scope });
      out[name] = { sessions: group.length, cjkChars: cjkCount(d), lengths: {} };
      for (const L of opts.lengths) {
        const m = measureLength(d, L, py);
        let amb = 0;
        let tok = 0;
        let ambTok = 0;
        const sizes = [];
        for (const [, g] of m.byKey) {
          sizes.push(g.size);
          if (g.size >= 2) amb++;
          for (const n of g.values()) { tok += n; if (g.size >= 2) ambTok += n; }
        }
        out[name].lengths[L] = {
          distinctKeys: m.byKey.size,
          maxCollision: sizes.length ? Math.max(...sizes) : 0,
          keysWithCollision: amb,
          keysWithCollisionPct: (100 * amb) / Math.max(1, m.byKey.size),
          tokenAmbiguityRatePct: (100 * ambTok) / Math.max(1, tok),
        };
      }
    }
    // 同键碰撞数在两半之间是否一致
    const compare = {};
    for (const L of opts.lengths) {
      const maps = {};
      for (const [name, group] of Object.entries(halves)) {
        const d = [];
        for (const s of group) for (const x of s.docs) d.push({ text: x.text, scope: x.scope });
        const m = measureLength(d, L, py);
        const mm = new Map();
        for (const [k, g] of m.byKey) mm.set(k, g.size);
        maps[name] = mm;
      }
      const shared = [...maps.older.keys()].filter((k) => maps.newer.has(k));
      const same = shared.filter((k) => maps.older.get(k) === maps.newer.get(k)).length;
      const ambOlder = new Set([...maps.older].filter(([, v]) => v >= 2).map(([k]) => k));
      const ambNewer = new Set([...maps.newer].filter(([, v]) => v >= 2).map(([k]) => k));
      const both = [...ambOlder].filter((k) => ambNewer.has(k)).length;
      compare[L] = {
        sharedKeys: shared.length,
        sharedKeysSameCount: same,
        sharedKeysSamePct: (100 * same) / Math.max(1, shared.length),
        collisionKeysOlder: ambOlder.size,
        collisionKeysNewer: ambNewer.size,
        collisionKeysInBoth: both,
        // 只在其中一半出现碰撞的键 —— 会话主题影响的直接证据
        collisionKeysOnlyOneHalf: ambOlder.size + ambNewer.size - 2 * both,
      };
    }
    report.splitHalf = { halves: out, compare };
  }

  /* --- 校准：口径 A 对已知键 --- */
  {
    const DOCUMENTED = {
      renwu: 2, yibu: 2, xintiao: 2, bianyi: 2, jiedian: 2, peizhi: 2, chajian: 2, gongzuotai: 3,
    };
    const per = {};
    let sum2 = 0;
    for (const [k, n] of Object.entries(DOCUMENTED)) {
      const c = py.languageCollisions(k, n);
      per[k] = { syllables: n, fullTableCollisions: c };
      if (n === 2) sum2 += c;
    }
    report.calibration = {
      note: '仓库里可考据的 7 个两音节键（README/glossary 的 6 组 + 差件/插件）。原始 12 组词条未落盘，剩余 5 组的键不可考。',
      documentedKeys: per,
      documentedTwoSyllableSum: sum2,
      claimedOriginal: 160454,
      documentedOverClaimedPct: (100 * sum2) / 160454,
    };
  }

  /* --- 给定键 --- */
  if (opts.keys.length) {
    report.keys = opts.keys.map((k) => {
      const entry = { key: k, byLength: {} };
      for (const n of opts.lengths.length ? opts.lengths : [1, 2, 3, 4, 5]) {
        const segs = py.segmentations(k, n);
        if (segs.length) entry.byLength[n] = { fullTableCollisions: py.languageCollisions(k, n), segmentations: segs };
      }
      return entry;
    });
  }

  /* --- 词表对撞（口径 D） --- */
  if (opts.wordlist) {
    if (!fs.existsSync(opts.wordlist)) {
      process.stderr.write(`词表不存在：${opts.wordlist}\n`);
      process.exit(1);
    }
    const words = fs.readFileSync(opts.wordlist, 'utf8')
      .split(/\r?\n|[\s,，、]+/).map((w) => w.trim()).filter((w) => w && [...w].every((ch) => CJK.test(ch)));
    const byKey = new Map();
    for (const w of [...new Set(words)]) {
      const syls = py.syllablesOf(w);
      if (!syls) continue;
      const key = syls.join('');
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(w);
    }
    const groups = [...byKey.entries()].filter(([, g]) => g.length >= 2).map(([key, g]) => ({
      key,
      length: [...g[0]].length,
      wordCount: g.length,
      fullTableCollisions: py.languageCollisions(key, [...g[0]].length),
    }));
    // 词表是用户自己给的，不是语料，因此这里的汉字照常打印（不受 --examples 约束）。
    for (const g of groups) g.words = byKey.get(g.key);
    report.wordlist = { path: opts.wordlist, words: new Set(words).size, sameKeyGroups: groups };
  }

  /* ══════════════════════════ 7. 输出 ══════════════════════════ */

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const n = (x) => (typeof x === 'number' ? Math.round(x).toLocaleString('en-US') : x);
    const line = (s) => process.stdout.write(`${s}\n`);

    line('═'.repeat(78));
    line('中文同音纠错 · 整词全拼音完全匹配 · 碰撞面实测');
    line('═'.repeat(78));
    line(`拼音表      ${n(py.table.size)} 字 / ${n(py.syllables.size)} 个无声调音节`);
    line(`语料        ${report.corpusPath}`);
    line(`            ${n(report.corpus.sessions)} 个会话 · ${n(report.corpus.documents)} 段文本（user ${n(report.corpus.messages.user)} / assistant ${n(report.corpus.messages.assistant)}）`);
    line(`            ${n(report.corpus.cjkChars)} 个汉字（user ${n(report.corpus.cjkCharsByScope.user)} / assistant ${n(report.corpus.cjkCharsByScope.assistant)}）`);
    if (report.corpus.timeRange) line(`            时间跨度 ${report.corpus.timeRange.from.slice(0, 10)} → ${report.corpus.timeRange.to.slice(0, 10)}`);

    line('');
    line('─'.repeat(78));
    line('口径 A 校准：仓库里可考据的两音节键（160,454 那个数字的口径）');
    line('─'.repeat(78));
    for (const [k, v] of Object.entries(report.calibration.documentedKeys)) {
      line(`  ${k.padEnd(12)} L=${v.syllables}  全表碰撞数 ${n(v.fullTableCollisions)}`);
    }
    line(`  7 个两音节键合计 ${n(report.calibration.documentedTwoSyllableSum)}` +
         `  = 自称 160,454 的 ${report.calibration.documentedOverClaimedPct.toFixed(1)}%`);

    for (const L of opts.lengths) {
      const r = report.lengths[L];
      line('');
      line('─'.repeat(78));
      line(`L = ${L}   窗口 ${n(r.windows)} · 不同串 ${n(r.distinctStrings)} · 不同键 ${n(r.distinctKeys)}`
        + (r.skippedNoReading ? ` · 跳过错字 ${n(r.skippedNoReading)}` : ''));
      line('─'.repeat(78));
      const row = (label, s) => s && line(`  ${label.padEnd(26)} 平均 ${String(n(Math.round(s.mean))).padStart(12)}   中位 ${String(n(s.p50)).padStart(12)}   p90 ${String(n(s.p90)).padStart(13)}   p99 ${String(n(s.p99)).padStart(14)}   最大 ${String(n(s.max)).padStart(15)}`);
      row('A 全表枚举 ∏|chars|', r.fullTableCollisions);
      row(`C 常用字枚举(前 ${opts.topChars} 字)`, r.commonCharCollisions);
      row('B 语料实测(按键平均)', r.attestedPerKey);
      row('B 语料实测(按出现加权)', r.attestedTokenWeighted);
      line(`  碰撞键占比                ${r.keysWithCollisionPct.toFixed(2)}%  (${n(r.keysWithCollision)}/${n(r.distinctKeys)} 个键有 ≥2 个实测串)`);
      line(`  文本歧义率                ${r.tokenAmbiguityRatePct.toFixed(3)}%  (${n(r.ambiguityTokens)}/${n(r.tokenCount)} 个位置的键被另一个实测串共用)`);
      line(`  每键实测串数分布          ${Object.entries(r.keySizeHistogram).slice(0, 8).map(([k, v]) => `${k}串:${n(v)}键`).join('  ')}`);
      line(`  最坏的 ${r.topKeys.length} 个键（只列音节拼写）：`);
      for (const t of r.topKeys) {
        line(`    ${t.key.padEnd(22)} 实测串 ${String(t.distinctStrings).padStart(3)}   出现 ${String(n(t.hits)).padStart(6)} 次   全表碰撞 ${n(t.fullTableCollisions)}`);
        if (t.strings?.length) line(`      → ${t.strings.map((s) => `${s.text}×${s.count}`).join('  ')}`);
      }
    }

    if (report.splitHalf) {
      line('');
      line('─'.repeat(78));
      line('跨语料稳定性（按会话时间对半切）');
      line('─'.repeat(78));
      for (const [name, h] of Object.entries(report.splitHalf.halves)) {
        line(`  ${name.padEnd(7)} ${n(h.sessions)} 会话 · ${n(h.cjkChars)} 汉字`);
        for (const [L, v] of Object.entries(h.lengths)) {
          line(`    L=${L}  碰撞键 ${(v.keysWithCollisionPct).toFixed(2)}%   文本歧义率 ${(v.tokenAmbiguityRatePct).toFixed(3)}%   单键最大 ${v.maxCollision}`);
        }
      }
      line('  两半共有键的碰撞数是否一致：');
      for (const [L, c] of Object.entries(report.splitHalf.compare)) {
        line(`    L=${L}  共有键 ${n(c.sharedKeys)}  计数一致 ${c.sharedKeysSamePct.toFixed(1)}%`
          + `  碰撞键(旧半/新半/都中) ${n(c.collisionKeysOlder)}/${n(c.collisionKeysNewer)}/${n(c.collisionKeysInBoth)}`
          + `  只在一半出现 ${n(c.collisionKeysOnlyOneHalf)}`);
      }
    }

    if (report.keys) {
      line('');
      line('─'.repeat(78));
      line('给定键的口径 A');
      line('─'.repeat(78));
      for (const e of report.keys) {
        line(`  ${e.key}`);
        for (const [n_, v] of Object.entries(e.byLength)) {
          line(`    L=${n_}  全表碰撞 ${n(v.fullTableCollisions)}   切分 ${v.segmentations.map((s) => s.join('-')).join(' | ')}`);
        }
      }
    }

    if (report.wordlist) {
      line('');
      line('─'.repeat(78));
      line(`口径 D 词表对撞：${report.wordlist.path}（${n(report.wordlist.words)} 个词）`);
      line('─'.repeat(78));
      if (!report.wordlist.sameKeyGroups.length) line('  没有同键词对。');
      for (const g of report.wordlist.sameKeyGroups) {
        line(`  L=${g.length}  ${g.key.padEnd(20)} ${g.words.join(' / ')}   [全表碰撞 ${n(g.fullTableCollisions)}]`);
      }
    }

    line('');
    line('跑完。口径说明见本脚本文件头。');
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
