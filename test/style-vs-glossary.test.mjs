/**
 * Precedence between the glossary and the learned style profile.
 *
 * Both layers want to decide how a word is spelled, and the style pass used to win simply
 * because it runs last. That is backwards. The glossary is an **explicit decision** ("spell
 * it `DSH`"); the profile is a **majority vote** over how the user happened to type it in the
 * past. A vote must not overrule a declaration.
 *
 * This went unnoticed for the whole life of the style layer, because every correction test
 * calls `createCorrector` without an `applyStyle`, so the interaction was never exercised.
 * Measured on the real profile, the vote preferred `dsh` (0.67), `taptap` (0.89) and `gpt`
 * (0.73) — so three of the shipped glossary's normalisations were being undone on every
 * single dictation.
 *
 * The fix is deliberately narrow: the style pass skips only the folded forms the glossary
 * owns. Words the glossary says nothing about must keep following the learned habit, which
 * the last test pins down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCorrector } from '../lib/correct/index.js';
import { applyStyle } from '../lib/style/index.js';

/** A profile whose vote disagrees with the glossary on every term. */
const profile = {
  version: 1,
  casing: [
    { word: 'dsh', preferred: 'dsh', variants: [], total: 6, ratio: 0.67, mixed: true, ambiguous: false },
    { word: 'taptap', preferred: 'taptap', variants: [], total: 8, ratio: 0.89, mixed: true, ambiguous: false },
    { word: 'gpt', preferred: 'gpt', variants: [], total: 11, ratio: 0.73, mixed: true, ambiguous: false },
    { word: 'ai', preferred: 'AI', variants: [], total: 10, ratio: 0.9, mixed: true, ambiguous: false },
    { word: 'ui', preferred: 'UI', variants: [], total: 7, ratio: 0.86, mixed: true, ambiguous: false },
  ],
  spacing: null,
  fillerWords: [],
  stats: { texts: 1, cjkChars: 1 },
};

const terms = [
  { say: 'DSH', heard: ['dsh'] },
  { say: 'TapTap', heard: ['taptap'] },
  { say: 'GPT', heard: [] },
];

const plain = createCorrector({ terms });
const styled = createCorrector({ terms, applyStyle });

const styledCorrect = (s) => styled.correct(s, { style: profile }).text;

test('a declared spelling beats a learned casing habit', () => {
  assert.equal(styledCorrect('dsh 的识别有点问题'), 'DSH 的识别有点问题');
  assert.equal(styledCorrect('发布到taptap'), '发布到 TapTap');
  assert.equal(styledCorrect('用gpt跑一下'), '用 GPT 跑一下');
});

test('without a style profile the glossary behaves identically', () => {
  // The fix must not change the no-style path at all.
  assert.equal(plain.correct('dsh 的识别有点问题').text, 'DSH 的识别有点问题');
  assert.equal(plain.correct('发布到taptap').text, '发布到 TapTap');
  assert.equal(plain.correct('用gpt跑一下').text, '用 GPT 跑一下');
});

test('the style profile still governs words the glossary does not declare', () => {
  // The point of the fix is precedence, not disabling the layer. A blanket "style never
  // re-cases anything" would have passed the first test and broken the feature.
  assert.equal(styledCorrect('我们讨论 ai 的问题'), '我们讨论 AI 的问题');
  assert.equal(styledCorrect('用 ui 设计'), '用 UI 设计');
  // …and the glossary genuinely says nothing about them.
  assert.equal(plain.correct('我们讨论 ai 的问题').text, '我们讨论 ai 的问题');
});

test('the correction is idempotent with a style profile applied', () => {
  for (const s of ['dsh 的识别有点问题', '发布到taptap', '用gpt跑一下']) {
    const once = styledCorrect(s);
    assert.equal(styledCorrect(once), once, s);
  }
});

test('a style profile cannot resurrect a rejected mis-hearing', () => {
  // Both layers must leave a guard string alone.
  for (const s of ['人物关系很复杂', 'cd ~/projects/harness.git']) {
    assert.equal(styledCorrect(s), s, s);
  }
});
