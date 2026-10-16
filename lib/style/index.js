/**
 * dsh-voice-personal / lib/style
 * 风格学习模块：从用户自己的语料统计出确定性风格画像，并作为听写后处理应用。
 *
 * 设计约束（硬性）：
 *  - 纯 ESM、零外部依赖、不联网、不调用任何 LLM。
 *  - 完全确定性：同样的输入 -> 同样的输出（除了 profile.stats.learnedAt 这个时间戳）。
 *  - learnStyle 返回**纯 JSON**（可直接 JSON.stringify / JSON.parse 往返）。
 *  - applyStyle 绝不「猜」语义：只在证据足够（孤立口水词、统计出的空格/大小写习惯）时改动。
 *
 * 冻结接口：
 *   export const STYLE_VERSION = 1;
 *   export function learnStyle(texts, options) -> profile
 *   export function applyStyle(text, profile, options) -> { text, changes }
 *
 * 已知限制见 README.md。
 */

import {
  CJK_RE,
  CJK_RUN_RE,
  GLUED_FILLERS,
  END_PARTICLES,
  FILLER_TIERS,
  HALF_TO_FULL,
  LATIN_WORD_RE,
  PUNCT_SET,
  SOFT_SEPARATORS,
  byLengthDesc,
  cmp,
  isCjk,
  isHardEnder,
  isLatin,
  isSentenceBreak,
  isSoftSeparator,
  isWordChar,
} from './lexicon.js';

export const STYLE_VERSION = 1;

/** 口水词表按长度降序，保证最长优先匹配且顺序确定。 */
const FILLER_WORDS = Object.keys(FILLER_TIERS).sort(byLengthDesc);

/** 全角/半角成对的中文标点。 */
const PUNCT_PAIRS = [
  ['，', ','],
  ['。', '.'],
  ['！', '!'],
  ['？', '?'],
  ['；', ';'],
  ['：', ':'],
];

/** casing 永不改写的词（单字母英文在句中出现时大小写由语法决定，不是「习惯」）。 */
const CASING_SKIP = new Set(['i', 'a']);

const DEFAULT_LEARN_OPTIONS = Object.freeze({
  minCount: 3,
  maxFillers: 40,
  maxPhrases: 60,
  maxCasing: 100,
  minPhraseLen: 2,
  maxPhraseLen: 4,
  /** 中英边界观测数低于此值就不对 spacing 表态。 */
  minSpacingSamples: 3,
});

const DEFAULT_APPLY_OPTIONS = Object.freeze({
  fillers: true,
  spacing: true,
  casing: true,
  cleanup: false,
  casingMinCount: 2,
  /**
   * Folded forms the casing pass must leave alone.
   *
   * The glossary and the style profile can disagree, and the style pass used to win simply
   * because it runs last. That is backwards: the glossary is an explicit decision ("spell it
   * `DSH`"), while the profile is a majority vote over past typing. A vote must not overrule
   * a declaration.
   *
   * The failure was silent and long-standing. Measured on the real profile: it preferred
   * `dsh` (0.67), `taptap` (0.89) and `gpt` (0.73), so `dsh` → `DSH`, `tapTap` → `TapTap` and
   * `gpt` → `GPT` were each normalised by the glossary and immediately undone here. No test
   * caught it because the correction suite calls the corrector without a style profile.
   */
  canonicals: null,
});

/* ------------------------------------------------------------------ *
 * 输入归一化
 * ------------------------------------------------------------------ */

/**
 * 接受：string | string[] | {text}[] | {texts: [...]}
 * 返回 [{ text, weight }]。非字符串项按「权重」累加（用于重复语料）。
 */
