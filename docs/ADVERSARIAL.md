# Adversarial audit — nine defect classes, how they were found, and what fixed them

An independent adversarial pass was run against the correction engine with a single
mandate: **break the property "never corrupt already-correct text"**. It succeeded nine
ways. This document records each defect with its reproducer, because the fixes are only
credible if the failures are public.

The project's own suite passed 59/59 at the time. None of the nine were covered.

## D1 — Homophone pass rewrote ordinary Chinese (critical)

Toneless-pinyin matching over 2-syllable CJK spans matched every homophone of every
glossary pair.

```
人物关系很复杂   → 任务关系很复杂     (rènwù)
这是一部好电影   → 这是异步好电影     (yībù)
信条很重要       → 心跳很重要         (xìntiáo)
便衣警察         → 编译警察           (biànyī)
接点电阻         → 接口电阻           (jiēdiǎn)
配制溶液         → 配置溶液           (pèizhì)
变异病毒         → 编译病毒           (biànyì)
一步一步来       → 异步异步来         (yībù, twice)
```

Blast radius, computed by enumerating the collision space: **160,454 distinct 2-character
CJK strings** were rewritten across the 12 two-syllable pairs.

**Fix:** the same-script homophone pass was deleted outright. Cross-script
transliteration (Chinese mis-hearing of a Latin term) remains, with the three guards in
[DESIGN.md](DESIGN.md) §2. `PAIRS` ships empty.

## D2 — Exact `heard` variants corrupted correct English

The glossary listed real words as mis-hearings: `grade` under Gradle, `harris` under
Harness, `cloud` under Claude.

```
my grade is A                 → my Gradle is A
the cloud is down             → the Claude is down
harris county                 → Harness county
upgrade to the new version    → Gradle to the new version
```

**Fix:** a heard form that is itself an ordinary word must not be listed. Shipped glossary
entries are product spellings (`flcash`, `workbody`) or casing normalisations only.

## D3 — Fuzzy Latin matching corrupted 97 dictionary words

Scanning 210,604 dictionary words found 97 rewritten with a changed content fingerprint:
`sadness` → `Harness` (60 words hit Harness alone), `cocoa` → `Cocos Creator`, `hub` →
`GitHub`.

Root causes: (a) mis-spellings were indexed as fuzzy *references*, acting as extra
attractors; (b) the runner-up margin compared against 0 when only one reference scored, so
any single weak match passed unconditionally.

**Fix:** fuzzy references are canonical forms only; the margin requires an actual
runner-up; fuzzy is opt-in and off by default. Post-fix dictionary scan: **0 / 198,631**
words corrupted, with fuzzy on and off.

## D4 — File extensions swallowed

`LATIN_RUN` treated `.` as part of a token, so `harness.git` was one token:

```
harness.git              → Harness
cd ~/projects/harness.git → cd ~/projects/Harness
grade.js                 → Gradle
```

**Fix:** protected-span masking before all passes (URLs, paths, emails, versions, CLI
flags, inline code, known extensions). One mechanism covers every pass.

## D5 — Non-idempotent, unbounded growth

The phrase pass emitted `Cocos Creator`; the single-token pass then expanded the `Cocos`
inside its own output:

```
cocos creator → Cocos Creator Creator → Cocos Creator Creator Creator → …
```

Structured fuzzing (4,000 mixed-atom strings) found **705** non-idempotent cases.

**Fix:** never re-expand a canonical form; never list a canonical's prefix as a
mis-hearing. Post-fix fuzz: 0 / 4,000.

## D6 — Table-missing characters collapsed spans

873 CJK characters have no pinyin entry (mostly Extension A). `toPinyinArray` skipped them
silently, so a 4-character span could produce a 3-syllable key:

```
克㐂劳德 → Claude      哈㐂里斯 → Harness      普㐂朗普特 → prompt
```

**Fix:** a span qualifies only when every character has a reading (`readings.length ===
span.length`).

## D7 — Guard seam: characters vs syllables

The new ≥3-character guard counted characters while the index key counted syllables. A
3-character `heard` containing a table-missing character passed the guard yet indexed a
2-syllable key, re-arming D1 for `哈里` → `Harness`.

**Fix:** the completeness guard (D6) makes character count and syllable count agree, which
closes the seam structurally rather than adding a second count.

## D8 — `tidy()` destroyed indentation

Collapsing runs of 2+ spaces included line-leading whitespace:

```
def foo():          →      def foo():
    if x:           →       if x:
        return 1    →        return 1
```

**Fix:** preserve leading whitespace per line verbatim; collapse internal runs only.
Suite asserts Python and YAML blocks survive byte-identical.

## D9 — Traditional Chinese silently converted

Matching was by pinyin, so `工作臺` matched the key for `工作台` and was rewritten to
simplified. Silent script conversion is a content change the user did not ask for.

**Fix:** gone with the same-script pass (D1). Traditional text now survives untouched, and
the suite asserts it.

## What the audit confirmed as sound

Bounded negative results, recorded so the claim has edges:

- **Pinyin table readings:** all 26,711 entries audited against pypinyin 0.55.0 — zero
  genuinely wrong readings after allowing the systematic u/ü merge. Polyphones spot-checked
  (行→xing, 长→zhang, 重→zhong, 率→lu, 薄→bao, 削→xue).
- **Spacing on paths/URLs/code:** `~/Downloads/…`, `https://…`, `127.0.0.1:19387`, `C++`,
  `v1.2`, `user@example.com` — untouched.
- **Greedy longest-match:** no case found where a longer span beat a better shorter one.
- **Unicode edges:** emoji, ZWJ families, combining marks, surrogate pairs, 60,000-char
  inputs — no corruption, no pathological timing.

## Method notes

- The audit pinned a frozen snapshot of the module before reporting, then re-confirmed
  every reproducer against the live module — the target was being edited mid-verification.
- Two of the auditor's own initial claims were wrong (`率=lu` judged a bad reading; the
  guard judged comment-only) and were retracted after re-reading source. A verifier that
  hides its own errors is worthless.
- All reproducers live on as sections 三–九 of `test/correct.test.mjs`, so each fix is
  executable proof rather than a claim.
