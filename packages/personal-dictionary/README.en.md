# asr-personal-dictionary

Apply **your own vocabulary** to speech-recognition output: product names, project names,
casing, and Chinese mis-hearings of Latin terms.

Zero dependencies. Offline. Text in, text out — no model, no network, no API key.

```js
import { createDictionary } from 'asr-personal-dictionary';

const dict = createDictionary({
  terms: [
    'DSH',                                          // casing only
    { say: 'FlClash', heard: ['flcash'] },           // an observed mis-hearing
    { say: 'Harness', heard: ['哈里斯', '哈内斯'] },   // a Chinese mis-hearing of an English word
  ],
});

dict.correct('帮我稳定我现在的flcash');
// '帮我稳定我现在的 FlClash'
```

中文说明见 [README.md](README.md)。

---

## The problem

Recognisers are good at *language* and bad at *your* language. Nothing in a general model
knows that this speaker says `flcash` meaning `FlClash`, that `哈里斯` is an English word, or
that `DeepSeek` has no space in it.

So the common words all come out right and the proper nouns all come out wrong — and the
proper nouns are exactly the part you need correct, because they are what you paste into a
commit message, a search box, or a message to a colleague.

This package is the smallest thing that fixes that.

**It runs after recognition.** If your app also prompts an LLM to clean the transcript up,
run this **before** the model call — otherwise the model faithfully polishes the wrong word
into a well-formatted wrong word. Running it again afterwards is harmless; the operation is
idempotent.

---

## Install

```bash
npm install asr-personal-dictionary
```

Node 18+, ESM. No runtime dependencies; the pinyin table is bundled (159 KiB).

---

## Writing a glossary

`terms` accepts strings and objects, mixed freely:

| Form | Effect | Example |
|---|---|---|
| `'DSH'` | Casing normalisation only | You know the spelling; the recogniser just will not capitalise it |
| `{ say, heard: [...] }` | Exact match on any `heard` form, replaced by `say` | `flcash` → `FlClash`, `workbody` → `WorkBuddy` |
| `{ say, heard: ['哈里斯'] }` | A Chinese mis-hearing mapped onto a Latin term | Requires 3+ characters, a complete pinyin reading, and an exact whole-span match |

Matching on `heard` is **case-folded exact match**. There is no fuzzy channel in this
package; see Options below for why one is not offered.

---

## Safety properties

There is one acceptance criterion: **never damage text that was already correct.** A personal
dictionary that occasionally rewrites ordinary sentences is worse than no dictionary, because
the user has no way to find out which of their sentences it edited.

Every property below is backed by a test, not by a claim:

| Property | What it means |
|---|---|
| **No Chinese-to-Chinese rewriting** | See the next section. This is the load-bearing constraint of the whole design |
| **Exact matching** | `heard` forms are compared case-folded and exactly. No edit distance, no homophones |
| **Protected spans** | URLs, file paths, emails, version numbers, CLI flags, inline code and known file extensions are masked *before* any pass runs, so no pass can reach them |
| **Idempotent** | `correct(correct(x)) === correct(x)`. A canonical form is never re-expanded |
| **Whitespace-honest** | Leading indentation survives byte-for-byte; dictated Python or YAML must not be reflowed |
| **Traditional characters preserved** | No simplified/traditional conversion. Silently changing script is a semantic change nobody asked for |
| **Fails open** | Non-string input (`null`, a number) is coerced, never thrown on. Throwing here loses a dictation |

### Why there is no Chinese homophone correction

This is the most important lesson in the project, and half the reason this package exists.

An early revision matched Chinese by **toneless pinyin**, so `差件` → `插件` and `工作太` →
`工作台`. It was removed entirely — not because it was mistuned, but because it is unsound:

```
人物 / 任务  (rènwù)      一部 / 异步  (yībù)
信条 / 心跳  (xìntiáo)    便衣 / 编译  (biànyī)
接点 / 接口  (jiēdiǎn)    配制 / 配置  (pèizhì)
```

A two-syllable pinyin key matches **every** word with that reading. Measured: the twelve
two-syllable pairs that shipped rewrote **160,454 distinct two-character Chinese strings** —
the language. `人物关系很复杂` became `任务关系很复杂`; `这是一部好电影` became
`这是异步好电影`.

No threshold fixes this. Choosing `人物` over `任务` needs context, and pinyin does not carry
context. Chinese is therefore rewritten only when a whole span maps onto a Latin term you
listed — a far narrower and far more checkable claim.

---

## What it does not do

- **It does not bias the acoustic model.** This is text in, text out. It corrects what
  arrived; it does not make the recogniser more likely to hear your words. That needs
  hotword biasing in the engine, which non-autoregressive fixed-vocabulary models such as
  local SenseVoice do not support. If your recogniser does support hotwords, use both.
- **It does not transcribe, punctuate, or remove filler.** Dropping disfluencies, splitting
  paragraphs and turning "first… second…" into a numbered list are a different layer's job.
- **It cannot tell whether an English word is an ordinary word.** Listing `grade` as a
  mis-hearing of `Gradle` will turn `my grade is A` into `my Gradle is A`, and this package
  will not notice — it has no dictionary. It does reject the decidable subset at
  construction time; see below.

---

## Conflict validation