function normalizeTexts(texts) {
  const out = [];
  const push = (value, weight = 1) => {
    if (typeof value === 'string') {
      if (value.length > 0) out.push({ text: value, weight });
      return;
    }
    if (value && typeof value === 'object' && typeof value.text === 'string') {
      if (value.text.length > 0) {
        const w = Number.isFinite(value.weight) && value.weight > 0 ? value.weight : 1;
        out.push({ text: value.text, weight: w });
      }
      return;
    }
    throw new TypeError('learnStyle: texts 只能是 string、string[]、{text,weight}[] 或 {texts: [...]}');
  };

  if (typeof texts === 'string') push(texts);
  else if (Array.isArray(texts)) for (const item of texts) push(item);
  else if (texts && typeof texts === 'object' && Array.isArray(texts.texts)) {
    for (const item of texts.texts) push(item);
  } else if (texts === null || texts === undefined) {
    return [];
  } else {
    throw new TypeError('learnStyle: texts 只能是 string、string[]、{text,weight}[] 或 {texts: [...]}');
  }
  return out;
}

function toPositiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** 数 CJK 字符数。 */
function countCjk(text) {
  let n = 0;
  for (const ch of text) if (CJK_RE.test(ch)) n += 1;
  return n;
}

/** 切句：按硬句末标点/换行切，保留标点。 */
function splitSentences(text) {
  const parts = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') {
      if (buf.trim()) parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
    if (isSentenceBreak(ch)) {
      if (buf.trim()) parts.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

/* ------------------------------------------------------------------ *
 * 口水词：判定 + 统计
 * ------------------------------------------------------------------ */

/**
 * 命中的口水词**实际要删除的长度**（0 = 不可删）。
 *
 * 之所以返回长度而不是布尔值：层级 1 的语气词若右侧粘着「纯叹词」字符
 * （啊+哈 / 哦+豁…），必须把整个叹词一起删掉；只删「啊」会留下半截「哈」。
 */
export function fillerDeletionLength(word, left, right) {
  const tier = FILLER_TIERS[word];
  if (!tier) return 0;
  // 左侧紧邻词字符 -> 它是别的词的一部分（「我觉得这个」「就是这个问题」），不删
  if (isWordChar(left)) return 0;
  if (tier === 1) {
    if (isWordChar(right)) {
      // 语气词右侧粘着实词字符：一律不删。句首的「唉声叹气」「呃逆」里，语气字本身就是
      // 词的一部分（对抗验证确认过这个形态），而「呃帮我稳定一下」与它无法用单字符上下文
      // 区分——宁可漏删这一种形态，也不能误删词首。只有命中白名单（啊哈/哦豁）时才连同
      // 后字一起删。
      return GLUED_FILLERS.has(word + right) ? word.length + 1 : 0;
    }
    return word.length;
  }
  // tier 2（就是/那个/这个/然后/其实…）：必须左右都非词字符，即完全孤立
  return isWordChar(right) ? 0 : word.length;
}

/**
 * 判定一个「口水词候选」在给定上下文中是否**可以安全删除**。
 * 导出是为了让测试能直接验证歧义规则。
 *
 * @param {string} word 命中的候选词
 * @param {string|undefined} left 左邻字符
 * @param {string|undefined} right 右邻字符
 */
export function isFillerDeletable(word, left, right) {
  return fillerDeletionLength(word, left, right) > 0;
}

/** 扫描语料，统计「确实可作为口水词删除」的出现次数。 */
function scanFillers(entries) {
  const counts = new Map();
  for (const { text, weight } of entries) {
    let i = 0;
    while (i < text.length) {
      let matched = null;
      for (const w of FILLER_WORDS) {
        if (text.startsWith(w, i)) {
          matched = w;
          break;
        }
      }
      if (!matched) {
        i += 1;
        continue;
      }
      const left = i === 0 ? undefined : text[i - 1];
      const right = text[i + matched.length];
      const del = fillerDeletionLength(matched, left, right);
      if (del > 0) {
        counts.set(matched, (counts.get(matched) || 0) + weight);
      }
      i += matched.length;
    }
  }
  return counts;
}

/* ------------------------------------------------------------------ *
 * 各项统计
 * ------------------------------------------------------------------ */

function collectSentenceEnders(entries) {
  const words = new Map();
  const marks = new Map();
  let total = 0;
  for (const { text, weight } of entries) {
    for (const sentence of splitSentences(text)) {
      total += weight;
      const trimmed = sentence.replace(/[\s]+$/, '');
      if (!trimmed) continue;
      const last = trimmed[trimmed.length - 1];
      if (PUNCT_SET.has(last)) marks.set(last, (marks.get(last) || 0) + weight);
      const body = PUNCT_SET.has(last) ? trimmed.slice(0, -1) : trimmed;
      for (const p of END_PARTICLES) {
        if (body.endsWith(p) && body.length > p.length) {
          words.set(p, (words.get(p) || 0) + weight);
          break;
        }
      }
    }
  }
  const toSorted = (map, key) =>
    [...map.entries()]
      .map(([k, count]) => ({ [key]: k, count, ratio: total ? round4(count / total) : 0 }))
      .sort((a, b) => b.count - a.count || cmp(a[key], b[key]));
  return { total, words: toSorted(words, 'word').slice(0, 20), punctuation: toSorted(marks, 'mark').slice(0, 20) };
}

function collectPunctuation(entries) {
  const counts = new Map();
  let total = 0;
  for (const { text, weight } of entries) {
    for (const ch of text) {
      if (!PUNCT_SET.has(ch)) continue;
      counts.set(ch, (counts.get(ch) || 0) + weight);
      total += weight;
    }
  }
  let full = 0;
  let half = 0;
  const pairs = {};
  for (const [f, h] of PUNCT_PAIRS) {
    const fc = counts.get(f) || 0;
    const hc = counts.get(h) || 0;
    full += fc;
    half += hc;
    pairs[`${f}${h}`] = {
      full: fc,
      half: hc,
      fullRatio: fc + hc ? round4(fc / (fc + hc)) : null,
    };
  }
  const equiv = full + half;
  const exclamation = counts.get('！') || 0;
  const ordered = {};
  for (const key of [...counts.keys()].sort(cmp)) ordered[key] = counts.get(key);
  return {
    total,
    counts: ordered,
    fullWidthRatio: equiv ? round4(full / equiv) : null,
    halfWidthRatio: equiv ? round4(half / equiv) : null,
    commaStyle: pickStyle(counts.get('，') || 0, counts.get(',') || 0, '，', ','),
    periodStyle: pickStyle(counts.get('。') || 0, counts.get('.') || 0, '。', '.'),
    exclamationRatio: total ? round4(exclamation / total) : 0,
    exclamationHeavy: total ? exclamation / total >= 0.15 : false,
    usesEnglishPunctuation: equiv ? half > full : false,
    pairs,
  };
}

function pickStyle(fullCount, halfCount, fullMark, halfMark) {
  if (!fullCount && !halfCount) return null;
  if (fullCount === halfCount) return 'mixed';
  return fullCount > halfCount ? fullMark : halfMark;
}

function collectPhrases(entries, { minCount, maxPhrases, minPhraseLen, maxPhraseLen }) {
  const counts = new Map();
  for (const { text, weight } of entries) {
    CJK_RUN_RE.lastIndex = 0;
    let run;
    while ((run = CJK_RUN_RE.exec(text)) !== null) {
      const s = run[0];
      for (let n = minPhraseLen; n <= maxPhraseLen; n += 1) {
        for (let i = 0; i + n <= s.length; i += 1) {
          const gram = s.slice(i, i + n);
          counts.set(gram, (counts.get(gram) || 0) + weight);
        }
      }
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([phrase, count]) => ({ phrase, count, length: phrase.length }))
    .sort((a, b) => b.count - a.count || b.length - a.length || cmp(a.phrase, b.phrase))
    .slice(0, maxPhrases);
}

/**
 * 中英文之间的空格习惯。
 * 统计窗口：一个 CJK 字符和一个拉丁字母/数字之间**紧邻**的边界，
 * 相邻则记 1 次（spaced 或 tight）；中间夹别的标点则不计入。
 */
function collectSpacing(entries, { minSpacingSamples }) {
  let spaced = 0;
  let tight = 0;
  let spacedCjkLatin = 0;
  let tightCjkLatin = 0;
  let spacedLatinCjk = 0;
  let tightLatinCjk = 0;

  for (const { text, weight } of entries) {
    for (let i = 0; i + 1 < text.length; i += 1) {
      const a = text[i];
      const b = text[i + 1];
      if (isCjk(a) && isLatin(b)) {
        tightCjkLatin += weight;
        tight += weight;
      } else if (isLatin(a) && isCjk(b)) {
        tightLatinCjk += weight;
        tight += weight;
      } else if (a === ' ' && i > 0 && text[i + 1] !== undefined) {
        const l = text[i - 1];
        const r = text[i + 1];
        if (isCjk(l) && isLatin(r)) {
          spacedCjkLatin += weight;
          spaced += weight;
        } else if (isLatin(l) && isCjk(r)) {
          spacedLatinCjk += weight;
          spaced += weight;
        }
      }
    }
  }

  const total = spaced + tight;
  const ratio = total ? round4(spaced / total) : null;
  const confident = total >= minSpacingSamples; // 总体样本不足 -> 一律 null，绝不臆测
  let latinNeedsSpace = decide(tightCjkLatin, spacedCjkLatin, confident);
  let cjkNeedsSpace = decide(tightLatinCjk, spacedLatinCjk, confident);

  // 某一方向一次都没出现过（例如用户从不写「English 中文」）时，
  // 沿用另一方向的结论 —— 同一个人的中英夹写空格习惯是一致的。
  const latinSeen = tightCjkLatin + spacedCjkLatin;
  const cjkSeen = tightLatinCjk + spacedLatinCjk;
  if (latinNeedsSpace === null && latinSeen === 0 && cjkNeedsSpace !== null) latinNeedsSpace = cjkNeedsSpace;
  if (cjkNeedsSpace === null && cjkSeen === 0 && latinNeedsSpace !== null) cjkNeedsSpace = latinNeedsSpace;

  return {
    spaced,
    tight,
    total,
    ratio,
    spacedCjkLatin,
    tightCjkLatin,
    spacedLatinCjk,
    tightLatinCjk,
    latinNeedsSpace,
    cjkNeedsSpace,
    threshold: SPACING_THRESHOLD,
    minSamples: minSpacingSamples,
    sampleSize: total,
    /** 总体证据不足时为 false，applyStyle 就不会动空格。 */
    confident,
  };
}

/** 判定阈值：某个方向有空格的比例 >= 0.6 就算「爱加空格」。 */
const SPACING_THRESHOLD = 0.6;

/**
 * 依据**该方向自己的**计数与阈值决定要不要加空格。
 * @param {boolean} confident 总体证据是否充足
 * @returns {boolean|null} null = 该方向没有观测，不表态
 */
function decide(tight, spaced, confident) {
  if (!confident) return null;
  if (tight + spaced === 0) return null;
  return spaced / (tight + spaced) >= SPACING_THRESHOLD;
}

function collectCasing(entries, { minCount, maxCasing }) {
  const tally = new Map(); // canonical -> Map(form -> count)
  for (const { text, weight } of entries) {
    LATIN_WORD_RE.lastIndex = 0;
    let m;
    while ((m = LATIN_WORD_RE.exec(text)) !== null) {
      const raw = m[0];
      if (raw.length < 2) continue; // 单字母（I / a）交给语法，不学
      const key = raw.toLowerCase();
      if (!tally.has(key)) tally.set(key, new Map());
      const forms = tally.get(key);
      forms.set(raw, (forms.get(raw) || 0) + weight);
    }
  }
  const out = [];
  for (const [canonical, forms] of tally) {
    const variants = [...forms.entries()]
      .map(([form, count]) => ({ form, count }))
      .sort((a, b) => b.count - a.count || cmp(a.form, b.form));
    const total = variants.reduce((sum, v) => sum + v.count, 0);
    if (total < minCount) continue;
    const top = variants[0];
    const tied = variants.length > 1 && variants[1].count === top.count;
    const majority = !tied && top.count * 2 > total;
    out.push({
      word: canonical,
      variants,
      total,
      preferred: majority && !CASING_SKIP.has(canonical) ? top.form : null,
      ratio: round4(top.count / total),
      mixed: variants.length > 1,
      ambiguous: tied,
    });
  }
  return out.sort((a, b) => b.total - a.total || cmp(a.word, b.word)).slice(0, maxCasing);
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/* ------------------------------------------------------------------ *
 * learnStyle
 * ------------------------------------------------------------------ */

/**
 * 从用户语料学习风格画像。
 * @param {string|string[]|{text:string,weight?:number}[]|{texts:any[]}} texts
 * @param {{minCount?:number,maxFillers?:number,maxPhrases?:number,maxCasing?:number,minPhraseLen?:number,maxPhraseLen?:number}} [options]
 * @returns {object} 纯 JSON 画像
 */
export function learnStyle(texts, options = {}) {
  const opts = { ...DEFAULT_LEARN_OPTIONS, ...(options || {}) };
  const minCount = toPositiveInt(opts.minCount, DEFAULT_LEARN_OPTIONS.minCount);
  const maxFillers = toPositiveInt(opts.maxFillers, DEFAULT_LEARN_OPTIONS.maxFillers);
  const maxPhrases = toPositiveInt(opts.maxPhrases, DEFAULT_LEARN_OPTIONS.maxPhrases);
  const maxCasing = toPositiveInt(opts.maxCasing, DEFAULT_LEARN_OPTIONS.maxCasing);
  const minPhraseLen = toPositiveInt(opts.minPhraseLen, DEFAULT_LEARN_OPTIONS.minPhraseLen);
  const maxPhraseLen = Math.max(minPhraseLen, toPositiveInt(opts.maxPhraseLen, DEFAULT_LEARN_OPTIONS.maxPhraseLen));
  const minSpacingSamples = toPositiveInt(opts.minSpacingSamples, DEFAULT_LEARN_OPTIONS.minSpacingSamples);

  const entries = normalizeTexts(texts);

  let chars = 0;
  let cjkChars = 0;
  let sentences = 0;
  for (const { text, weight } of entries) {
    chars += text.length * weight;
    cjkChars += countCjk(text) * weight;
    sentences += splitSentences(text).length * weight;
  }

  const fillerCounts = scanFillers(entries);
  const fillerWords = [...fillerCounts.entries()]
    .map(([word, count]) => ({ word, count, tier: FILLER_TIERS[word] }))
    .sort((a, b) => b.count - a.count || b.word.length - a.word.length || cmp(a.word, b.word))
    .slice(0, maxFillers);

  const profile = {
    version: STYLE_VERSION,
    fillerWords,
    sentenceEnders: collectSentenceEnders(entries),
    punctuation: collectPunctuation(entries),
    commonPhrases: collectPhrases(entries, { minCount, maxPhrases, minPhraseLen, maxPhraseLen }),
    spacing: collectSpacing(entries, { minSpacingSamples }),
    casing: collectCasing(entries, { minCount, maxCasing }),
    stats: {
      texts: entries.length,
      chars,
      cjkChars,
      sentences,
      learnedAt: new Date().toISOString(),
    },
    options: { minCount, maxFillers, maxPhrases, maxCasing, minPhraseLen, maxPhraseLen },
  };

  return JSON.parse(JSON.stringify(profile));
}

/* ------------------------------------------------------------------ *
 * applyStyle
 * ------------------------------------------------------------------ */

/** profile 是否「可用」（空/坏 profile 一律原样返回）。 */
function isUsableProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;
  if (profile.version !== STYLE_VERSION) return false;
  const hasFillers = Array.isArray(profile.fillerWords) && profile.fillerWords.length > 0;
  const hasCasing = Array.isArray(profile.casing) && profile.casing.length > 0;
  const sp = profile.spacing;
  const hasSpacing =
    !!sp && (sp.latinNeedsSpace === true || sp.latinNeedsSpace === false || sp.cjkNeedsSpace === true || sp.cjkNeedsSpace === false);
  return hasFillers || hasCasing || hasSpacing;
}

/** 路径/域名/邮箱一类的 token 不参与大小写改写。 */
function isPathLike(text, start, end) {
  const before = start > 0 ? text[start - 1] : undefined;
  const after = end < text.length ? text[end] : undefined;
  if (before !== undefined && '/\\@'.includes(before)) return true;
  if (after !== undefined && '/\\@'.includes(after)) return true;
  // 形如 index.js / 1.2 的成员访问：后面紧跟 '.' 且再后面还是词字符
  if (after === '.' && end + 1 < text.length && isWordChar(text[end + 1])) return true;
  return false;
}

function applyCasing(text, profile, changes, opts) {
  const dict = new Map();
  for (const entry of profile.casing) {
    if (!entry || typeof entry.word !== 'string') continue;
    if (!entry.preferred || typeof entry.preferred !== 'string') continue;
    if (entry.total < opts.casingMinCount) continue;
    dict.set(entry.word, entry.preferred);
  }
  if (dict.size === 0) return text;

  // Forms the glossary owns. A declared spelling outranks a learned habit: see
  // DEFAULT_APPLY_OPTIONS.canonicals for the failure this prevents.
  const owned = opts.canonicals instanceof Set
    ? opts.canonicals
    : new Set(Array.isArray(opts.canonicals) ? opts.canonicals : []);

  LATIN_WORD_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = LATIN_WORD_RE.exec(text)) !== null) {
    const raw = m[0];
    if (raw.length < 2) continue;
    if (owned.has(raw.toLowerCase())) continue;
    if (isPathLike(text, m.index, m.index + raw.length)) continue;
    const preferred = dict.get(raw.toLowerCase());
    if (!preferred || preferred === raw) continue;
    out += text.slice(last, m.index) + preferred;
    last = m.index + raw.length;
    changes.push({ type: 'casing', before: raw, after: preferred, index: m.index });
  }
  return out + text.slice(last);
}

/** 中英边界类型。 */
function boundaryKind(a, b) {
  if (isCjk(a) && isLatin(b)) return 'cjk-latin';
  if (isLatin(a) && isCjk(b)) return 'latin-cjk';
  return 'other';
}

function applySpacing(text, profile, changes, opts) {
  const sp = profile.spacing;
  if (!sp) return text;
  const latinNeedsSpace = sp.latinNeedsSpace === true ? true : sp.latinNeedsSpace === false ? false : null;
  const cjkNeedsSpace = sp.cjkNeedsSpace === true ? true : sp.cjkNeedsSpace === false ? false : null;
  if (latinNeedsSpace === null && cjkNeedsSpace === null) return text;

  const needFor = (kind) =>
    kind === 'cjk-latin' ? latinNeedsSpace : kind === 'latin-cjk' ? cjkNeedsSpace : null;

  // 第 1 遍：把「中文 <空白> 英文」的空白按习惯统一（需要空格 -> 单空格；不需要 -> 删掉）
  let stage = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') {
      let j = i;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j += 1;
      const run = text.slice(i, j);
      const left = stage.length ? stage[stage.length - 1] : undefined;
      const right = text[j];
      const need = needFor(boundaryKind(left, right));
      if (need === null) stage += run;
      else if (need) {
        if (run !== ' ') {
          changes.push({ type: 'spacing', before: run, after: ' ', index: i, note: 'normalize' });
          stage += ' ';
        } else stage += run;
      } else {
        changes.push({ type: 'spacing', before: run, after: '', index: i, note: 'remove' });
      }
      i = j;
      continue;
    }
    stage += ch;
    i += 1;
  }

  // 第 2 遍：直接相邻的中英边界按习惯补空格
  let out = '';
  for (let k = 0; k < stage.length; k += 1) {
    const cur = stage[k];
    const prev = out.length ? out[out.length - 1] : undefined;
    const need = needFor(boundaryKind(prev, cur));
    if (need === true) {
      out += ' ';
      changes.push({ type: 'spacing', before: `${prev}${cur}`, after: `${prev} ${cur}`, index: k, note: 'insert' });
    }
    out += cur;
  }
  return out;
}

