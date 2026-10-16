/**
 * Tests for the user-terms pipeline: file → validation → merge → corrector → dictation.
 *
 * The property under test is not "the loader works". It is:
 *
 *   **a user's mistake must never turn into a wrong correction, and a user's change must
 *   never silently remove something that used to work.**
 *
 * Both halves are covered end to end, because the interesting failures live in the seams —
 * a conflict that validates but is not actually dropped, a reload that reports success but
 * does not reach the corrector, an error path that loses a dictation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { TERMS as BUILTIN_TERMS } from '../lib/correct/index.js';
import {
  createUserTermsLoader, mergeWithUserTerms, USER_TERMS_FILE, ABSENT_KEY,
} from '../lib/correct/user-terms.js';
import { apply, internals } from '../index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'terms.mjs');

let tmpCount = 0;
function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vp-terms-${process.pid}-${tmpCount++}-`));
  return dir;
}

/** Write a terms file and force a distinct mtime, so reload tests are not timer-dependent. */
function writeTerms(dir, content) {
  const file = path.join(dir, USER_TERMS_FILE);
  fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  const future = new Date(Date.now() + (tmpCount++ * 1000));
  fs.utimesSync(file, future, future);
  return file;
}

// ── loader ──────────────────────────────────────────────────────────────────────────

test('a missing file is normal, not an error', () => {
  const loader = createUserTermsLoader({ dir: tmpdir() });
  const loaded = loader.load();
  assert.equal(loaded.exists, false);
  assert.deepEqual(loaded.terms, []);
  assert.equal(loaded.error, null);
  assert.equal(loaded.key, ABSENT_KEY);
});

test('both file shapes are accepted', () => {
  const a = tmpdir();
  writeTerms(a, ['DSH', { say: 'FlClash', heard: ['flcash'] }]);
  assert.deepEqual(
    createUserTermsLoader({ dir: a }).load().terms,
    [{ say: 'DSH', heard: [] }, { say: 'FlClash', heard: ['flcash'] }],
  );

  const b = tmpdir();
  writeTerms(b, { version: 1, terms: [{ say: 'GitHub', heard: ['ghub'] }], pairs: [] });
  assert.deepEqual(createUserTermsLoader({ dir: b }).load().terms, [{ say: 'GitHub', heard: ['ghub'] }]);
});

test('a structurally broken file degrades to empty instead of throwing', () => {
  for (const bad of ['{ not json', '{"terms": 5}', '42', '"a string"']) {
    const dir = tmpdir();
    writeTerms(dir, bad);
    const loaded = createUserTermsLoader({ dir }).load();
    assert.deepEqual(loaded.terms, [], bad);
    assert.ok(typeof loaded.error === 'string' && loaded.error.length > 0, bad);
  }
});

test('a broken file keeps the last good terms rather than emptying the glossary', () => {
  const dir = tmpdir();
  const loader = createUserTermsLoader({ dir });
  writeTerms(dir, [{ say: 'FlClash', heard: ['flcash'] }]);
  assert.equal(loader.load().terms.length, 1);

  writeTerms(dir, '{ broken');
  const after = loader.load();
  assert.equal(after.terms.length, 1, 'the last good set must survive a mid-edit file');
  assert.equal(after.terms[0].say, 'FlClash');
  assert.ok(after.error);
});

test('conflicting entries are dropped while the good ones survive', () => {
  const dir = tmpdir();
  writeTerms(dir, [
    { say: 'MyCloud', heard: ['cloud'] },
    { say: 'Cloud' },                                   // makes the line above an error
    { say: 'PlantMerge', heard: ['plantmerge'] },
  ]);
  const loaded = createUserTermsLoader({ dir }).load();
  assert.equal(loaded.dropped.length, 1);
  assert.match(loaded.dropped[0], /MyCloud/);
  // `MyCloud` stays (casing normalisation is still useful) but its bad form is gone.
  assert.deepEqual(loaded.terms.find((t) => t.say === 'MyCloud'), { say: 'MyCloud', heard: [] });
  // The unrelated good entry is untouched.
  assert.deepEqual(loaded.terms.find((t) => t.say === 'PlantMerge'), { say: 'PlantMerge', heard: ['plantmerge'] });
});