Building a dictionary checks for two configurations that have **actually caused damage**, and
refuses to build by default:

```js
// 1) A mis-hearing that collides with another term's canonical spelling — it would
//    rewrite that other term everywhere.
createDictionary({ terms: [{ say: 'Claude', heard: ['cloud'] }, { say: 'Cloud' }] });
// Error: "cloud" is listed as a mis-hearing of "Claude" but is the canonical spelling
//        of "Cloud" — that would rewrite every real occurrence of "Cloud".

// 2) A mis-hearing that is a substring of its own multi-word canonical form — the output
//    grows on every pass.
createDictionary({ terms: [{ say: 'Cocos Creator', heard: ['cocos'] }] });
// Error: "cocos" is a substring of its own canonical form "Cocos Creator", which made
//        the output grow on every pass. List the full phrase instead.
```

The second was measured: `Cocos Creator` → `Cocos Creator Creator` → `Cocos Creator Creator
Creator` → …, 705 hits across 4,000 fuzzed strings. The engine stops the growth, but the
*configuration* is wrong, so it is caught at construction.

One `heard` form claimed by two terms, and a mis-hearing that is a prefix of its own canonical
spelling, produce **warnings** rather than rejections.

`{ allowConflicts: true }` downgrades rejections to `dict.warnings` for the cases you have
read and want anyway. It is an escape hatch, not a fix — the test suite asserts the unsafe
consequence of the configuration above so the reason for the rejection stays executable.

---

## Options

```js
createDictionary({ terms, options: { ... } })
```

| Option | Default | Meaning |
|---|---|---|
| `canonicalTerms` | `true` | Rewrite known terms to their canonical spelling |
| `crossScript` | `true` | Enable Chinese mis-hearing → Latin term |
| `maxPhraseChars` | `8` | Longest CJK span considered for a cross-script match |
| `spacing` | `'space'` | Space between CJK and Latin: `'space'` / `'none'` / `'preserve'` |

**There is no fuzzy matching here, deliberately.** An earlier revision offered a
`fuzzyTerms` switch; an independent audit measured it as an **inert switch** — across 6,748
single-edit variants of real terms it changed the same two with the switch on or off (both via
the exact channel), and 40,000 dictionary words produced byte-identical output either way. The
guards that made it safe (a real runner-up required, a 0.85 floor) are exactly what made it
never fire.

**A switch that does nothing is worse than no switch**: the user turns on "fuzzy matching",
believes typos are now covered, and nothing changes. It was removed rather than kept as
decoration.

The history still stands: without those guards, an earlier fuzzy pass corrupted **97 of
210,604** English dictionary words (`harmless` → `Harness`, `upgrade` → `Gradle`). Reintroducing
fuzzy matching would need a design that measurably beats the exact channel — the old one did not.

---

## API

```js
const dict = createDictionary({ terms, pairs?, options?, allowConflicts? });

dict.correct(text)              // → string
dict.correctWithChanges(text)   // → { text, changes }  every rewrite: before/after/reason
dict.terms                      // frozen glossary (entries sharing a canonical are merged)
dict.options                    // resolved options
dict.warnings                   // string[] from construction
dict.version                    // engine version

validateTerms(terms)            // → { errors, warnings }, for pre-flight checks
```

Also exported: `toPinyinArray`, `latinTokens`, `fold`, `similarity`, `similarityStrict`,
`segments`, `DEFAULTS`, `CORRECT_VERSION`.

---

## Testing your own glossary

The safety properties are checkable by tooling, so you do not have to trust a README.

This repository ships an independent audit script (published as
[asr-text-correction-safety](https://clawhub.ai/skills/asr-text-correction-safety)) that
answers three questions about **your** layer:

```bash
PERSONAL_DICTIONARY=./my-glossary.json \
  node path/to/audit.mjs all path/to/examples/audit-shim.mjs
```

It runs a dictionary scan (real English words your layer corrupts), an idempotence fuzz
(4,000 mixed strings) and a collision check (common words rewritten). Any non-zero result
exits 1, so it can gate CI.

Wire it into your CI. This package's own suite (`npm test`, 24 tests) grew out of the same
adversarial audit.

---

## Provenance and licence

Generated from the correction layer of
[dsh-voice-personal](https://github.com/y16689540962-cloud/dsh-voice-personal), which wraps it
around a local SenseVoice model as a DeepSeek Harness dictation plugin.

**There is only one source.** This package's `dist/` is produced by `scripts/build.mjs` from
the upstream `lib/correct/`; there is no second hand-maintained copy. The build refuses to
ship an engine that imports a module it does not package, and after writing `dist/` it really
does import the result and run a correction through it. The one thing that is not copied is
the glossary: upstream's glossary is one person's private vocabulary, useless to anyone else
and not ours to publish, so a neutral empty one is generated and every term comes from the
caller.

MIT. The pinyin table comes from [pinyin-data](https://github.com/mozillazg/pinyin-data)
(MIT, Copyright © 2016 mozillazg): 26,711 entries, extracted, tone-stripped and packed — the
**readings themselves are unchanged**, and were validated entry-by-entry against pypinyin
0.55.0 (after allowing for a systematic u/ü merge, the number of genuinely wrong readings is
zero). Full attribution in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
