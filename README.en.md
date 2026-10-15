# dsh-voice-personal

[中文](README.md) | **English**

**A post-processing layer for DSH's local speech recognition — personal glossary, cross-script transliteration, and a style profile learned from your own session history.**

Native Chinese dictation into DeepSeek Harness breaks in three specific ways: your product names and project terms come back wrong (`flcash` instead of `FlClash`), code-switched sentences degrade where Chinese and Latin meet, and filler words burn tokens in every message you send. This plugin fixes those three, on-device, without touching the recogniser itself.

It does **not** replace DSH's built-in SenseVoice provider. It wraps it — the shipped provider keeps owning model preparation, the native worker, VAD segmentation, queueing and timeouts, and this layer only reshapes the text that comes out. That boundary is deliberate and it is what keeps the plugin alive across harness upgrades.

```
mic → personal-local → sensevoice-local (on-device ONNX) → glossary → style → composer
```

Everything runs locally. No network calls, no cloud ASR, no audio persisted — recordings are transient by design and never written to disk.

---

## The part worth reading: why it does NOT do homophone correction

This project shipped a Chinese homophone rewriter and then removed it. If you are evaluating ASR post-processing for Chinese, that decision is more useful than the feature list.

The idea looks obvious: index your glossary by toneless pinyin, and every mis-hearing of a term resolves itself — `工作太`, `公作台`, `工作台` all share the key `gongzuotai`. One canonical entry teaches the engine every wrong spelling of it.

It is unsound, and the reason is arithmetic rather than tuning. A two-syllable pinyin key matches *every* word with that reading, and Mandarin is dense with legitimate homophones:

| pinyin | all of these are correct words |
|---|---|
| rènwù | 人物 / 任务 |
| yībù | 一部 / 异步 |
| xìntiáo | 信条 / 心跳 |
| biànyī | 便衣 / 编译 |
| jiēdiǎn | 接点 / 接口 |
| pèizhì | 配制 / 配置 |

In practice `人物关系很复杂` became `任务关系很复杂`, and `这是一部好电影` became `这是异步好电影`. Across the twelve two-syllable pairs that shipped, **160,454 distinct two-character strings** matched — the blast radius was the language itself. No threshold repairs that, because the missing information is context and pinyin does not carry context.

What survived is narrower and checkable: cross-script entries fix a *Chinese mis-hearing of a Latin term* (`哈里斯` → `Harness`) and require ≥3 syllables, a complete pinyin reading for the whole span, and an exact key match. `哈里王子` and `哈里发` are untouched, because bare `哈里` (hālǐ) is also an ordinary word.

The full derivation, including the adversarial pass that found it, is in [docs/DESIGN.md](docs/DESIGN.md).

---

## What it actually does

**Personal glossary** — exact matching after case folding, over terms harvested from your own session history. The shipped glossary is an example set; yours will differ.

```
flcash → FlClash      workbody → WorkBuddy      哈里斯 → Harness
gHub → GitHub         toptop → TapTap           deep seek → DeepSeek
```

**Code-switch normalisation** — spacing between CJK and Latin follows the habit learned from your corpus (85–87% of writers of technical Chinese want a space there; the profile measures yours instead of guessing). Protected spans — URLs, file paths, emails, versions, CLI flags, inline code — are masked before any rewriting, so `harness.git` inside a path survives intact.

**Filler removal, conservatively** — the profile learns which fillers actually occur in *your* speech (`呃 ×11, 然后 ×12, 那个 ×8` for the author) and deletes them only where they are safe: standalone, or followed by punctuation. A filler glued to a word (`唉声叹气`) is kept, because character-level context cannot tell a filler from a morpheme, and an adversarial pass proved the distinction matters. Deletion is whitelisted from the profile — text is never "cleaned" by a generic list.

**Style profile, not rewriting** — casing votes, spacing ratios, punctuation habits, all deterministic statistics over your own history. No LLM call, no network, reproducible from the same corpus.

**Speaker verification (opt-in, off by default)** — 192-dim speaker embedding via sherpa-onnx, enrolled from your own recordings. Off by default because the goal is transcription accuracy; when enabled it fails closed, rejecting audio it cannot attribute. The thresholds shipped are not calibrated to any particular voice — enroll and measure before trusting them.

---

## Install

Requires a running DeepSeek Harness desktop install.