test('the cache is keyed on the file, and a change is picked up', () => {
  const dir = tmpdir();
  const loader = createUserTermsLoader({ dir });
  writeTerms(dir, [{ say: 'A' }]);
  const first = loader.load();
  assert.equal(loader.load(), first, 'an unchanged file must not be re-parsed');

  writeTerms(dir, [{ say: 'B' }]);
  const second = loader.load();
  assert.notEqual(second, first);
  assert.equal(second.terms[0].say, 'B');
});

test('warnings are emitted once per file state, not once per dictation', () => {
  const dir = tmpdir();
  const messages = [];
  const logger = { warn: (m) => messages.push(m) };
  writeTerms(dir, '{ broken');
  const loader = createUserTermsLoader({ dir, logger });
  loader.load(); loader.load(); loader.load();
  assert.equal(messages.length, 1, `expected one warning, got ${JSON.stringify(messages)}`);
});

// ── merge semantics ─────────────────────────────────────────────────────────────────

test('re-declaring a shipped term unions the mis-hearings instead of replacing them', () => {
  const harness = BUILTIN_TERMS.find((t) => t.say === 'Harness');
  const { terms, shadowed } = mergeWithUserTerms(BUILTIN_TERMS, [{ say: 'Harness', heard: ['哈利斯'] }]);
  const merged = terms.find((t) => t.say === 'Harness');
  for (const form of harness.heard) {
    assert.ok(merged.heard.includes(form), `lost shipped form ${form}`);
  }
  assert.ok(merged.heard.includes('哈利斯'));
  assert.deepEqual(shadowed, [], 'unioning is not shadowing');
});

test('re-declaring the same mapping is agreement and stays silent', () => {
  const { shadowed } = mergeWithUserTerms(BUILTIN_TERMS, [{ say: 'FlClash', heard: ['flcash'] }]);
  assert.deepEqual(shadowed, []);
});

test('re-pointing a shipped mis-hearing at a different term is reported, and only that form moves', () => {
  const { terms, shadowed } = mergeWithUserTerms(BUILTIN_TERMS, [{ say: 'MyThing', heard: ['ghub'] }]);
  assert.deepEqual(shadowed, [{ say: 'GitHub', forms: ['ghub'] }]);
  const github = terms.find((t) => t.say === 'GitHub');
  assert.ok(!github.heard.includes('ghub'), 'the re-pointed form must leave the shipped entry');
  assert.ok(github.heard.includes('github') && github.heard.includes('gihub'),
    'the other shipped forms must survive');
});

test('a user canonical overrides the shipped definition', () => {
  const { terms } = mergeWithUserTerms(BUILTIN_TERMS, [{ say: 'GitHub', heard: ['my-own-form'] }]);
  const github = terms.find((t) => t.say === 'GitHub');
  assert.ok(github.heard.includes('my-own-form'));
  assert.ok(github.heard.includes('github'), 'shipped forms are still folded in');
  assert.equal(terms.filter((t) => t.say === 'GitHub').length, 1);
});

// ── the plugin, end to end ──────────────────────────────────────────────────────────

/** A Cordis-shaped context exposing just enough of `speechToText` to drive the plugin. */
function mockContext() {
  const providers = new Map();
  const state = { raw: '', transcribeCalls: 0 };
  providers.set('sensevoice-local', {
    info: { id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['zh'], downloadSources: [] },
    transcribe: async () => {
      state.transcribeCalls++;
      return { text: state.raw, audioSeconds: 1.5, inferenceSeconds: 0.4 };
    },
  });
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { const dispose = fn(); return () => dispose?.(); },
    speechToText: {
      listProviders: () => [...providers.values()].map((p) => p.info),
      resolve: ({ providerId, audio, language }) => {
        const provider = providers.get(providerId ?? 'sensevoice-local');
        if (!provider) throw new Error(`no provider ${providerId}`);
        return { provider, audio, language };
      },
      transcribe: async (spec) => spec.provider.transcribe(),
      register: (p) => { providers.set(p.info.id, p); return () => providers.delete(p.info.id); },
    },
  };
  return { ctx, providers, state };
}

