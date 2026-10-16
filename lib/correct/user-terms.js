/**
 * The user's own terms, loaded from a data file rather than from source.
 *
 * ## Why this module exists
 *
 * The glossary used to live only in `glossary.js`, so adding a word meant editing a file
 * inside the installed package and restarting DSH. That is bad on three counts:
 *
 *   1. The package is installed through `pnpm file:`, which **hard-links** the source tree
 *      into the profile. Most editors write a temp file and rename, which breaks the link —
 *      so the edit lands in the source copy while DSH keeps loading the old one. The user
 *      sees "I added my word and it still gets it wrong" with nothing to point at.
 *   2. An application upgrade replaces the package directory and takes the glossary with it.
 *   3. Restarting to add one word makes the feature not worth using.
 *
 * So user terms live in `<dataDir>/terms.json`, which upgrades do not touch, and this
 * loader re-reads it when it changes. Adding a term takes effect on the next dictation.
 *
 * ## Design rules
 *
 *   - **Never throw.** A dictation must not be lost because a JSON file is mid-edit. Every
 *     failure path degrades to "no user terms" or "the last good set" and logs once.
 *   - **Never trust silently.** Conflicts are dropped via the engine's `partitionTerms`,
 *     and what was dropped is reported, so a mistake is visible instead of quietly
 *     rewriting the user's text.
 *   - **Keep the last good set.** A broken file at 3am should not empty the glossary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeTerms, mergeTerms, partitionTerms, fold } from './index.js';

/** File name inside the plugin's data directory. */
export const USER_TERMS_FILE = 'terms.json';

/**
 * Cache key reported when the file does not exist. A NUL prefix keeps it impossible to
 * collide with real file content, so "no file" and "empty file" are distinguishable.
 */
export const ABSENT_KEY = '\u0000absent';

/** The shape written by `scripts/terms.mjs` and accepted by the loader. */
export function emptyDocument() {
  return { version: 1, terms: [], pairs: [] };
}

const EMPTY = Object.freeze({
  exists: false, terms: [], pairs: [], issues: [], dropped: [], error: null, version: 0,
});
/**
 * Accept both shapes a human might write:
 *   `["DSH", { "say": "FlClash", "heard": ["flcash"] }]`
 *   `{ "version": 1, "terms": [...], "pairs": [...] }`
 * Anything else is a reportable error, not a crash.
 */
function parseDocument(raw) {
  const data = JSON.parse(raw);
  if (Array.isArray(data)) return { terms: data, pairs: [] };
  if (data && typeof data === 'object') {
    return { terms: data.terms ?? [], pairs: data.pairs ?? [] };
  }
  throw new TypeError('顶层必须是数组，或 { terms: [...], pairs: [...] } 对象');
}

/**
 * @param {{dir?:string, file?:string, logger?:object}} options
 * @returns {{path:string, load:()=>object, invalidate:()=>void, write:(doc:object)=>void}}
 */
