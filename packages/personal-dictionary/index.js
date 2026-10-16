/**
 * asr-personal-dictionary — your vocabulary, applied to speech-recognition output.
 *
 * Speech recognisers are good at language and bad at *your* language: product names,
 * project names, colleagues, the casing of `GitHub`. A general model has no way to know
 * that this speaker says `flcash` meaning `FlClash`, or that `哈里斯` is an English word.
 *
 * This package is the smallest thing that fixes that: give it your terms, hand it a
 * transcript, get the transcript back with your words spelled your way.
 *
 *   import { createDictionary } from 'asr-personal-dictionary';
 *
 *   const dict = createDictionary({
 *     terms: [
 *       'DSH',                                            // casing only
 *       { say: 'FlClash', heard: ['flcash'] },            // an observed mis-hearing
 *       { say: 'Harness', heard: ['哈里斯', '哈内斯'] },    // a Chinese mis-hearing of a Latin term
 *     ],
 *   });
 *
 *   dict.correct('帮我稳定我现在的flcash');
 *   // '帮我稳定我现在的 FlClash'
 *
 * What it will not do
 * -------------------
 * It never rewrites Chinese to Chinese. An earlier revision of this engine matched by
 * toneless pinyin, which cannot tell 人物 from 任务 or 一部 from 异步; across the pairs that
 * shipped it matched 160,454 distinct two-character strings — the whole language — and
 * silently produced sentences the speaker never said. Matching here is exact, and the only
 * Chinese rewriting allowed is a whole-span transliteration onto a Latin term you listed.
 *
 * It also cannot fix what the recogniser never produced. This is text in, text out: it
 * corrects what arrived, it does not bias the acoustic model. See the README.
 *
 * @see README.md for the safety properties and how to test your own glossary.
 */
import {
  createCorrector,
  DEFAULTS,
  CORRECT_VERSION,
  normalizeTerms,
  mergeTerms,
  validateTerms,
} from './dist/correct/index.js';

export { CORRECT_VERSION, DEFAULTS };

/**
 * Term-list hygiene, re-exported from the engine. Exported because the checks are worth
 * running *before* building a dictionary — in a settings screen, a CI job, or a migration
 * script — and because a caller who wants to report conflicts themselves should not have
 * to catch a constructor throw to find out what they are.
 */
export { validateTerms, normalizeTerms, mergeTerms };

/** Latin-token and pinyin helpers, re-exported for callers who need them. */
export {
  toPinyinArray,
  latinTokens,
  fold,
  similarity,
  similarityStrict,
  segments,
} from './dist/correct/index.js';

/**
 * Build a dictionary.
 *
 * @param {object} [config]
 * @param {(string|{say:string, heard?:string[]})[]} [config.terms] your vocabulary
 * @param {{heard:string, say:string}[]} [config.pairs] explicit literal rewrites
 * @param {object} [config.options] overrides for {@link DEFAULTS}
 * @param {boolean} [config.allowConflicts] downgrade validation errors to warnings
 * @returns {{
 *   correct(text:string):string,
 *   correctWithChanges(text:string):{text:string, changes:object[]},
 *   terms:ReadonlyArray<object>,
 *   options:object,
 *   warnings:string[],
 *   version:number,
 * }}
 */
export function createDictionary(config = {}) {
  const terms = mergeTerms(normalizeTerms(config.terms));
  const { errors, warnings } = validateTerms(terms);

  if (errors.length && !config.allowConflicts) {
    throw new Error(
      `refusing to build a dictionary with ${errors.length} conflicting term(s):\n  `
      + `${errors.join('\n  ')}\n`
      + 'Pass { allowConflicts: true } if you have read these and want them anyway.',
    );
  }

  const corrector = createCorrector({
    terms,
    pairs: config.pairs ?? [],
    options: config.options ?? {},
  });

  // The engine runs its own guards and drops what it cannot trust. Surface that here: a
  // caller who opted into `allowConflicts` should still be told what was refused on their
  // behalf, rather than wondering why a term they declared has no effect.
  const engineDropped = (corrector.dropped ?? []).map(
    (d) => `the engine refused the mis-hearing "${d}" because it would corrupt correct text`,
  );

  return {
    /** @returns {string} the corrected transcript */
    correct(text) {
      return corrector.correct(text).text;
    },
    /** @returns {{text:string, changes:object[]}} every rewrite, for logging or reverting */
    correctWithChanges(text) {
      return corrector.correct(text);
    },
    terms: Object.freeze(terms.map((t) => Object.freeze({ say: t.say, heard: Object.freeze([...t.heard]) }))),
    options: corrector.options,
    warnings: [
      ...warnings,
      ...(errors.length && config.allowConflicts ? errors : []),
      ...engineDropped,
    ],
    version: CORRECT_VERSION,
  };
}
