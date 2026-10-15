/**
 * Personal correction engine for speech recognition output.
 *
 * Fixes the two failure modes the user reported:
 *   1. Domain terms, names and product names come back wrong
 *      (`flcash` -> `FlClash`, `workbody` -> `WorkBuddy`, `哈里斯` -> `Harness`).
 *   2. Code-switched speech degrades when Chinese and Latin mix in one sentence.
 *
 * ## What this engine deliberately does NOT do
 *
 * It does not rewrite Chinese words by homophone. An earlier revision did, and it was
 * unsound: toneless pinyin cannot distinguish 人物 from 任务, 一部 from 异步, 信条 from
 * 心跳, so ordinary sentences were silently rewritten (`人物关系很复杂` became
 * `任务关系很复杂`). Across the pairs that shipped, 160,454 distinct 2-character strings
 * matched — the whole language. No threshold repairs that; the missing information is
 * context. Chinese correction now happens only where the target is a Latin term
 * (`哈里斯` -> `Harness`), which is a far narrower and checkable claim.
 *
 * ## Safety properties, each backed by a test
 *
 *   - **Exact-only by default.** Latin terms match exactly after case folding. The fuzzy
 *     pass is opt-in, because scanning 210,604 English dictionary words found 97 that a
 *     fuzzy pass corrupts (`harmless` -> `Harness`, `upgrade` -> `Gradle`).
 *   - **Protected spans.** URLs, file paths, emails, versions and CLI flags are masked
 *     before any rewriting, so `harness.git` inside a path is never touched.
 *   - **Idempotent.** `correct(correct(x)) === correct(x)`; a canonical form is never
 *     re-expanded.
 *   - **Whitespace-honest.** Indentation and newlines survive, because dictated Python or
 *     YAML must not be reflowed.
 *   - **Fail-open at the call site.** A throw here must not lose a dictation; the plugin
 *     falls back to the raw transcript.
 *
 * Every change is returned in `changes` so the caller can audit, log, or revert.
 */
import { toPinyinArray, isCjk } from './pinyin.js';
import { latinTokens, fold, similarity, similarityStrict, segments } from './latin.js';
import { TERMS, PAIRS, GUARDS } from './glossary.js';

export const CORRECT_VERSION = 2;

/** Defaults; every field is overridable from the plugin's Config. */
export const DEFAULTS = {
  /** Rewrite Chinese mis-hearings of Latin terms (哈里斯 -> Harness). */
  crossScript: true,
  /** Longest CJK span considered for a cross-script match. */
  maxPhraseChars: 8,
  /**
   * Fuzzy Latin matching. Off by default: it is the only pass that can rewrite a word the
   * glossary never listed, and English vocabulary is large enough that it misfires.
   */
  fuzzyTerms: false,
  /** Minimum similarity for a fuzzy rewrite, when enabled. */
  minLatinSimilarity: 0.85,
  /** Required lead over the runner-up, when fuzzy is enabled. */
  fuzzyMargin: 0.15,
  /** `space` (default), `none`, or `preserve`. */
  spacing: 'space',
  /** Rewrite Latin terms to their canonical spelling. */
  canonicalTerms: true,
};