/** Boot the plugin against a throwaway data dir and return a `say` helper. */
async function boot(dir) {
  const { ctx, providers, state } = mockContext();
  apply(ctx, { dataDir: dir, requireEnrolledSpeaker: false });
  const provider = providers.get('personal-local');
  assert.ok(provider, 'the plugin must register its provider');
  return {
    internals, providers, state,
    async say(text) {
      state.raw = text;
      return provider.transcribe({ audio: Buffer.alloc(0), language: 'zh' }, undefined);
    },
  };
}

test('a dictation is corrected end to end through the plugin', async () => {
  const app = await boot(tmpdir());
  const out = await app.say('帮我稳定我现在的flcash');
  assert.equal(out.text, '帮我稳定我现在的 FlClash');
  assert.equal(out.audioSeconds, 1.5);
});

test('a user term takes effect on the next dictation, with no restart', async () => {
  const dir = tmpdir();
  const app = await boot(dir);
  // A term the shipped glossary does not know, so the change can only come from the file.
  assert.equal((await app.say('新项目叫zephyrboard')).text, '新项目叫 zephyrboard');

  writeTerms(dir, [{ say: 'ZephyrBoard', heard: ['zephyrboard'] }]);
  assert.equal((await app.say('新项目叫zephyrboard')).text, '新项目叫 ZephyrBoard');

  // And removing it again takes effect just as immediately.
  writeTerms(dir, []);
  assert.equal((await app.say('新项目叫zephyrboard')).text, '新项目叫 zephyrboard');
});

test('an unchanged file reuses the built corrector', async () => {
  const dir = tmpdir();
  const app = await boot(dir);
  writeTerms(dir, [{ say: 'PlantMerge', heard: ['plantmerge'] }]);
  await app.say('anything');
  const first = app.internals.corrector;
  await app.say('anything');
  assert.equal(app.internals.corrector, first, 'indexing 26k entries per dictation would be wasteful');
});

test('a conflicting user mapping is dropped, while the rest of the file still applies', async () => {
  const dir = tmpdir();
  const app = await boot(dir);
  writeTerms(dir, [
    { say: 'MyCloud', heard: ['cloud'] },   // would rewrite every real "cloud"
    { say: 'Cloud' },                        // …because this makes "cloud" a canonical
    { say: 'PlantMerge', heard: ['plantmerge'] },
  ]);
  const out = await app.say('the cloud is down');
  assert.ok(!/MyCloud/.test(out.text), `the dropped mapping fired: ${out.text}`);
  // The surviving `Cloud` term still case-folds `cloud` -> `Cloud`. That looks alarming but
  // is the engine working as specified: a declared canonical matches case-insensitively.
  // The hazard of declaring an ordinary English word is documented, not silently ignored.
  assert.equal(out.text, 'the Cloud is down');
  // …and the unrelated entry in the same file is unaffected by the neighbour's mistake.
  assert.equal((await app.say('新项目叫plantmerge')).text, '新项目叫 PlantMerge');
});

test('a user term still cannot corrupt already-correct text', async () => {
  const dir = tmpdir();
  const app = await boot(dir);
  writeTerms(dir, [{ say: 'PlantMerge', heard: ['plantmerge'] }]);
  for (const text of ['人物关系很复杂', 'cd ~/projects/harness.git', 'def foo():\n    return 1']) {
    assert.equal((await app.say(text)).text, text, text);
  }
});

test('a broken terms file does not lose the dictation', async () => {
  const dir = tmpdir();
  const app = await boot(dir);
  writeTerms(dir, '{ this is not json');
  const out = await app.say('帮我稳定我现在的flcash');
  assert.equal(out.text, '帮我稳定我现在的 FlClash', 'shipped terms still apply');
});

// ── the CLI ─────────────────────────────────────────────────────────────────────────

const runCli = (dir, args) => execFileSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, DSH_VOICE_PERSONAL_DIR: dir },
  encoding: 'utf8',
});