/**
 * 删除孤立口水词。每次只删一处、重新扫描，保证删除后新暴露的上下文被重新判定
 * （例如「嗯，那个，我觉得」删掉「嗯」之后，「那个」重新变成段首孤立词）。
 */
function applyFillers(text, fillerList, changes, opts) {
  const allowed = new Set();
  for (const item of fillerList) {
    const word = typeof item === 'string' ? item : item && item.word;
    if (typeof word === 'string' && FILLER_TIERS[word]) allowed.add(word);
  }
  if (allowed.size === 0) return text;
  const words = [...allowed].sort(byLengthDesc);

  let s = text;
  let guard = 0;
  const limit = 1000;
  while (guard < limit) {
    guard += 1;
    let hit = null;
    for (let i = 0; i < s.length && !hit; i += 1) {
      for (const w of words) {
        if (!s.startsWith(w, i)) continue;
        const left = i === 0 ? undefined : s[i - 1];
        const right = s[i + w.length];
        const del = fillerDeletionLength(w, left, right);
        if (del > 0) {
          hit = { index: i, word: s.slice(i, i + del) };
          break;
        }
      }
    }
    if (!hit) break;

    const { index, word } = hit;
    let ls = index;
    while (ls > 0 && isSoftSeparator(s[ls - 1])) ls -= 1;
    let re = index + word.length;
    while (re < s.length && isSoftSeparator(s[re])) re += 1;

    const leftRun = s.slice(ls, index);
    const rightRun = s.slice(index + word.length, re);
    const leftBoundary = ls > 0 ? s[ls - 1] : undefined;
    const rightBoundary = re < s.length ? s[re] : undefined;

    let delStart = ls;
    let delEnd = re;
    // 两侧都是「实词 + 停顿 + 口水词 + 停顿 + 实词」时保留右侧停顿，避免把两段内容粘死
    if (leftRun.length && rightRun.length && isWordChar(leftBoundary) && isWordChar(rightBoundary)) {
      delEnd = index + word.length;
    }

    const before = s.slice(delStart, delEnd);
    changes.push({ type: 'filler', before, after: '', word, index: delStart });
    s = s.slice(0, delStart) + s.slice(delEnd);
  }
  return s;
}

