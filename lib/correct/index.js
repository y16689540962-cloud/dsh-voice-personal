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

export const CORRECT_VERSION = 3;

/** Defaults; every field is overridable from the plugin's Config. */
export const DEFAULTS = {
  /** Rewrite Chinese mis-hearings of Latin terms (哈里斯 -> Harness). */
  crossScript: true,
  /** Longest CJK span considered for a cross-script match. */
  maxPhraseChars: 8,
  // There is no fuzzy-matching option. One shipped and an audit measured it inert; see the
  // comment in `fixLatin` for the numbers. A switch that does nothing is a lie in the docs.
  /** `space` (default), `none`, or `preserve`. */
  spacing: 'space',
  /** Rewrite Latin terms to their canonical spelling. */
  canonicalTerms: true,
};

/** Spans that must never be rewritten: URLs, paths, emails, versions, flags, code. */
const PROTECTED = [
  /[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi,                     // scheme://...
  // A path starts at `~`, `/` or `./` **not preceded by a letter or digit**. Stated as a
  // negative lookbehind rather than a list of allowed delimiters, because the list is
  // unbounded and every miss corrupts a path: a dictated `看/Users/x/y` (Chinese, no space),
  // an `@/Users/x/y` reference, and a `工作目录：/Users/x/y` (full-width colon) all slipped
  // through a leading-character class, and each one came back with a segment renamed.
  // `10/16` is still safe: there the `/` follows a digit, so the lookbehind fails.
  /(?<![\w])(?:~|\/|\.{1,2}\/)[^\s)\]}>"'`]*/g,         // paths
  /[A-Za-z]:\\[^\s]*/g,                                 // Windows paths
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,                          // emails
  /\bv?\d+(?:\.\d+)+(?:[-+][\w.]+)?\b/g,                // v1.2.3, 1.0
  /--?[a-z][a-z0-9-]*/gi,                               // CLI flags
  /`[^`\n]*`/g,                                         // inline code
  /\b[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|kts|json|jsonl|ya?ml|toml|ini|conf|md|txt|log|html?|css|scss|sh|bash|zsh|ps1|sql|xml|csv|apk|ipa|gradle|lock|git|gitignore|env|dylib|so|dll|exe|onnx|wav|mp3|mp4|png|jpe?g|svg|pdf|docx?|xlsx?|pptx?)\b/gi,
];

/**
 * Mask protected spans behind a private-use sentinel so no later pass can touch them.
 *
 * Restoring must iterate to a fixed point, because the rules nest. They are applied in
 * order, and a later rule can swallow a sentinel an earlier one inserted — rule 8 (inline
 * code) matches `` ` `` … `` ` `` with a character class that happily eats sentinels. Masked
 * text is `\uE0007\uE001` where `spans[7]` is itself `` `\uE0000\uE001` ``; a single
 * `String.replace` does not rescan what it inserted, so the inner sentinel survived into the
 * output as an invisible private-use character, with an empty `changes` list. The user sees
 * corrupted text, and the audit trail says nothing happened.
 *
 * Termination is guaranteed rather than hoped for: masking runs in order, so the text
 * captured by rule *r* can only contain sentinels with index < r. Replacing any sentinel
 * therefore lowers the highest index present, and at most one pass per rule is needed.
 * A caller-visible cap enforces that even if a future rule breaks the invariant.
 *
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

  const SENTINEL = /\uE000(\d+)\uE001/g;
  const restore = (s) => {
    let out = s;
    for (let pass = 0; pass <= PROTECTED.length; pass++) {
      const next = out.replace(SENTINEL, (_, i) => spans[Number(i)] ?? '');
      if (next === out) return out;
      out = next;
    }
    // Unreachable while the ordering invariant holds. Returning `out` rather than stripping
    // keeps the leftover visible in tests instead of silently deleting the user's text.
    return out;
  };
  return { masked, restore };
}

/** Build the lookup tables once per corrector instance. */
function buildIndexes(terms) {
  const latinExact = new Map();   // folded form -> canonical (exact matching)
  const latinPhrases = [];        // multi-word canonical terms, longest first
  const pinyinCanon = new Map();  // full pinyin key -> Latin canonical

  for (const t of terms) {
    const canonical = t.say;
    latinExact.set(fold(canonical), canonical);
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

  latinPhrases.sort((a, b) => b.length - a.length);
  return { latinExact, latinPhrases, pinyinCanon };
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
      // Never re-expand a canonical form, or the output grows on every pass. The test is
      // byte equality, not case-folded equality: `cocos creator` is not yet canonical and
      // must be fixed, while `Cocos Creator` is and must be left alone. Folded comparison
      // conflated the two and silently skipped every lower-cased occurrence.
      if (m === canonical) return m;
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

    // Never rewrite part of an identifier. `LATIN_RUN` stops at `_`, so `agent_id` is seen as
    // `agent` plus `id`, and case-normalising the first half turns a working identifier into a
    // broken one (`agent_id` -> `Agent_id`). An underscore on either side means we are looking
    // at a fragment of something larger, not at a word.
    const before = tok.index > 0 ? text[tok.index - 1] : '';
    const after = text[tok.index + tok.text.length] ?? '';
    if (before === '_' || after === '_') {
      out += tok.text;
      continue;
    }

    let replacement = null;
    let reason = null;
    const folded = fold(tok.text);
    const exact = idx.latinExact.get(folded);

    if (exact) {
      // Already canonical? Leave it byte-identical, which is what keeps the pass idempotent.
      replacement = exact === tok.text ? null : exact;
      reason = 'term';
    }

    // There is deliberately no fuzzy fallback here.
    //
    // One existed, guarded by a `fuzzyTerms` switch. An adversarial audit measured that the
    // switch did nothing: across 6,748 single-edit variants of real terms it changed only the
    // two the exact channel had already caught, and 40,000 dictionary words produced zero
    // difference with it on or off. The guards that made it safe are what made it inert —
    // requiring a real runner-up (`runnerUp > 0`) means a typo that resembles exactly one
    // term can never fire, and raising the floor to 0.85 disqualifies the rest.
    //
    // An option that silently does nothing is worse than no option: the user turns on "fuzzy
    // matching", believes typos are now covered, and nothing changes. So the switch is gone
    // rather than left as decoration. If fuzzy matching is ever wanted, it needs a design that
    // can beat the exact channel on a measured corpus first — the bar the old one never met.

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
 * Term-list hygiene.
 *
 * Every consumer of this engine — the DSH plugin reading a user's file, the standalone
 * `asr-personal-dictionary` package, the tests — has to answer the same questions about a
 * term list before trusting it. Answering them in one place is the difference between one
 * set of checks and three drifting ones.
 *
 * The two error classes below are the ones that have actually caused damage in this
 * engine's history, and both are decidable from the term list alone:
 *
 *   - A mis-hearing that is another term's canonical spelling (`heard: ['cloud']` under
 *     Claude while `Cloud` is also a term) rewrites every real occurrence of that other
 *     term. The shipping layer had exactly this with `grade` under `Gradle`.
 *   - A mis-hearing that is a substring of its own multi-word canonical form (`cocos`
 *     under `Cocos Creator`) makes the phrase pass and the token pass feed each other, so
 *     the output grows on every pass. Measured at 705 hits across 4,000 fuzzed strings.
 */

/**
 * Coerce one entry to `{ say, heard }`.
 * @param {string|{say:string, heard?:string[]}} input
 * @param {number} [index] for error messages
 * @returns {{say:string, heard:string[]}}
 */
export function normalizeTerm(input, index = 0) {
  if (typeof input === 'string') {
    if (!input.trim()) throw new TypeError(`terms[${index}]: empty string`);
    return { say: input, heard: [] };
  }
  if (input && typeof input === 'object' && typeof input.say === 'string' && input.say.trim()) {
    const heard = input.heard ?? [];
    if (!Array.isArray(heard) || heard.some((h) => typeof h !== 'string' || !h.trim())) {
      throw new TypeError(`terms[${index}] (${input.say}): heard must be an array of non-empty strings`);
    }
    return { say: input.say, heard: [...heard] };
  }
  throw new TypeError(`terms[${index}]: expected a string or { say, heard? }, got ${JSON.stringify(input)}`);
}

/**
 * Coerce a whole list. Throws on structurally malformed input — that is a programming
 * error and should be loud. Semantic conflicts are handled by {@link checkTerms} instead,
 * because those are a user's data-entry mistake and must degrade rather than throw.
 * @param {unknown} input
 * @returns {{say:string, heard:string[]}[]}
 */
export function normalizeTerms(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new TypeError('terms must be an array of strings or { say, heard? } objects');
  }
  return input.map((t, i) => normalizeTerm(t, i));
}

/**
 * Collapse entries that share a canonical spelling into one, unioning their mis-hearings.
 * Two entries for `DeepSeek` split the index and make conflict reporting wrong.
 * @returns {{say:string, heard:string[]}[]}
 */
export function mergeTerms(terms) {
  const byCanonical = new Map();
  for (const t of terms) {
    const existing = byCanonical.get(t.say);
    if (!existing) {
      byCanonical.set(t.say, { say: t.say, heard: [...t.heard] });
      continue;
    }
    for (const h of t.heard) if (!existing.heard.includes(h)) existing.heard.push(h);
  }
  return [...byCanonical.values()];
}

/**
 * Every semantic problem in a normalised term list, with enough detail for a caller to act
 * on it entry by entry.
 * @param {{say:string, heard:string[]}[]} terms
 * @returns {{severity:'error'|'warning', index:number, term:string, heard:string|null, message:string}[]}
 */
export function checkTerms(terms) {
  const issues = [];
  const canonicalByFold = new Map();
  for (const t of terms) canonicalByFold.set(fold(t.say), t.say);

  const heardOwner = new Map();
  const seenCanonical = new Set();

  for (const [index, t] of terms.entries()) {
    if (seenCanonical.has(t.say)) {
      issues.push({
        severity: 'warning', index, term: t.say, heard: null,
        message: `"${t.say}" is listed more than once; the entries are merged.`,
      });
    }
    seenCanonical.add(t.say);

    const canonicalFold = fold(t.say);
    for (const h of t.heard) {
      const hFold = fold(h);

      const other = canonicalByFold.get(hFold);
      if (other && other !== t.say) {
        issues.push({
          severity: 'error', index, term: t.say, heard: h,
          message: `"${h}" is listed as a mis-hearing of "${t.say}" but is the canonical `
            + `spelling of "${other}" — that would rewrite every real occurrence of "${other}".`,
        });
      }

      const prev = heardOwner.get(hFold);
      if (prev && prev !== t.say) {
        issues.push({
          severity: 'error', index, term: t.say, heard: h,
          message: `"${h}" is claimed by both "${prev}" and "${t.say}"; only one can win.`,
        });
      }
      heardOwner.set(hFold, t.say);

      if (/\s/.test(t.say) && hFold !== canonicalFold && canonicalFold.includes(hFold)) {
        issues.push({
          severity: 'error', index, term: t.say, heard: h,
          message: `"${h}" is a substring of its own canonical form "${t.say}", which made `
            + 'the output grow on every pass. List the full phrase instead.',
        });
      } else if (!/\s/.test(t.say) && hFold !== canonicalFold && canonicalFold.startsWith(hFold)) {
        issues.push({
          severity: 'warning', index, term: t.say, heard: h,
          message: `"${h}" is a prefix of "${t.say}"; short forms like this tend to match `
            + 'ordinary words. Consider requiring the full spelling.',
        });
      }
    }
  }
  // ── cross-entry checks ──
  // The per-entry loop above cannot see collisions between two entries. Each of these has
  // been observed to make a user's explicitly-written term silently lose to another one.
  const canonicalOwner = new Map(); // folded canonical -> first spelling seen
  const pinyinOwner = new Map();    // cross-script pinyin key -> canonical

  for (const [index, t] of terms.entries()) {
    const canonicalFold = fold(t.say);

    const firstSpelling = canonicalOwner.get(canonicalFold);
    if (firstSpelling !== undefined && firstSpelling !== t.say) {
      issues.push({
        severity: 'error', index, term: t.say, heard: null,
        message: `"${t.say}" and "${firstSpelling}" are the same term spelled two ways; the `
          + 'last one silently wins. Keep one.',
      });
    } else if (firstSpelling === undefined) {
      canonicalOwner.set(canonicalFold, t.say);
    }

    for (const h of t.heard) {
      if (!isCjk(h[0])) continue;
      const chars = [...h];
      if (chars.length < 3) continue;
      const readings = toPinyinArray(h);
      if (readings.length !== chars.length) continue;
      const key = readings.join('');
      if (!key) continue;
      const prev = pinyinOwner.get(key);
      if (prev && prev !== t.say) {
        issues.push({
          severity: 'error', index, term: t.say, heard: h,
          message: `"${h}" and a mis-hearing listed under "${prev}" share the pinyin key `
            + `"${key}"; only one of them can ever match.`,
        });
      }
      pinyinOwner.set(key, t.say);
    }
  }

  return issues;
}

/** Convenience view of {@link checkTerms} for callers that only need strings. */
export function validateTerms(terms) {
  const issues = checkTerms(terms);
  return {
    errors: issues.filter((i) => i.severity === 'error').map((i) => i.message),
    warnings: issues.filter((i) => i.severity === 'warning').map((i) => i.message),
  };
}

/**
 * Drop whatever cannot be trusted, keeping everything else.
 *
 * This is the plugin's path: a user's hand-edited file must never crash a plugin or make
 * it rewrite text wrongly, but one bad line should also not cost them their other forty
 * good ones. Only the offending mis-hearing form is removed, not the whole entry.
 *
 * @returns {{terms:object[], issues:object[], dropped:string[]}}
 */
export function partitionTerms(terms) {
  const issues = checkTerms(terms);
  const strip = new Map(); // index -> Set(heard form to remove)
  const dropped = [];

  for (const issue of issues) {
    if (issue.severity !== 'error' || issue.heard === null) continue;
    if (!strip.has(issue.index)) strip.set(issue.index, new Set());
    strip.get(issue.index).add(issue.heard);
    dropped.push(`${issue.term} ← ${issue.heard}`);
  }

  // An entry whose mis-hearings were all stripped is still worth keeping: the canonical
  // spelling alone still normalises casing (`dsh` -> `DSH`), which is half the value.
  const kept = terms.map((t, index) => {
    const remove = strip.get(index);
    if (!remove) return { say: t.say, heard: [...t.heard] };
    return { say: t.say, heard: t.heard.filter((h) => !remove.has(h)) };
  });

  return { terms: kept, issues, dropped };
}

/**
 * A configured corrector.
 * @param {{terms?:object[], pairs?:object[], options?:object, applyStyle?:Function, style?:object}} config
 */
export function createCorrector(config = {}) {
  const opts = { ...DEFAULTS, ...(config.options ?? {}) };

  // `pairs` is not a separate concept. `{ heard: 'x', say: 'Y' }` is exactly
  // `{ say: 'Y', heard: ['x'] }`, so fold it into the term list and run the whole thing
  // through the same guards.
  //
  // It used to go straight into the index and skip every check, which meant a hand-written
  // `{"heard":"cocos","say":"Cocos Creator"}` in a user's terms file reproduced the
  // **unbounded growth** this engine had already fixed once: the token pass expanded
  // `Cocos` inside the phrase pass's own output, 13 → 21 → 29 → 45 characters per pass.
  // A parallel path with no guard is how a fixed defect comes back.
  const fromPairs = (config.pairs ?? PAIRS)
    .filter((p) => p && typeof p.heard === 'string' && typeof p.say === 'string')
    .map((p) => ({ say: p.say, heard: [p.heard] }));

  const combined = mergeTerms([...normalizeTerms(config.terms ?? TERMS), ...fromPairs]);
  // Guards run here rather than only at the call site, so no configuration shape can reach
  // the index unchecked. Offending *forms* are dropped, not whole entries, and what was
  // dropped is returned so a caller can surface it.
  const { terms, issues, dropped } = partitionTerms(combined);
  const idx = buildIndexes(terms);

  return {
    options: opts,
    /** Mis-hearing forms refused by the guards, for the caller to log. */
    dropped,
    /** Every warning and error the guards raised, with severity. */
    issues,
    /** The term list actually indexed, after merging and guards. */
    terms,
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