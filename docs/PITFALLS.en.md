# Pitfalls — building speech/plugins on the DeepSeek Harness desktop surface

[中文](PITFALLS.md) | **English**

Field notes from shipping this plugin. Each cost real debugging time and is hard to find
in search engines. Ordered roughly by how much time they cost.

## sherpa-onnx under Electron

**`compute(stream)` throws `External buffers are not allowed`.**

sherpa-onnx-node 1.13.8's `SpeakerEmbeddingExtractor.compute(stream, enableExternalBuffer)`
defaults to `true` — zero-copy external buffers — which Electron's V8 memory cage forbids.
Pass `false` explicitly:

```js
const embedding = extractor.compute(stream, /* enableExternalBuffer */ false);
```

Invisible under plain Node; only reproduces inside Electron. If you test your plugin with
system Node, you will not see it until the harness loads it.

## Module resolution from a profile-installed bundle

**`createRequire(import.meta.url)('sherpa-onnx-node')` fails for profile bundles.**

Profile `node_modules` only holds what pnpm installed there. Packages shipped inside the
harness resolve from the installation — but your bundle does not live there. The shipped
sensevoice provider never hits this because it lives inside the install itself.

```js
const candidates = [
  () => createRequire(import.meta.url)('sherpa-onnx-node'),
  () => createRequire(join(process.resourcesPath, 'app.asar/dsh/node_modules/sherpa-onnx-node/package.json'))('sherpa-onnx-node'),
  () => createRequire('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/sherpa-onnx-node/package.json')('sherpa-onnx-node'),
];
```

Native binaries are in `app.asar.unpacked`, and Electron's fs patch redirects `*.node`
loads there automatically — requiring from inside `app.asar` works from the Host process.

## A `pnpm file:` install is **hard-linked** to your source tree

**Editing the source does not update the installed copy, and nothing tells you.**

`dsh plugin --profile desktop add file:./dsh-voice-personal` goes through pnpm's `file:`
dependency, which **does not copy** — the source tree and
`profiles/desktop/node_modules/dsh-voice-personal` share the same inodes.

The moment an editor saves by writing a temp file and renaming (VS Code, vim's default
`backupcopy=auto`, most GUI editors), that link breaks. Afterwards:

- you edit the source → only the source changes
- DSH loads the installed copy → behaviour is unchanged
- the tests read the source → **the tests pass**
- the symptom is "I changed it and it still does the old thing", with no error pointing here

This actually happened in this project: the engine went from v2 to v3, three recognition gaps
were fixed, every test passed — and the installed copy was still v2. None of the three fixes
were live for the user.

**How to tell whether the link still holds:**

```bash
LIVE=~/path/to/dsh-voice-personal
INST=~/.dsh/profiles/desktop/node_modules/dsh-voice-personal
stat -f %i "$LIVE/lib/correct/index.js" "$INST/lib/correct/index.js"   # different inodes = broken
grep -o 'CORRECT_VERSION = [0-9]*' "$INST/lib/correct/index.js"        # the version actually loaded
```

**What to do:** do not rely on the hard link. Put anything the user is meant to change in the
**data directory** — this plugin's glossary is `<dataDir>/terms.json`, effective on the next
dictation with no restart. For source changes, sync explicitly and **print the version inside
the installed copy** so a human can check it (`dev/sync-install.sh`).

Worth noting: a broken link is actually the safer steady state — the installed copy becomes a
snapshot that source edits cannot silently alter. The requirement is an explicit sync step,
rather than assuming that editing means it took effect.

## Paths

**`new URL(import.meta.url).pathname` keeps percent-encoding.**

Any non-ASCII install path (this project lives under a Chinese-named directory) produces
`%E5%B7%A5...` in the pathname, which then fails as a filesystem path. Always:

```js
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
```

**The Electron process does not carry `$DSH_HOME`.**

The CLI sets it when booting a profile; the desktop app does not. A plugin resolving data
paths with `process.env.DSH_HOME ?? here` silently falls back into its own install
directory. This shipped as a real bug: strict speaker gating read an empty store and failed
closed on every dictation. Fall back to `~/.dsh` — the app's actual store — instead.

## Data formats

**Session logs are multi-frame zstd.**

`~/.dsh/sessions/*/**/session.v4.jsonl.zstd` is a sequence of zstd frames, one per append.
`zstdDecompressSync` decodes the first frame and returns — silently discarding the rest of
the conversation. Walk frame boundaries:

```js
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
let pos = 0;
while (pos < buf.length) {
  let next = buf.indexOf(MAGIC, pos + 4);
  if (next === -1) next = buf.length;
  try { parts.push(zlib.zstdDecompressSync(buf.subarray(pos, next))); } catch {}
  pos = next;
}
```

**ffmpeg's default WAV output is not canonical.**

ffmpeg writes a `LIST/INFO` metadata chunk, pushing `data` past offset 36. The harness
validates a strict 44-byte canonical header (16 kHz, mono, PCM16) and rejects the file.
Force a bare header:

```
-fflags +bitexact -flags:a +bitexact -map_metadata -1 -f wav out.wav
```

**Canonical WAV contract:** `RIFF/WAVE/fmt(16)/data`, 16000 Hz, 1 channel, 16-bit, header
exactly 44 bytes, PCM starts at 44. Float samples are `int16LE / 32768`.

## Cordis / DSH specifics

**Cordis rejects undeclared property assignment on the context.**

`ctx.voicePersonal = {...}` throws `cannot set property "voicePersonal" without provide`
and kills activation. Use a module-scoped `export let internals` instead, or register a
real service.

**Inject optional services.**

`export const inject = ['speechToText']` keeps the plugin inactive (shown as "pending,
waiting for service") in profiles without that service — exactly right. Importing a service
module directly instead makes the bundle fail to load everywhere.

**`pnpm file:` dependencies are hardlinks.**

`plugin add file:$PWD` links the directory; editing the source edits the installed copy,
and every installed profile copy shares one inode. Restoring a stale backup over the
workspace file therefore reverts *every* profile at once. Break the link (copy + reinstall)
before replacing a file wholesale.

**`files` in package.json governs file: installs too.**

A `files` allowlist that omits a directory (e.g. `models/`) silently excludes it from the
installed package — the plugin activates fine and then the model is not where the code
expects it. The probe result was `voiceprintReady: false` with no error.

**desktop is not a profile template.**

`--from-default-profile desktop` fails; templates are `web`, `headless`, `sdk`,
`sdk-minimal`, `acp`. To mirror the desktop profile for testing, create a `web` profile and
append the bundles you need — but note the shipped voice bundle pulled from npm pins an
older peer range and gets disabled as incompatible; the desktop profile resolves those
packages from the installation instead.

**Version-compatibility gating is exact.**

A bundle whose `peerDependencies` pin a different dsh version is disabled at boot with a
precise message naming `dsh plugin allow-version` as the override. Read the boot log; the
rows are listed per plugin.

## Model provenance

Record upstream URL, byte size and SHA-256 for every shipped model at fetch time
(`models/SOURCES.md`). Verifying a 28 MB binary after the fact is guesswork; verifying it
at download is one `shasum -a 256`.