/** Spans that must never be rewritten: URLs, paths, emails, versions, flags, code. */
const PROTECTED = [
  /[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi,                     // scheme://...
  /(?:^|[\s([<"'`])(?:~|\/|\.{1,2}\/)[^\s)\]}>"'`]*/g,  // absolute/relative paths
  /[A-Za-z]:\\[^\s]*/g,                                 // Windows paths
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,                          // emails
  /\bv?\d+(?:\.\d+)+(?:[-+][\w.]+)?\b/g,                // v1.2.3, 1.0
  /--?[a-z][a-z0-9-]*/gi,                               // CLI flags
  /`[^`\n]*`/g,                                         // inline code
  /\b[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|kts|json|jsonl|ya?ml|toml|ini|conf|md|txt|log|html?|css|scss|sh|bash|zsh|ps1|sql|xml|csv|apk|ipa|gradle|lock|git|gitignore|env|dylib|so|dll|exe|onnx|wav|mp3|mp4|png|jpe?g|svg|pdf|docx?|xlsx?|pptx?)\b/gi,
];

/**
 * Mask protected spans behind a private-use sentinel so no later pass can touch them.
 * @returns {{masked:string, restore:(s:string)=>string}}
 */
function maskProtected(text) {
  const spans = [];
  let masked = text;
  for (const re of PROTECTED) {
    masked = masked.replace(re, (m) => {
      const idx = spans.length;
      spans.push(m);
      return `\uE000${idx}\uE001`;
    });
  }
  const restore = (s) => s.replace(/\uE000(\d+)\uE001/g, (_, i) => spans[Number(i)] ?? '');
  return { masked, restore };
}

/** Build the lookup tables once per corrector instance. */
function buildIndexes(terms, pairs) {
  const latinExact = new Map();   // folded form -> canonical (exact matching)
  const fuzzyRefs = [];           // canonical-only, for the opt-in fuzzy pass
  const latinPhrases = [];        // multi-word canonical terms, longest first
  const pinyinCanon = new Map();  // full pinyin key -> Latin canonical

  for (const t of terms) {
    const canonical = t.say;
    latinExact.set(fold(canonical), canonical);
    // Fuzzy references are canonical forms only. Indexing the mis-spellings as well made
    // them extra attractors: `grade` (listed under Gradle) pulled `upgrade` into a rewrite.
    if (!/\s/.test(canonical) && canonical.length >= 5) fuzzyRefs.push(canonical);
    if (/\s/.test(canonical)) latinPhrases.push(canonical);

    for (const h of t.heard ?? []) {
      if (isCjk(h[0])) {
        // Cross-script: a Chinese mis-hearing of a Latin term, e.g. 哈里斯 -> Harness.
        // Three conditions, all required, because a partial match here is exactly how the
        // removed same-script pass caused damage:
        //   - at least 3 characters, so the span is not a common short word;
        //   - every character has a pinyin reading, so a missing table entry cannot
        //     shorten the key and let a 3-char span match a 2-syllable key;
        //   - an exact key match over the whole span.
        const chars = [...h];
        if (chars.length < 3) continue;
        const readings = toPinyinArray(h);
        if (readings.length !== chars.length) continue;
        const key = readings.join('');
        if (key) pinyinCanon.set(key, canonical);
      } else {
        latinExact.set(fold(h), canonical);
        if (/\s/.test(h)) latinPhrases.push(h);
      }
    }
  }

  // Explicit user pairs: exact replacement, applied only when the user opted in by adding
  // one. Same guards as above, so a short entry cannot reintroduce the over-reach.
  for (const p of pairs) {
    if (!p?.heard || !p?.say) continue;
    if (isCjk(p.heard[0])) {
      const chars = [...p.heard];
      const readings = toPinyinArray(p.heard);
      if (chars.length >= 3 && readings.length === chars.length) {
        pinyinCanon.set(readings.join(''), p.say);
      }
    } else {
      latinExact.set(fold(p.heard), p.say);
    }
  }

  latinPhrases.sort((a, b) => b.length - a.length);
  return { latinExact, fuzzyRefs, latinPhrases, pinyinCanon };
}

/** Escape a string for use inside a RegExp. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rewrite multi-word Latin phrases before single-token handling.
 * `deep seek` must be caught as one unit; tokenising first would leave `deep` and `seek`
 * unmatched and produce a half-corrected result.
 * @returns {{text:string, changes:object[]}}
 */
function fixLatinPhrases(text, idx, opts) {
  const changes = [];
  let out = text;
  for (const phrase of idx.latinPhrases) {
    const canonical = idx.latinExact.get(fold(phrase)) ?? phrase;
    const words = phrase.split(/\s+/).map(esc);
    const re = new RegExp(`(?<![A-Za-z0-9])${words.join('[ \\t]+')}(?![A-Za-z0-9])`, 'gi');
    out = out.replace(re, (m) => {
      // Never re-expand a canonical form: that is what made the output grow per pass.
      if (fold(m) === fold(canonical)) return m;
      changes.push({ type: 'latin-phrase', before: m, after: canonical, reason: 'phrase' });
      return canonical;
    });
  }
  return { text: out, changes };
}

/**
 * Rewrite Latin tokens to their canonical form.
 * @returns {{text:string, changes:object[]}}
 */
function fixLatin(text, idx, opts) {
  const changes = [];
  const tokens = latinTokens(text);
  if (!tokens.length) return { text, changes };

  let out = '';
  let cursor = 0;
  for (const tok of tokens) {
    out += text.slice(cursor, tok.index);
    cursor = tok.index + tok.text.length;

    let replacement = null;
    let reason = null;
    const folded = fold(tok.text);
    const exact = idx.latinExact.get(folded);

    if (exact) {
      // Already canonical? Leave it byte-identical, which is what keeps the pass idempotent.
      replacement = exact === tok.text ? null : exact;
      reason = 'term';
    } else if (opts.fuzzyTerms && folded.length >= 5) {
      let best = null;
      let bestScore = 0;
      let runnerUp = 0;
      for (const ref of idx.fuzzyRefs) {
        const s = similarityStrict(tok.text, ref);
        if (s > bestScore) { runnerUp = bestScore; bestScore = s; best = ref; }
        else if (s > runnerUp) { runnerUp = s; }
      }
      // Require both a floor and a real lead over the runner-up. The earlier version
      // compared the margin against 0 when only one reference scored, so a single weak
      // match passed unconditionally; `runnerUp > 0` is what makes the margin meaningful.
      if (best && bestScore >= opts.minLatinSimilarity
          && runnerUp > 0 && bestScore - runnerUp >= opts.fuzzyMargin) {
        replacement = best;
        reason = 'fuzzy';
      }
    }

    if (replacement && replacement !== tok.text) {
      changes.push({ type: 'latin', before: tok.text, after: replacement, reason, at: tok.index });
      out += replacement;
    } else {
      out += tok.text;
    }
  }
  out += text.slice(cursor);
  return { text: out, changes };
}

/**
 * Rewrite a Chinese mis-hearing of a Latin term (`哈里斯` -> `Harness`).
 *
 * Greedy longest-match over CJK runs. A span qualifies only when its complete pinyin
 * reading is available and matches a known key exactly. No same-script rewriting occurs.
 * @returns {{text:string, changes:object[]}}
 */
function fixCrossScript(text, idx, opts) {
  const changes = [];
  if (!idx.pinyinCanon.size) return { text, changes };

  const chars = [...text];
  let out = '';
  let i = 0;
  while (i < chars.length) {
    if (!isCjk(chars[i])) { out += chars[i]; i++; continue; }

    let matched = false;
    const maxL = Math.min(opts.maxPhraseChars, chars.length - i);
    for (let L = maxL; L >= 3; L--) {
      const span = chars.slice(i, i + L);
      if (!span.every(isCjk)) continue;
      const raw = span.join('');
      const readings = toPinyinArray(raw);
      // A shortened reading means the table lacks a character in this span; treating it as
      // a match would let the span collapse onto a shorter key.
      if (readings.length !== L) continue;
      const canonical = idx.pinyinCanon.get(readings.join(''));
      if (!canonical) continue;
      changes.push({ type: 'cross-script', before: raw, after: canonical, reason: readings.join(''), at: i });
      out += canonical;
      i += L;
      matched = true;
      break;
    }
    if (!matched) { out += chars[i]; i++; }
  }
  return { text: out, changes };
}

/**
 * Normalise spacing around script boundaries.
 * `space` inserts one space between CJK and Latin runs, `none` removes it.
 * @returns {{text:string, changes:object[]}}
 */
function fixSpacing(text, opts) {
  const changes = [];
  if (opts.spacing === 'preserve') return { text, changes };

  const before = text;
  let out;
  if (opts.spacing === 'space') {
    out = text
      .replace(/([\u3400-\u4dbf\u4e00-\u9fff])([A-Za-z])/g, '$1 $2')
      .replace(/([A-Za-z0-9])([\u3400-\u4dbf\u4e00-\u9fff])/g, '$1 $2');
  } else {
    out = text
      .replace(/([\u3400-\u4dbf\u4e00-\u9fff])[ \t]+([A-Za-z])/g, '$1$2')
      .replace(/([A-Za-z0-9])[ \t]+([\u3400-\u4dbf\u4e00-\u9fff])/g, '$1$2');
  }
  if (out !== before) changes.push({ type: 'spacing', before, after: out, reason: opts.spacing });
  return { text: out, changes };
}

/**
 * Collapse redundant horizontal whitespace **without touching indentation**.
 *
 * Leading whitespace is line structure: a dictated Python block or YAML document loses its
 * meaning if reflowed, so runs at the start of a line are preserved verbatim.
 */
function tidy(text) {
  const lines = text.split('\n').map((line) => {
    const m = line.match(/^[ \t]*/);
    const indent = m ? m[0] : '';
    const rest = line.slice(indent.length);
    return indent + rest.replace(/[ \t]{2,}/g, ' ');
  });
  return lines
    .join('\n')
    .replace(/[ \t]+([，。！？、；：）】」』])/g, '$1')
    .replace(/([（【「『])[ \t]+/g, '$1')
    .replace(/^[\s]+|[\s]+$/g, '');
}

/**
 * A configured corrector.
 * @param {{terms?:object[], pairs?:object[], options?:object, applyStyle?:Function, style?:object}} config
 */
export function createCorrector(config = {}) {
  const opts = { ...DEFAULTS, ...(config.options ?? {}) };
  const idx = buildIndexes(config.terms ?? TERMS, config.pairs ?? PAIRS);

  return {
    options: opts,
    /**
     * Correct one transcript.
     * @param {string} text
     * @param {{style?:object|null}} [ctx]
     * @returns {{text:string, changes:object[]}}
     */
    correct(text, ctx = {}) {
      // Coerce defensively: a provider may hand back a non-string on failure, and the
      // contract downstream requires a string.
      if (typeof text !== 'string') {
        return { text: text === null || text === undefined ? '' : String(text), changes: [] };
      }
      if (!text) return { text: '', changes: [] };

      const changes = [];
      // Protected spans are masked for the whole rewriting phase and restored afterwards,
      // so paths, URLs and code are never touched by any pass.
      const { masked, restore } = maskProtected(text);
      let cur = masked;

      if (opts.canonicalTerms) {
        const phr = fixLatinPhrases(cur, idx, opts);
        cur = phr.text; changes.push(...phr.changes);

        const lat = fixLatin(cur, idx, opts);
        cur = lat.text; changes.push(...lat.changes);
      }

      if (opts.crossScript) {
        const cs = fixCrossScript(cur, idx, opts);
        cur = cs.text; changes.push(...cs.changes);
      }

      const sp = fixSpacing(cur, opts);
      cur = sp.text; changes.push(...sp.changes);

      const cleaned = tidy(cur);
      if (cleaned !== cur) {
        changes.push({ type: 'tidy', before: cur, after: cleaned, reason: 'whitespace' });
        cur = cleaned;
      }

      cur = restore(cur);

      // Style runs last so it sees canonical terms, and on restored text because it reasons
      // about real content rather than sentinels.
      const styleProfile = ctx.style ?? config.style ?? null;
      if (styleProfile && typeof config.applyStyle === 'function') {
        const styled = config.applyStyle(cur, styleProfile);
        if (styled && styled.text !== cur) {
          changes.push(...(styled.changes ?? []));
          cur = styled.text;
        }
      }

      return { text: cur, changes };
    },
    /** Exposed for tests and diagnostics. */
    indexes: idx,
  };
}

export { TERMS, PAIRS, GUARDS };
export { toPinyinArray, latinTokens, fold, similarity, similarityStrict, segments };
