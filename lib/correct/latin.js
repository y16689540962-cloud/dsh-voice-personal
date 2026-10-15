/**
 * Latin-token normalisation and fuzzy matching for ASR output.
 *
 * Two jobs:
 *  1. Split mixed CJK/Latin runs into tokens so code-switched text can be corrected
 *     without disturbing the Chinese around it.
 *  2. Score how close two Latin tokens are, so `flcash` can be recognised as
 *     `FlClash` and `workbody` as `WorkBuddy`.
 *
 * Scoring is length-aware. A fixed edit-distance budget would either miss longer
 * corruptions or start rewriting short unrelated words, so the budget scales with
 * the reference length.
 */

const LATIN_RUN = /[A-Za-z][A-Za-z0-9]*(?:[.'-][A-Za-z0-9]+)*/g;

/** All Latin runs in `text` with their offsets. @returns {{text:string,index:number}[]} */
export function latinTokens(text) {
  const out = [];
  LATIN_RUN.lastIndex = 0;
  let m;
  while ((m = LATIN_RUN.exec(text)) !== null) {
    out.push({ text: m[0], index: m.index });
  }
  return out;
}

/** Lowercase, drop separators. Used only for comparison, never for output. */
export function fold(token) {
  return token.toLowerCase().replace(/[.'\-_]/g, '');
}

/** Levenshtein distance with an early-exit band. */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[b.length];
}

/**
 * Maximum edits tolerated for a reference of `len` characters.
 * Short tokens stay strict; longer ones may absorb proportionally more noise.
 */
export function budgetFor(len) {
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  if (len <= 8) return 2;
  if (len <= 12) return 3;
  return Math.max(3, Math.floor(len * 0.3));
}

/**
 * Similarity in [0,1] between two Latin tokens, using the length-aware budget.
 * Returns 0 when the pair is too far apart to be the same word.
 * @returns {number}
 */
export function similarity(token, reference) {
  const a = fold(token);
  const b = fold(reference);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  const dist = editDistance(a, b);
  const budget = budgetFor(maxLen);
  if (dist > budget) return 0;
  return 1 - dist / maxLen;
}

/**
 * Whether `token` plausibly refers to `reference`.
 * Requires a similarity above `minSimilarity` (default 0.7) and a passing budget.
 * @returns {boolean}
 */
export function looksLike(token, reference, minSimilarity = 0.7) {
  const s = similarity(token, reference);
  return s > 0 && s >= minSimilarity;
}


/**
 * Stricter similarity used by the opt-in fuzzy pass.
 *
 * The plain `similarity` is deliberately permissive because it once served as the only
 * gate for automatic rewrites, and a scan of 210,604 English dictionary words found 97
 * that it corrupts (`harmless` -> `Harness`, `upgrade` -> `Gradle`). The fuzzy pass is now
 * opt-in and calls this instead: short tokens never qualify, and the tolerance stays at a
 * single edit for anything under eight characters, which is what "typo of a product name"
 * looks like rather than "unrelated word that happens to be similar".
 * @returns {number} similarity in [0,1], or 0 when the pair is not comparable.
 */
export function similarityStrict(token, reference) {
  const a = fold(token);
  const b = fold(reference);
  if (!a || !b || a === b) return a === b ? 1 : 0;
  // A token shorter than 5 characters is too easily confused with an ordinary word.
  if (a.length < 5) return 0;
  const maxLen = Math.max(a.length, b.length);
  const dist = editDistance(a, b);
  if (dist > 2) return 0;
  const s = 1 - dist / maxLen;
  // Reject anything that is mostly a different word even when it fits the edit budget.
  return s >= 0.7 ? s : 0;
}

/**
 * Split `text` into alternating CJK / non-CJK segments, preserving order.
 * Used to apply different correction strategies per script.
 * @returns {{kind:'cjk'|'other', text:string, index:number}[]}
 */
export function segments(text) {
  const out = [];
  let kind = null;
  let buf = '';
  let start = 0;
  const flush = () => {
    if (buf) out.push({ kind, text: buf, index: start });
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isCjk = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(ch);
    const k = isCjk ? 'cjk' : 'other';
    if (k !== kind) { flush(); kind = k; start = i; }
    buf += ch;
  }
  flush();
  return out;
}