**Option A · npm (recommended)**

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add dsh-voice-personal
```

**Option B · from source**

```bash
git clone https://github.com/y16689540962-cloud/dsh-voice-personal.git
cd dsh-voice-personal
"$DSH" plugin --profile desktop add "file:$PWD"
```

Restart the harness. Rollback is `plugin remove dsh-voice-personal` — the wrapped provider keeps its own id, so nothing else moves.

> The speaker model (`campplus.onnx`, 28 MB) is not bundled in the npm package. If you want speaker verification after an npm install, fetch it from [Release v0.1.0](https://github.com/y16689540962-cloud/dsh-voice-personal/releases/tag/v0.1.0) into `models/` (SHA-256 in `models/SOURCES.md`). You do not need it for the correction pipeline.

To build your own glossary from your session history:

```bash
node scripts/learn.mjs --dry-run   # preview what it mined, writes nothing
node scripts/learn.mjs             # writes ~/.dsh/voice-personal/style.json
```

To enroll a voiceprint:

```bash
node scripts/record.mjs --out /tmp/sample.wav --seconds 12
node scripts/enroll.mjs --name me --audio /tmp/sample.wav --check /tmp/sample2.wav
```

---

## Verification

```bash
node test/correct.test.mjs        # 118 checks: real mis-hearings fixed, correct text untouched
node lib/style/self-test.js       # 47 checks: deletion guards, idempotence, profile edges
node lib/voiceprint/selftest.mjs  # 38 checks: store, WAV contract, atomic persistence
```

The suites assert two properties in a fixed order of importance:

1. **Never corrupt already-correct text.** A missed fix costs a small edit; a false positive silently changes what the user said. Every guard string in the glossary is a sentence an earlier revision damaged.
2. Fix the mis-hearings observed in real history.

Section 三 through 九 of the correction suite are the reproducers from an adversarial audit that found nine defect classes in a previous revision — homophone over-reach, dictionary-word corruption, non-idempotent growth, indentation destruction, span collapse on table-missing characters. They are kept as executable proof those regressions stay fixed. [docs/ADVERSARIAL.md](docs/ADVERSARIAL.md) documents each.

---

## Field notes from the DSH plugin surface

Things that cost real debugging time, written down because they are hard to find elsewhere:

- **`sherpa.compute(stream)` throws under Electron** with `External buffers are not allowed`. sherpa-onnx-node 1.13.8 defaults to zero-copy external buffers, which Electron's V8 forbids. Pass `false` explicitly. Invisible under plain Node.
- **A profile-installed bundle cannot resolve `sherpa-onnx-node`** — profile `node_modules` only holds what pnpm installed there. Resolve from the installation via `process.resourcesPath` and `createRequire`. The shipped sensevoice provider does not hit this because it lives inside the install.
- **`new URL(import.meta.url).pathname` keeps percent-encoding** — fatal under any non-ASCII install path. Use `fileURLToPath`.
- **The Electron process does not carry `$DSH_HOME`** — a plugin resolving data paths from that variable silently falls back into its own install directory. Fall back to `~/.dsh` instead. This one shipped as a bug: strict speaker gating failed closed on every dictation until it was found.
- **Session logs are multi-frame zstd.** One `zstdDecompressSync` returns the first frame and silently discards the conversation. Walk frame boundaries.
- **ffmpeg writes a LIST/INFO chunk** that pushes `data` past offset 36, breaking the canonical 44-byte WAV header the recogniser validates. `-fflags +bitexact -map_metadata -1`.

The full list is in [docs/PITFALLS.md](docs/PITFALLS.md).

---

## Repository layout

```
index.js                 host plugin: registers the provider, delegates, applies the pipeline
lib/correct/             correction engine (glossary, cross-script, protected spans)
lib/style/               style profile: learning + application
lib/voiceprint/          speaker embedding: enroll / verify (opt-in)
lib/data/pinyin-table.txt  26,711 characters, packed, 160 KB
scripts/                 learn.mjs · enroll.mjs · record.mjs
models/campplus.onnx     28 MB, Apache-2.0 — fetched at install time, see models/SOURCES.md
test/                    regression suites
docs/                    DESIGN.md · ADVERSARIAL.md · PITFALLS.md
```

`models/SOURCES.md` records the upstream URL, byte size and SHA-256 of every shipped model. The pinyin table is generated from [pinyin-data](https://github.com/mozillazg/pinyin-data) (MIT); the speaker model is 3D-Speaker CAM++ via [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0).

## License

MIT for the code. Upstream model licenses are linked in `models/SOURCES.md` and are compatible.
