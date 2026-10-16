#!/usr/bin/env node
/**
 * What a dictation app does with this package.
 *
 * A recogniser turns audio into a transcript. This runs *after* that, on the text, before
 * it reaches the user's cursor. Two integration points matter and they are different:
 *
 *   1. If your app prompts an LLM to clean the transcript up, correct **before** the model
 *      call, so the model sees `FlClash` and not `flcash`. Models faithfully clean up the
 *      wrong word into a well-formatted wrong word.
 *   2. Correct **after** the model too, because a model that rewrites freely can re-break a
 *      product name. Both calls are cheap and idempotent, so doing both is safe.
 *
 * Run with: node examples/dictation-app.mjs
 */
import { createDictionary } from '../index.js';

// Whatever the speaker actually works with. In a real app this is a settings pane, a JSON
// file, or the contents of a "custom vocabulary" field.
// Note the third entry: 哈里斯 is a Chinese mis-hearing of an English word, which is the
// case an LLM-only cleanup pipeline handles worst — it has no reason to suspect 哈里斯 is
// wrong, because it is a perfectly good Chinese transcription.
const dictionary = createDictionary({
  terms: [
    'DSH',
    { say: 'FlClash', heard: ['flcash'] },
    { say: 'Harness', heard: ['哈里斯', '哈内斯'] },
    { say: 'Cocos Creator', heard: ['cocoscreator'] },
    { say: 'DeepSeek', heard: ['deepseek', 'deep seek'] },
    { say: 'TapTap', heard: ['taptap'] },
  ],
});

/** Stand-in for the recogniser. Real output, from the session history that built this. */
const transcripts = [
  'dsh 的识别有点问题',
  '帮我稳定我现在的flcash',
  '这应该是哈里斯的工作吗',
  '用cocoscreator做的那款游戏要发到taptap',
  '反代到deep seek harness',
  // …and these must come back byte-identical.
  '人物关系很复杂',
  'cd ~/projects/harness.git',
  'def foo():\n    return 1',
];

for (const raw of transcripts) {
  const { text, changes } = dictionary.correctWithChanges(raw);
  const mark = changes.length ? `(${changes.map((c) => `${c.before}→${c.after}`).join(', ')})` : '(untouched)';
  console.log(`${JSON.stringify(raw).padEnd(46)} → ${JSON.stringify(text)}  ${mark}`);
}

// Only print warnings if there are any — a clean glossary should build silently.
if (dictionary.warnings.length) {
  console.log('\nwarnings:');
  for (const w of dictionary.warnings) console.log(`  - ${w}`);
}
