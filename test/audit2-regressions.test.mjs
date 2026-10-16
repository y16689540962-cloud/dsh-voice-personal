/**
 * Regression tests for the second adversarial audit (`docs/audit-2.md`).
 *
 * Every test here failed before its fix. They exist because the first audit's nine defect
 * classes came back in a new shape once — a parallel code path with no guard resurrected the
 * unbounded-growth bug — so "we fixed it" is only worth anything if something keeps checking.
 *
 * Each test names the finding it pins down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCorrector } from '../lib/correct/index.js';
import { createUserTermsLoader } from '../lib/correct/user-terms.js';
import { apply } from '../index.js';

const PUA = /[\uE000-\uF8FF]/;
const dict = (terms, pairs) => createCorrector({ terms, pairs });

let n = 0;
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), `vp-a2-${process.pid}-${n++}-`));

// ── A1: masking/restore nesting leaked invisible private-use characters ─────────────

test('A1: an inline-code span containing another protected span survives intact', () => {
  // The backtick rule matched `` ` `` … `` ` `` with a class that swallowed the sentinels
  // earlier rules had already inserted. Restore did a single pass and never rescanned what it
  // put back, so the inner sentinel stayed in the output as an invisible U+E000.
  const c = dict([{ say: 'GitHub', heard: ['github', 'ghub'] }]);
  const cases = [
    '这是 `v2.0.1` 版本',
    '发给 `x@y.com` 就行',
    '用 `--force` 参数',
    'run `npm i -g foo --verbose` now',
    '看 `https://a.b/c 说明` 链接',
    '把 `github` 发上去',
    // Doubled backticks are *not* a code span under this rule (`` `` `` matches as an empty
    // span), so `github` is genuinely outside protection and is corrected. That is the rule
    // working, not a leak — the assertion is only about the invisible characters.
    '嵌套 `a `b` c` 结束',
  ];
  for (const s of cases) {
    const r = c.correct(s);
    assert.ok(!PUA.test(r.text), `${JSON.stringify(s)} leaked ${JSON.stringify(r.text)}`);
    if (s === '嵌套 `a `b` c` 结束') continue; // masking contract, not byte-identity
    assert.equal(r.text, s, s);
  }
});

test('A1: the full protected-span matrix is inert inside inline code', () => {
  const c = dict([{ say: 'GitHub' }, { say: 'Harness' }]);
  const inner = [
    'v1.2.3', '1.0', 'user@example.com', '--flag', 'https://a.b/c', 'https://a.b/c x',
    '~/p/q.js', '/abs/path', 'C:\\win\\path', 'harness.git', 'a@b.co #x', '--a --b',
  ];
  for (const x of inner) {
    for (const template of ['`%s`', '看 `%s` 这里', 'x `%s`', '`%s` y', '`%s` `%s`']) {
      const s = template.split('%s').join(x).replace('`%s`', '`' + x + '`');
      const r = c.correct(s);
      assert.ok(!PUA.test(r.text), `leak for ${JSON.stringify(s)} -> ${JSON.stringify(r.text)}`);
      assert.equal(r.text, s, s);
    }
  }
});

// ── A2: `pairs` bypassed every guard ───────────────────────────────────────────────

test('A2: a pair that would grow the output is refused, not applied', () => {
  // `{heard:'cocos', say:'Cocos Creator'}` is the shape that produced
  // `Cocos Creator Creator` -> `… Creator Creator` -> … before.
  const c = dict([], [{ heard: 'cocos', say: 'Cocos Creator' }]);
  assert.deepEqual(c.dropped, ['Cocos Creator ← cocos']);
  let s = 'Cocos Creator 是我在用的引擎';
  for (let i = 0; i < 6; i++) s = c.correct(s).text;
  assert.equal(s, 'Cocos Creator 是我在用的引擎');
});

test('A2: a legitimate pair still works', () => {
  const c = dict([], [{ heard: 'zzheard', say: 'ZzCanonical' }]);
  assert.deepEqual(c.dropped, []);
  assert.equal(c.correct('the zzheard is here').text, 'the ZzCanonical is here');
});

test('A2: a pair colliding with another term\'s canonical is refused', () => {
  const c = dict([{ say: 'Cloud' }], [{ heard: 'cloud', say: 'Claude' }]);
  assert.equal(c.dropped.length, 1);
  // `Cloud` survives: the bad mapping is gone, the term is not.
  assert.equal(c.correct('the cloud is down').text, 'the Cloud is down');
});

test('A2: the engine guards its own inputs, whatever the caller does', () => {
  // Guards live in createCorrector, not only at the plugin's call site, so no configuration
  // shape can reach the index unchecked.
  const c = dict([{ say: 'Cocos Creator', heard: ['cocoscreator'] }], [{ heard: 'cocos', say: 'Cocos Creator' }]);
  assert.ok(c.dropped.length > 0);
  assert.equal(c.correct('cocoscreator 项目').text, 'Cocos Creator 项目');
});

// ── A3: a path glued to Chinese was not masked ─────────────────────────────────────

test('A3: a path immediately after a Chinese character is protected', () => {
  const c = dict([{ say: 'FlClash', heard: ['flcash'] }, { say: 'DSH' }]);
  for (const s of ['看/Users/x/flcash 这个路径', '去~/flcash 目录', '在/tmp/flcash里']) {
    assert.equal(c.correct(s).text, s, s);
  }
});

// ── A4: identifiers and ordinary words ─────────────────────────────────────────────

test('A4: underscore-joined identifiers are never rewritten', () => {
  const c = dict([{ say: 'Agent' }, { say: 'Claude' }, { say: 'Harness' }, { say: 'GitHub' }]);
  for (const s of ['agent_id 别改', 'claude_local 和 codex_local', 'my_harness_thing', 'GH_github_TOKEN']) {
    assert.equal(c.correct(s).text, s, s);
  }
  // …but a standalone occurrence is still normalised.
  assert.equal(c.correct('用 agent 跑一下').text, '用 Agent 跑一下');
});

// ── A7: an unreadable terms file must not erase the glossary ───────────────────────

test('A7: a fault reading the file keeps the last good terms', () => {
  const dir = tmpdir();
  const logger = { warn() {} };
  const loader = createUserTermsLoader({ dir, logger });
  fs.writeFileSync(path.join(dir, 'terms.json'), JSON.stringify([{ say: 'ZzKeep', heard: ['zzkeep'] }]));
  assert.equal(loader.load().terms.length, 1);

  // EISDIR: the path is now a directory, so reading it fails with a code that is not ENOENT.
  fs.unlinkSync(path.join(dir, 'terms.json'));
  fs.mkdirSync(path.join(dir, 'terms.json'));
  const after = loader.load();
  assert.equal(after.terms.length, 1, 'a fault must not silently drop working terms');
  assert.equal(after.terms[0].say, 'ZzKeep');
  assert.ok(after.error);
});

test('A7: a genuinely missing file still means "no user terms"', () => {
  const loader = createUserTermsLoader({ dir: tmpdir() });
  const r = loader.load();
  assert.deepEqual(r.terms, []);
  assert.equal(r.error, null);
});

// ── A8: config values are validated rather than silently misinterpreted ────────────

function mockCtx() {
  const providers = new Map();
  providers.set('sensevoice-local', {
    info: { id: 'sensevoice-local', name: 'S', location: 'host-local', languages: ['zh'], downloadSources: [] },
    transcribe: async () => ({ text: 'x', audioSeconds: 1, inferenceSeconds: 0 }),
  });
  return {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { fn(); },
    speechToText: {
      listProviders: () => [...providers.values()].map((p) => p.info),
      resolve: ({ providerId }) => {
        const provider = providers.get(providerId ?? 'sensevoice-local');
        if (!provider) throw new Error('nope');
        return { provider };
      },
      transcribe: async (spec) => spec.provider.transcribe(),
      register: (p) => { providers.set(p.info.id, p); return () => {}; },
    },
  };
}

test('A8: a truthy string does not silently enable the speaker gate', () => {
  // `requireEnrolledSpeaker: "False"` is truthy. Before validation it turned the gate ON and
  // every dictation was rejected — the exact opposite of what the user wrote.
  assert.throws(
    () => apply(mockCtx(), { dataDir: tmpdir(), requireEnrolledSpeaker: 'False' }),
    /需要 true\/false/,
  );
});

test('A8: a misspelled spacing value is refused instead of falling through to "none"', () => {
  for (const bad of ['space ', 'Space', 'spaces', '']) {
    // Empty means "use the default", so it must NOT throw.
    if (bad === '') { assert.doesNotThrow(() => apply(mockCtx(), { dataDir: tmpdir(), spacing: bad })); continue; }
    assert.throws(() => apply(mockCtx(), { dataDir: tmpdir(), spacing: bad }), /spacing/, bad);
  }
});

test('A8: a numeric option given a string is refused', () => {
  assert.throws(() => apply(mockCtx(), { dataDir: tmpdir(), voiceprintThreshold: '0.62' }), /需要数字/);
});