/** 收尾清理：折叠重复标点、去掉开头的孤立逗号。 */
function cleanupPunctuation(text, changes) {
  let out = text;
  const dup = /([，,。.！!？?；;：:])\1+/g;
  let m;
  let last = 0;
  let rebuilt = '';
  while ((m = dup.exec(out)) !== null) {
    rebuilt += out.slice(last, m.index) + m[1];
    changes.push({ type: 'punctuation', before: m[0], after: m[1], index: m.index, note: 'collapse' });
    last = m.index + m[0].length;
  }
  if (last > 0) out = rebuilt + out.slice(last);

  const lead = /^[，,、；;：:]+/.exec(out);
  if (lead) {
    changes.push({ type: 'punctuation', before: lead[0], after: '', index: 0, note: 'strip-leading' });
    out = out.slice(lead[0].length);
  }
  return out;
}

/**
 * 把学到的风格应用到一段听写文本上。
 * @param {string} text
 * @param {object|null} profile learnStyle 的产物；null/空/版本不符 -> 原样返回
 * @param {{fillers?:boolean,spacing?:boolean,casing?:boolean,cleanup?:boolean,casingMinCount?:number,fillerList?:any[]}} [options]
 * @returns {{text:string, changes:Array<{type:string,before:string,after:string,index?:number}>}}
 */
export function applyStyle(text, profile, options = {}) {
  if (typeof text !== 'string') throw new TypeError('applyStyle: text 必须是字符串');
  const changes = [];
  if (text.length === 0) return { text, changes };
  if (!isUsableProfile(profile)) return { text, changes };

  const opts = { ...DEFAULT_APPLY_OPTIONS, ...(options || {}) };
  let out = text;

  // 顺序有意为之：先统一书写（大小写），再统一空格，最后删口水词 ——
  // 这样口水词的上下文判定看到的是「最终形态」的文本。
  if (opts.casing) out = applyCasing(out, profile, changes, opts);
  if (opts.spacing) out = applySpacing(out, profile, changes, opts);
  if (opts.fillers) {
    const list = Array.isArray(opts.fillerList) ? opts.fillerList : profile.fillerWords;
    out = applyFillers(out, list, changes, opts);
  }
  if (opts.cleanup) out = cleanupPunctuation(out, changes);

  return { text: out, changes };
}

export default { STYLE_VERSION, learnStyle, applyStyle, isFillerDeletable, fillerDeletionLength };