test('the CLI adds, lists and removes without touching the package', () => {
  const dir = tmpdir();
  runCli(dir, ['add', 'FlClash', '--heard', 'flcash']);
  const file = path.join(dir, USER_TERMS_FILE);
  assert.ok(fs.existsSync(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).terms, [{ say: 'FlClash', heard: ['flcash'] }]);

  runCli(dir, ['add', 'PlantMerge']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).terms.length, 2);

  assert.match(runCli(dir, ['list']), /PlantMerge/);
  runCli(dir, ['remove', 'PlantMerge']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).terms.length, 1);
});

test('the CLI refuses to write a conflicting term, and leaves the file byte-identical', () => {
  const dir = tmpdir();
  runCli(dir, ['add', 'Cloud']);
  const file = path.join(dir, USER_TERMS_FILE);
  const before = fs.readFileSync(file, 'utf8');

  let exitCode = 0;
  let stderr = '';
  try {
    runCli(dir, ['add', 'Claude', '--heard', 'cloud']);
  } catch (error) {
    exitCode = error.status;
    stderr = String(error.stderr ?? '');
  }
  assert.equal(exitCode, 1, 'a conflict must be a non-zero exit');
  assert.match(stderr, /canonical spelling of "Cloud"/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file must not be written on refusal');
});

test('the CLI round-trips through export and import', () => {
  const dir = tmpdir();
  runCli(dir, ['add', 'FlClash', '--heard', 'flcash']);
  const exported = runCli(dir, ['export']);
  const parsed = JSON.parse(exported);
  assert.deepEqual(parsed.terms, [{ say: 'FlClash', heard: ['flcash'] }]);

  const other = tmpdir();
  const dump = path.join(other, 'dump.json');
  fs.writeFileSync(dump, exported);
  runCli(other, ['import', dump]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, USER_TERMS_FILE), 'utf8')).terms.length, 1);
});

test('the CLI imports CSV and ignores a header row', () => {
  const dir = tmpdir();
  const csv = path.join(dir, 'in.csv');
  fs.writeFileSync(csv, 'say,heard\nTapTap,taptap|toptop\nPlantMerge,\n');
  runCli(dir, ['import', csv]);
  const terms = JSON.parse(fs.readFileSync(path.join(dir, USER_TERMS_FILE), 'utf8')).terms;
  assert.deepEqual(terms.find((t) => t.say === 'TapTap'), { say: 'TapTap', heard: ['taptap', 'toptop'] });
  assert.deepEqual(terms.find((t) => t.say === 'PlantMerge'), { say: 'PlantMerge', heard: [] });
});

test('the CLI reports a conflict through `check` without changing anything', () => {
  const dir = tmpdir();
  runCli(dir, ['add', 'FlClash']);
  const file = path.join(dir, USER_TERMS_FILE);
  const before = fs.readFileSync(file, 'utf8');
  writeTerms(dir, [{ say: 'MyCloud', heard: ['cloud'] }, { say: 'Cloud' }]);

  let exitCode = 0;
  let stdout = '';
  try { runCli(dir, ['check']); } catch (error) { exitCode = error.status; stdout = String(error.stdout ?? ''); }
  assert.equal(exitCode, 1);
  assert.match(stdout, /canonical spelling of "Cloud"/);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal((Array.isArray(raw) ? raw : raw.terms).length, 2, 'check must not rewrite the file');
  void before;
});

test('two same-length edits are both picked up, even within one millisecond', () => {
  // The reason the cache key is file *content* rather than `mtimeMs:size`. With the cheap
  // key these two writes can collide and the second edit silently does nothing.
  const dir = tmpdir();
  const loader = createUserTermsLoader({ dir });
  const file = path.join(dir, USER_TERMS_FILE);
  fs.writeFileSync(file, JSON.stringify([{ say: 'AAAA', heard: ['x'] }]));
  assert.equal(loader.load().terms[0].say, 'AAAA');
  fs.writeFileSync(file, JSON.stringify([{ say: 'BBBB', heard: ['x'] }]));
  assert.equal(loader.load().terms[0].say, 'BBBB');
});
