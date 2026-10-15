# Design notes — and why the homophone rewriter was removed

[中文](DESIGN.md) | **English**

This document is the reasoning layer of the project. The code is small; the decisions
behind it are not obvious, and two of them reverse what looks like the obvious approach.

## 1. Wrap the provider, never replace it

The built-in SenseVoice provider owns a lot of hard machinery: model download and
verification, a native worker subprocess, VAD segmentation, queueing, idle teardown,
deadline management. Reimplementing any of it would fork that behaviour and drift on every
harness upgrade.

So this plugin registers a *new* provider and delegates through the service's public API:

```js
const spec = ctx.speechToText.resolve({ audio, providerId: baseId, language });
const result = await ctx.speechToText.transcribe(spec, signal);
```

`resolve()` performs the service's own registration-identity check, so a withdrawn base
provider fails loudly instead of silently producing uncorrected text. The base provider
keeps its id and stays selectable — rollback is switching providers in Settings, and
uninstalling this plugin changes nothing else.

**Recursion guard.** A provider that resolves "the default" can resolve to itself once it
*is* the default. The fallback chain therefore excludes its own id explicitly. This was
found by test, not by reading: with the base provider absent, the original fallback list
contained `personal-local`, and delegation recursed until the stack overflowed.

**Fail-open at the boundary.** If correction throws, the raw transcript is returned
unchanged. A dictation must never be lost to a bug in the text layer.

## 2. The homophone rewriter is unsound — the arithmetic

The original design indexed a personal glossary by toneless pinyin so that any
mis-hearing of a term would resolve to its canonical form. It shipped, and it was wrong.

A two-syllable key matches every word with that reading. Mandarin homophone density makes
the collision space the whole language:

```
rènwù   人物 / 任务         yībù    一部 / 异步
xìntiáo 信条 / 心跳         biànyī  便衣 / 编译
jiēdiǎn 接点 / 接口         pèizhì  配制 / 配置
```

Measured blast radius: across the twelve two-syllable pairs that shipped, **160,454
distinct two-character CJK strings** matched a key and were rewritten. Observed damage
included `人物关系很复杂` → `任务关系很复杂` and `这是一部好电影` → `这是异步好电影`.

Why no threshold fixes this: the match is exact on pinyin and wrong on meaning. The
information that selects 人物 over 任务 is sentence context; pinyin has already discarded
it. Raising thresholds only trades false positives for false negatives inside the same
broken space.

**What replaced it** recognises that the *safe* subset is cross-script: a Chinese
mis-hearing of a Latin term. `哈里斯` → `Harness` has no same-script collision because the
canonical form is Latin. Three guards make it sound:

1. ≥3 syllables — bare `哈里` (hālǐ) is an ordinary word (哈里发), so short entries are
   rejected at index build time;
2. a complete pinyin reading — if any character in the span is missing from the table, the
   key shortens and a 3-char span could match a 2-syllable key (873 CJK characters are
   absent from the table, mostly Extension A; this guard is what keeps them harmless);
3. exact key match over the whole span — no partial spans, no fuzzy edges.

The guard lives in the index builder, not in the glossary data file. A data-file rule is
documentation; an index-builder rule is enforced against every future entry.

## 3. Latin matching: exact by default, fuzzy opt-in

An exact-match list handles every mis-hearing actually observed in the author's history:
`flcash`, `workbody`, `gHub`, `toptop`, `deep seek`. The tempting next step — fuzzy
matching to catch unseen variants — was measured before shipping: scanning 210,604 English
dictionary words, a fuzzy pass with a length-scaled edit budget corrupted **97 real words**
(`harmless` → `Harness`, `upgrade` → `Gradle`, `cocoa` → `Cocos Creator`).

Two root causes, both structural:

- the index contained the *mis-spellings* as fuzzy references, so `grade` (listed under
  Gradle) acted as an attractor for `upgrade`;
- the runner-up margin guard compared against zero when only one reference scored, so a
  single weak match passed unconditionally.

Both are fixed — canonical forms only, and a margin that requires an actual runner-up —
but fuzzy remains **off by default**. Exact matching already covers observed reality; the
fuzzy pass adds a measurable corruption rate for unobserved benefit. It is available for
users whose vocabulary is dense with novel product names.

## 4. Protected spans

Any rewriting pass will eventually meet a file path, URL, email or version string.
`harness.git` inside `cd ~/projects/harness.git` is a repository name, not a mis-hearing of
"Harness". The pipeline therefore masks protected spans behind private-use sentinels
before any pass runs, and restores them afterwards:

```js
const { masked, restore } = maskProtected(text);
// ... all passes operate on `masked` ...
cur = restore(cur);
```

The pattern matters more than the regex list: one mechanism covers every pass, present and
future, instead of each pass maintaining its own "is this a path?" checks.

## 5. Filler deletion: whitelist plus conservative context

Fillers are learned from the user's own corpus (`呃 ×11, 然后 ×12`), not from a generic
list — the profile's whitelist is what bounds the blast radius. Context rules then decide
per occurrence:

| shape | action | why |
|---|---|---|
| `呃，帮我…` | delete | standalone before punctuation |
| `嗯，那个，我觉得…` | delete, cascading | run of sentence-initial fillers |
| `就是这个问题` | keep | the word carries meaning here |
| `那个插件` | keep | demonstrative, not filler |
| `唉声叹气` | keep | the "filler" is a morpheme of a real word |

The last row is the load-bearing one. An earlier revision allowed deletion when a tier-1
filler appeared at string start with a word character following — which broke `唉声叹气`
immediately. Glued fillers are now deletable only through the whitelist
(`啊哈/哦豁/哎呀…`); everything else glued to a word is kept. Deletion of the glued shape
(`呃帮我稳定一下`) is a known, accepted miss: character-level context cannot separate it
from a morpheme, and in the author's corpus the glued shape is 9.5% of filler occurrences
while the punctuated shapes — which delete safely — are 90.5%.

## 6. Idempotence is a correctness property, not a nicety

A post-processing layer may run more than once on the same text (retry, re-insert,
provider switch). Any pass that is not idempotent therefore grows text unboundedly. The
worst case shipped briefly: `cocos creator` → `Cocos Creator Creator` → …, because the
phrase pass emitted a canonical form that the single-token pass then expanded again.
Two rules ended it: never re-expand a form that already equals its canonical, and never
list a canonical's own prefix as a mis-hearing of itself.

The test suite asserts `correct(correct(x)) === correct(x)` over both curated and fuzzed
inputs (4,000 mixed-atom strings).

## 7. Whitespace is content

`tidy()` once collapsed runs of spaces including line-leading ones — silently reflowing
dictated Python or YAML. Indentation is line structure; the tidy pass now preserves it
verbatim and only collapses *internal* runs. The correction suite asserts a Python block
and a YAML document survive byte-identical.

## 8. Verification order

The suites assert, in this order of importance:

1. never corrupt already-correct text (false positives are silent meaning changes);
2. fix the mis-hearings observed in real history.

That order decides every tie. A missed fix costs a small manual edit; a false positive
changes what the user said without telling them. Every guard string in the glossary is a
sentence an earlier revision damaged.
