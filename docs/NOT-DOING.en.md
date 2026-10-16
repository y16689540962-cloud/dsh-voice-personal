# What this plugin deliberately does not do — and why

[中文](NOT-DOING.md) | **English**

This document records features that have been **argued through and decided against**, along
with the evidence behind each decision.

It exists to save time. Every conclusion here cost real effort, and several — especially the
first — look extremely attractive. Without this document, the next person spends a day
building a feature that cannot work. **To overturn anything here, read the evidence first and
say what is new.**

---

## 1. No pre-recognition biasing — we do not make the recogniser hear your words better

**Decision: not pursued. This is not "we haven't got to it"; the path does not exist on this
model.**

### Evidence (external and authoritative, not this project's inference)

The sherpa-onnx documentation for [Hotwords (Contextual biasing)](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html)
states:

> **Only transducer models support hotwords in sherpa-onnx.** That is, only models from Offline transducer models and Online transducer models support hotwords. **All other models don't support hotwords.** Also, you have to change the decoding method to `modified_beam_search` to use hotwords. The default decoding method `greedy_search` does not support hotwords.

This plugin wraps **SenseVoiceSmall**, a non-transducer, non-autoregressive model. The
[official SenseVoice page](https://k2-fsa.github.io/sherpa/onnx/sense-voice/index.html) has no
mention of hotwords at all.

Three consequences:

1. **SenseVoice does not support hotwords.** Setting `hotwordsFile` / `hotwordsScore` for it
   is an inert configuration: no error, no effect. That is worse than a failure.
2. **It has no notion of a prompt either.** It is not an autoregressive language model, so
   there is nothing to concatenate a vocabulary onto. "Feed the glossary in as a prompt" is
   not an option that was rejected — it is a sentence with no referent on this model.
3. **The plugin's architecture cannot reach the decoder.** This is a provider wrapper: it
   receives **text, after recognition**. It never constructs a sherpa recognizer config.
   Changing decoding parameters means modifying DSH's built-in provider, which is outside the
   plugin boundary.

### The one in-decoder path that does exist, and why it is still out

sherpa-onnx ships a separate technology: [pinyin phrase replacement](https://k2-fsa.github.io/sherpa/onnx/homophone-replacer/index.html)
(`HomophoneReplacer`). It is explicitly **independent of and unrelated to** hotwords, and it
officially supports every model that can output Chinese — **including non-streaming
SenseVoice**. So it is possible in principle.

Why we still do not do it:

| Obstacle | Detail |
| --- | --- |
| **Architecture** | `hr` config must be injected into the recognizer; we only receive text |
| **Dependencies** | Rules must be compiled into `replace.fst` with pynini. The docs suggest non-Linux users "find a Linux machine". This contradicts "local-only, zero dependencies" |
| **No runtime updates** | The docs state rules cannot currently be modified at runtime — which is precisely the property a user glossary needs |
| **Unverified locally** | DSH's bundled `libsherpa-onnx-c-api.dylib` does contain `HomophoneReplacerConfig` and OpenFST symbols, so the C++ layer has the capability. Whether the JS binding exposes `hr` is **unconfirmed** (string probing of the asar was inconclusive). Recorded as **uncertain**, not as a finding |

**But its design is worth borrowing** (without its implementation):

1. **Whole-word pinyin full match, or nothing** — not substring, not partial. This is exactly
   the direction our own "homophone matching was removed entirely" lesson points: *tighten the
   match*, rather than delete the feature.
2. **A hand-curated rule table**, not a full-table index.
3. **Only Chinese is replaced; non-Chinese passes through untouched** — the same principle as
   our protected spans.

Those are what `test/collision.mjs` in this repository exists to measure.

### When to revisit

- DSH exposes the `hr` config **and** supports reloading rules at runtime, or
- the recogniser is swapped for a transducer model that supports hotwords.

Until then, **every available gain is post-recognition** — which is where this plugin already
lives.

---

## 2. No screen scraping

Typeless walks the macOS accessibility tree while recording and uploads **visible screen text
(capped at 10,000 characters)** plus content around the cursor (±1,000 characters each) with
the audio, as context for recognition/cleanup.

**Not done, for three independently sufficient reasons:**

1. **Privacy.** Measured: in a terminal it captures up to 5,000 characters before the cursor
   along with on-screen text; in a chat app it captures other people's messages. This plugin's
   entire proposition is that audio never leaves the machine.
2. **Platform.** It needs macOS accessibility permission and native code, which contradicts
   "zero dependencies, pure JS".
3. **Scenario.** This plugin's input is microphone audio. That "what is in the current focus on
   the desktop" relates to "what the user is dictating" needs re-arguing; it cannot be copied
   over.

**What is the zero-dependency equivalent?** Not screen scraping, but **signals already on the
machine** — history under `~/.dsh/sessions/`, the current term list. And its use would not be
"unconditional replacement" but **ranking or abstaining when candidates conflict**. That is a
separate piece of work, not yet started.

---

## 3. No input-field monitoring

After inserting text, Typeless watches the input field for 15 seconds and diffs it to harvest
new terms automatically (`auto_add_dictionary`).

**Monitoring: no.** The privacy cost is obvious (15 seconds of a field's full contents leaving
the machine), and a DSH plugin structurally cannot reach the host's input field.

**The diff-to-candidates core is worth having**, and we already have it: `scripts/learn.mjs`
mines candidate terms from session history into `glossary.json` for **human confirmation**.
Nothing is applied automatically.

**Here we deliberately do not copy Typeless.** It adds terms automatically; we propose and a
human confirms. That follows this project's standing trade-off: **a miss is better than a
wrong rewrite.** An automatically-added bad entry silently rewrites everything the user
dictates afterwards, and they will never work out which entry did it. Do not change this to
"be more like Typeless".

---

## 4. No cloud glossary, accounts, or sync

Typeless's personal dictionary is **account-level** (`/user/dictionary/*`, with CSV bulk
import), stored in the cloud and synced across devices; context and audio travel over RSA
envelope encryption.

**Not done**: it contradicts "local, zero-dependency, no account". The local glossary
(`<dataDir>/terms.json`) already covers the same ground, and does it **offline, surviving
upgrades, effective immediately**.

**The product shape is worth borrowing**: CSV/JSON import-export, an evidence field per entry.
Both are implemented in `scripts/terms.mjs`.

---

## 5. No accessibility allow/deny lists, no device telemetry

- **Allow/deny lists**: Typeless keeps a compatibility table of which apps' accessibility
  information is untrustworthy. That only matters if you read from or paste into input fields;
  irrelevant to post-processing a transcript.
- **Device environment fields** (model, memory, uptime): zero contribution to term accuracy,
  pure telemetry. This plugin collects no telemetry of any kind.

---

## 6. No Chinese-to-Chinese homophone correction, for now — measured, and a threshold is never enough

This differs from §1: **the mechanism is workable; we are choosing not to enable it.** It has
been measured, the conclusion is overturnable, and the way to overturn it is new evidence.

### The design evaluated

"Whole-word pinyin full match": every character in the span must have a reading, the key must
match **exactly** (not a substring, not partial), terms are hand-confirmed, with a syllabic
floor L. This is sherpa-onnx's `HomophoneReplacer` design (§1). The only question is: **with a
toneless table and our corpus, how big is the false-positive space?**

### Measurement (`node test/collision.mjs`, full report in [collision-report.md](collision-report.md))

Calibration first: for the 7 two-syllable keys documented in this repository, the script
computes 129,601 colliding strings — **80.8%** of the documented 160,454, close enough to
confirm it measures the same thing.

**Text ambiguity rate in the corpus** (share of positions whose pinyin key is shared with
another string that actually occurs):

| L | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- |
| Ambiguity | 63.98% | 14.02% | **1.31%** | 0.30% |

### The decisive evidence: L=4 has real counter-examples, reproduced with the real engine

Grouping 820 common words by key yields 15 same-key pairs; these have **two legitimate words**:

| L | key | pair |
| --- | --- | --- |
| 3 | `fuwuqi` | **服务器 / 服务期** (server / service period) |
| 4 | `shijianguanli` | **时间管理 / 事件管理** (time management / event management) |
| 4 | `huiyijilu` | **会议记录 / 会议纪录** (meeting minutes / meeting record) |

With those terms registered, the repository's own `createCorrector` produces:

```
服务器上跑着三个服务   →  服务期上跑着三个服务     ★ corrupted
时间管理很重要         →  事件管理很重要           ★ corrupted
会议记录整理一下       →  会议纪录整理一下         ★ corrupted
```

These are not contrived sentences: `服务器` occurs 43 times in this user's corpus, `工作台` 114.

### So what is the criterion

**A threshold alone cannot be the criterion.** The measurements show:

- L=4 has legitimate-word collisions, so "L=4 is safe" is false
- L=5 still has 97 colliding keys in the corpus, so "higher is safer" is also false
- **Every finite L has counter-examples. L lowers the rate; it cannot reach zero.**

The only decidable, reproducible, testable criterion is:

> **S1: for a given term (key K → canonical Y), no string S ≠ Y that actually occurs in the
> corpus or word list has key(S) = K.**

A collision count of zero means that term **cannot, by definition, misfire** on that corpus.
That is a necessary and sufficient condition, and far stronger than a threshold.

Accompanying constraints: **L ≥ 4** (L=3 still has 5.68% inherently ambiguous keys, plus the
`服务器/服务期` collision), and the check must run against **the user's own corpus** — the
report measured that after splitting the corpus in half, the L≥4 colliding keys **do not
overlap at all** (zero keys collide in both halves), so no fixed reference corpus can ever
enumerate the danger set.

### Conclusion: not enabled, with a clear and cheap path

The reason is not "1.31% is a bit high". It is that **there is not a single piece of evidence
of a Chinese homophone mis-hearing in the user's history.** Every observed error is Latin
spelling (`flcash`, `workbody`, `gHub`, `deep seek`) plus one cross-script case
(`哈里斯` → Harness), already covered. Adding a new pass for an error class that has never
occurred does not fit "a miss is better than a wrong rewrite".

**When real material appears** (the path is already built):

1. get a concrete "heard A, meant B"
2. `node test/collision.mjs --keys <that key>` for the key's combinatorial size
3. confirm on **the user's own corpus** that the key resolves to a single string (S1 passes)
4. still hand-confirmed, still whole-word pinyin, still L ≥ 4

That is: **from "a mechanism" to "per-term admission on evidence."** The risk then is bounded
and measurable rather than globally open.

---

## 7. No simplified/traditional conversion

The engine does **not** convert between simplified and traditional Chinese. An earlier pinyin
pass silently turned `工作臺` into `工作台`. The user never asked for a change of writing
system; that is a semantic change, not a correction.

The equivalent, if you want it, is an **explicit, user-enabled** feature — never a side effect
of the correction layer.

---

## 8. The "local candidate disambiguator" has nothing to disambiguate (not declined — moot)

A reviewer suggested: use local signals (history under `~/.dsh/sessions`, the current term
list) to **rank or abstain among conflicting candidates**, as the zero-dependency equivalent of
contextual biasing.

That was a reasonable suggestion under the assumptions of the time. But **the term-hygiene
checks added in the same piece of work removed its consumer**:

- `latinExact` is a `Map`: one folded form maps to exactly one canonical spelling
- a mis-hearing claimed by two terms → **rejected at construction**, never indexed
- a mis-hearing that collides with another term's canonical → also rejected
- entries rejected in a user's file are skipped at dictation time and logged

In other words: **the system has no state in which one key has several candidates.** A ranker
would have no input. Building candidate disambiguation would first require *allowing*
conflicting entries — which is exactly what the "never corrupt already-correct text" criterion
forbids.

**When it becomes meaningful again:** if Chinese homophone correction is ever introduced (§6),
one pinyin key naturally has several candidates, and then it is not merely useful but
**required** — the §6 admission criterion (S1) is fundamentally the question "does this key
have another reading?"

**Building it now would be pure speculation.**

---

## Related documents

- `docs/typeless-context-mechanism.md` — the full source of most evidence above (a
  distillation of 18 reverse-engineering notes, each claim labelled observed / measured /
  inferred / unknown). **An internal research document, not published with this repository**:
  it is a behavioural analysis of a commercial product, and publishing it would only invite
  trouble that has no legal basis.
- [DESIGN.md](DESIGN.md) — why homophone correction was removed entirely
- [ADVERSARIAL.md](ADVERSARIAL.md) — nine defect classes, with reproducers
