/**
 * dsh-voice-personal / lib/style / lexicon.js
 *
 * 风格学习模块的「词表 + 字符判定」层。
 * 纯数据 + 纯函数，无副作用、无外部依赖、不联网。
 *
 * 注意：这里的口水词候选表是**有界词表**，不是「无词典自动发现」。
 * 频次/上下文一律来自用户语料的真实统计（见 index.js）。
 */

/** CJK 统一表意文字（含扩展 A、兼容表意文字）。 */
export const CJK_RANGES = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';

/** 单个 CJK 字符。注意：不要加 g 标志（避免 lastIndex 状态污染）。 */
export const CJK_RE = new RegExp(`[${CJK_RANGES}]`);

/** 单个拉丁字母 / 数字（统称「英文侧」，含数字，用于中英文空格统计）。 */
export const LATIN_RE = /[A-Za-z0-9]/;

/** 英文词（casing 统计与改写用）。含撇号/连字符/下划线，避免把 "dsh-voice" 拆开。 */
export const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9'’_-]*/g;

/** 连续 CJK 片段（n-gram 只在 CJK 连续段内取，避免跨越标点/英文）。 */
export const CJK_RUN_RE = new RegExp(`[${CJK_RANGES}]+`, 'g');

/** 软分隔符：删掉口水词后连带的「多余停顿标点」。 */
export const SOFT_SEPARATORS = new Set(['，', ',', '、', '；', ';', '：', ':', ' ', '\t']);

/** 硬句末标点。 */
export const HARD_ENDERS = new Set(['。', '！', '？', '!', '?', '…', '~', '～']);

/** 被视为「句子终止」的标点（用于切句）。 */
export const SENTENCE_BREAKS = new Set(['。', '！', '？', '!', '?', '…', '~', '～', '；', ';']);

export const isCjk = (ch) => ch !== undefined && CJK_RE.test(ch);
export const isLatin = (ch) => ch !== undefined && LATIN_RE.test(ch);
export const isWordChar = (ch) => isCjk(ch) || isLatin(ch);
/** 分隔符 = 既不是 CJK 也不是拉丁字母/数字（标点、空白、换行、emoji…）。 */
export const isSeparator = (ch) => ch !== undefined && !isWordChar(ch);
export const isSoftSeparator = (ch) => ch !== undefined && SOFT_SEPARATORS.has(ch);
export const isHardEnder = (ch) => ch !== undefined && HARD_ENDERS.has(ch);
export const isSentenceBreak = (ch) => ch !== undefined && SENTENCE_BREAKS.has(ch);

/**
 * 口水词候选表（词 -> 层级）。
 *
 * 层级 1 = 感叹/语气词：只要求「位于句段开头（左侧是分隔符或文本开头）」即可删除。
 *   理由：嗯/呃/诶 这类字几乎不会作为词素出现在别的词中间。
 * 层级 2 = 语境型：必须**左右两侧都是分隔符**（完全孤立）才允许删除。
 *   理由：就是/那个/这个/然后/其实 在正常句子里是实词或连接词，误删会改语义。
 *
 * 长词优先匹配（见 index.js 的 scanFillers），所以「哎呀」会整体命中，
 * 不会被拆成「哎」+「呀」。
 */
export const FILLER_TIERS = Object.freeze({
  // ---- 层级 1：语气/感叹词 ----
  嗯嗯: 1,
  呃呃: 1,
  嗯哼: 1,
  哎呀: 1,
  啊呀: 1,
  哎哟: 1,
  嗯: 1,
  呃: 1,
  唔: 1,
  诶: 1,
  欸: 1,
  唉: 1,
  哎: 1,
  哦: 1,
  噢: 1,
  咦: 1,
  啊: 1,
  呀: 1,
  哟: 1,
  唷: 1,
  // ---- 层级 2：语境型（必须完全孤立） ----
  就是就是: 2,
  那个那个: 2,
  这个这个: 2,
  就是: 2,
  那个: 2,
  这个: 2,
  然后: 2,
  其实: 2,
  所以说: 2,
  反正: 2,
  就是说: 2,
  也就是说: 2,
  那什么: 2,
  怎么说呢: 2,
  怎么讲: 2,
  你知道吗: 2,
  你知道吧: 2,
  对吧: 2,
  是吧: 2,
  对不对: 2,
  懂吧: 2,
});

/**
 * 白名单：层级 1 的词**右侧粘着实词字符**时，只有命中这里的 2 字组合才允许删除。
 * 这些都是口语叹词本身（啊哈 / 哦豁 / 哎哟…），删掉不影响语义。
 *
 * 不在表里的「叹词 + 实词字符」一律**不删**，因为那是实词的一部分：
 *   唉声叹气、呃逆、唔该（粤语「谢谢」）、啊姨…
 * 这张表故意保持很小、可读、可扩展；宁可漏删，不可错删。
 */
export const GLUED_FILLERS = new Set([
  '啊哈',
  '哦豁',
  '哦哟',
  '啊哟',
  '哎哟',
  '诶呀',
  '哎呀',
]);

/** 句末习惯用词候选（长词优先）。用于 sentenceEnders.words。 */
export const END_PARTICLES = [
  '来着',
  '而已',
  '罢了',
  '的话',
  '吧',
  '呢',
  '了',
  '啊',
  '呀',
  '啦',
  '哦',
  '哟',
  '咯',
  '喔',
  '耶',
  '嘞',
  '哈',
  '诶',
  '欸',
  '的',
];

/** 统计用标点集合（全角 vs 半角对照）。 */
export const PUNCT_MARKS = [
  '，', ',',
  '。', '.',
  '！', '!',
  '？', '?',
  '；', ';',
  '：', ':',
  '、',
  '…',
  '~',
];

export const PUNCT_SET = new Set(PUNCT_MARKS);

/** 半角 -> 全角映射（可选的标点归一化用）。 */
export const HALF_TO_FULL = Object.freeze({
  ',': '，',
  '.': '。',
  '!': '！',
  '?': '？',
  ';': '；',
  ':': '：',
});

/** 按长度降序、同长度按码位升序 —— 保证匹配与输出完全确定。 */
export function byLengthDesc(a, b) {
  if (b.length !== a.length) return b.length - a.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 通用确定序比较器（码位序，不用 locale）。 */
export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