export function createUserTermsLoader({ dir = '', file = USER_TERMS_FILE, logger } = {}) {
  const full = path.isAbsolute(file) ? file : path.join(dir || '.', file);
  const warn = (message) => logger?.warn?.(`[voice-personal] 用户词库：${message}`);

  /** Last successfully parsed result, kept so a broken file cannot empty the glossary. */
  let lastGood = { terms: [], pairs: [] };
  let cache = null;         // { key, result }
  let warnedFor = null;     // file content we have already complained about

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (error) {
      // ENOENT means "no user terms yet" — empty is correct, and the shipped glossary applies.
      // Anything else (EACCES, EISDIR, EIO) is a *fault*, and returning empty would silently
      // drop terms the user had already added and that worked a moment ago. Keep the last good
      // set instead; the warning explains why nothing new is taking effect.
      if (error?.code === 'ENOENT') return { ...EMPTY, key: ABSENT_KEY, path: full };
      warn(`无法读取 ${full}（${error?.code ?? error?.message}），暂时沿用上一次可用的 `
        + `${lastGood.terms.length} 条词条`);
      return {
        exists: true,
        key: `\u0000unreadable:${error?.code ?? 'error'}`,
        terms: lastGood.terms,
        pairs: lastGood.pairs,
        issues: [], dropped: [],
        error: String(error?.message ?? error),
        path: full,
        version: lastGood.terms.length,
      };
    }

    // The cache key is the file's **content**, not its mtime and size. `mtimeMs:size` is the
    // cheap option and it has a real failure mode: two edits of the same byte length inside
    // one millisecond produce an identical key, the cache is not invalidated, and the user's
    // change silently does nothing. A few kilobytes read per dictation costs microseconds
    // and removes the whole failure class.
    if (cache && cache.key === raw) return cache.result;
    const key = raw;

    try {
      const parsed = parseDocument(raw);
      if (!Array.isArray(parsed.terms)) throw new TypeError('terms 必须是数组');
      if (!Array.isArray(parsed.pairs)) throw new TypeError('pairs 必须是数组');

      const { terms, issues, dropped } = partitionTerms(mergeTerms(normalizeTerms(parsed.terms)));
      if (dropped.length) {
        warn(`以下条目会改坏正确的文本，已跳过：${dropped.join('；')}`);
      }
      for (const issue of issues) {
        if (issue.severity === 'warning') warn(issue.message);
      }
      lastGood = { terms, pairs: parsed.pairs };
      const result = {
        exists: true, key, terms, pairs: parsed.pairs, issues, dropped, error: null,
        path: full, version: terms.length,
      };
      cache = { key, result };
      warnedFor = null;
      return result;
    } catch (error) {
      // Report once per distinct file state, not once per dictation.
      if (warnedFor !== key) {
        warnedFor = key;
        warn(`${full} 解析失败，暂时沿用上一次可用的 ${lastGood.terms.length} 条词条：`
          + `${error?.message ?? error}`);
      }
      const result = {
        exists: true, key, terms: lastGood.terms, pairs: lastGood.pairs,
        issues: [], dropped: [], error: String(error?.message ?? error),
        path: full, version: lastGood.terms.length,
      };
      cache = { key, result };
      return result;
    }
  }

  return {
    path: full,
    load,
    /** Forget the cache; the next `load()` re-reads unconditionally. */
    invalidate() { cache = null; },
    /** Replace the file atomically. Used by `scripts/terms.mjs`. */
    write(doc) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const tmp = `${full}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
      fs.renameSync(tmp, full);
      cache = null;
    },
  };
}

/**
 * Merge the shipped glossary with the user's own terms.
 *
 * The rules exist to make one thing true: **adding a user term must never silently remove
 * something that used to work.** The obvious implementation — "user terms replace built-in
 * terms with the same spelling" — fails that. A user who adds `Harness` to record one more
 * mis-hearing would silently lose the shipped `哈内斯` mapping, and the only symptom would
 * be that a word that used to be corrected stopped being corrected.
 *
 * So:
 *   - same canonical spelling → **union** the mis-hearings; the user's own mapping wins
 *     where the two disagree on the same form;
 *   - a built-in mis-hearing the user has **re-pointed at a different term** → strip that
 *     one form and report it. Dropping the whole entry would take `github` and `gihub` down
 *     with the `ghub` the user re-tasked;
 *   - re-declaring a shipped mapping with the **same** target is agreement, not shadowing,
 *     and stays silent — a warning that fires on correct input teaches the user to ignore
 *     warnings;
 *   - a built-in canonical the user has redefined → the user's definition wins, and the
 *     remaining built-in mis-hearings are folded in.
 *
 * @param {{say:string,heard:string[]}[]} builtin
 * @param {{say:string,heard:string[]}[]} user
 * @returns {{terms:object[], shadowed:{say:string, forms:string[]}[]}}
 */
export function mergeWithUserTerms(builtin, user) {
  const out = user.map((t) => ({ say: t.say, heard: [...t.heard] }));
  const byCanonical = new Map(out.map((t) => [t.say, t]));

  /** folded mis-hearing form -> the canonical the user pointed it at */
  const userOwner = new Map();
  for (const t of user) {
    for (const h of t.heard) userOwner.set(fold(h), t.say);
  }

  const shadowed = [];
  for (const t of builtin) {
    // Only a form the user pointed somewhere *else* counts as shadowing. Re-declaring a
    // shipped mapping with the same target is agreement, and warning about it would train
    // the user to ignore the warning.
    const claimed = t.heard.filter((h) => {
      const owner = userOwner.get(fold(h));
      return owner !== undefined && owner !== t.say;
    });
    const repointed = new Set(claimed.map((h) => fold(h)));
    const kept = t.heard.filter((h) => !repointed.has(fold(h)));
    if (claimed.length) shadowed.push({ say: t.say, forms: claimed });

    const existing = byCanonical.get(t.say);
    if (existing) {
      for (const h of kept) if (!existing.heard.includes(h)) existing.heard.push(h);
      continue;
    }
    const copy = { say: t.say, heard: kept };
    out.push(copy);
    byCanonical.set(copy.say, copy);
  }

  return { terms: mergeTerms(out), shadowed };
}
