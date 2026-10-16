/**
 * The package's own suite. Split by intent: what it fixes, what it must never touch, and
 * what it refuses to build. The middle group is the important one — a personal dictionary
 * that occasionally rewrites ordinary text is worse than no dictionary, because the user
 * has no way to notice which of their sentences it edited.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDictionary,
  validateTerms,
  CORRECT_VERSION,
  DEFAULTS,
  fold,
} from '../index.js';

const dict = (terms, options) => createDictionary({ terms, options });

// ── what it fixes ───────────────────────────────────────────────────────────────────

test('a plain string term normalises casing only', () => {
  const d = dict(['DSH', 'GitHub']);
  assert.equal(d.correct('dsh 的识别有点问题'), 'DSH 的识别有点问题');
  assert.equal(d.correct('发到github上'), '发到 GitHub 上');
});

test('a mis-hearing is rewritten to its canonical spelling', () => {
  const d = dict([{ say: 'FlClash', heard: ['flcash'] }, { say: 'WorkBuddy', heard: ['workbody'] }]);
  assert.equal(d.correct('帮我稳定我现在的flcash'), '帮我稳定我现在的 FlClash');
  assert.equal(d.correct('了解一下workbody好几个账号'), '了解一下 WorkBuddy 好几个账号');
});

test('a multi-word canonical form is fixed whether glued, spaced or lower-cased', () => {
  const d = dict([{ say: 'Cocos Creator', heard: ['cocoscreator'] }]);
  assert.equal(d.correct('用CocosCreator做游戏'), '用 Cocos Creator 做游戏');
  assert.equal(d.correct('cocos creator 项目'), 'Cocos Creator 项目');
});

test('a Chinese mis-hearing maps onto a Latin term', () => {
  const d = dict([{ say: 'Harness', heard: ['哈里斯', '哈内斯'] }]);
  assert.equal(d.correct('这应该是哈里斯的工作吗'), '这应该是 Harness 的工作吗');
  assert.equal(d.correct('这应该是哈内斯的工作吗'), '这应该是 Harness 的工作吗');
});

test('several corrections in one code-switched sentence', () => {
  const d = dict(['APK', { say: 'GitHub', heard: ['ghub'] }]);
  assert.equal(
    d.correct('帮我把这个插件发到gHub上然后更新一下apk的版本'),
    '帮我把这个插件发到 GitHub 上然后更新一下 APK 的版本',
  );
});

test('correctWithChanges reports every rewrite', () => {
  const d = dict([{ say: 'FlClash', heard: ['flcash'] }]);
  const { text, changes } = d.correctWithChanges('用flcash');
  assert.equal(text, '用 FlClash');
  assert.ok(changes.some((c) => c.before === 'flcash' && c.after === 'FlClash'));
});

// ── what it must never touch ────────────────────────────────────────────────────────

test('it never rewrites Chinese into Chinese', () => {
  // The engine once matched by toneless pinyin, which cannot separate these. Keeping a
  // cross-script term loaded proves the pinyin index itself is not the source of damage.
  const d = dict([{ say: 'Harness', heard: ['哈里斯'] }]);
  for (const s of ['人物关系很复杂', '这是一部好电影', '信条很重要', '便衣警察',
    '接点电阻', '配制溶液', '变异病毒', '一步一步来', '工作太累了', '哈里王子']) {
    assert.equal(d.correct(s), s, s);
  }
});

test('it leaves ordinary English words alone', () => {
  const d = dict([{ say: 'Gradle' }, { say: 'Harness' }, { say: 'Claude' }, { say: 'Cocos Creator' }]);
  for (const s of ['my grade is A', 'the cloud is down', 'harris county',
    'upgrade the build', 'a harmless joke', 'sadness', 'cocoa']) {
    assert.equal(d.correct(s), s, s);
  }
});

test('protected spans survive: URLs, paths, extensions, versions, flags, code', () => {
  const d = dict([{ say: 'GitHub' }, { say: 'Harness' }, { say: 'Gradle' }]);
  for (const s of [
    'https://github.com/y16689540962-cloud/dsh-voice-personal',
    'cd ~/projects/harness.git',
    'harness.git',
    'grade.js',
    'v1.2.3',
    '--github',
    '`github`',
    'user@example.com',
    '127.0.0.1:19387',
  ]) {
    assert.equal(d.correct(s), s, s);
  }
});

test('indentation and newlines are preserved', () => {
  const d = dict([{ say: 'Harness' }]);
  assert.equal(d.correct('def foo():\n    if x:\n        return 1'), 'def foo():\n    if x:\n        return 1');
  assert.equal(d.correct('key:\n  value: 1\n  other: 2'), 'key:\n  value: 1\n  other: 2');
  assert.equal(d.correct('if x:\n\treturn 1'), 'if x:\n\treturn 1');
});

test('traditional characters are passed through untouched', () => {
  const d = dict([{ say: 'Harness' }]);
  for (const s of ['工作臺的识别', '編譯通過了', '任務完成了']) assert.equal(d.correct(s), s, s);
});

test('an empty dictionary corrects nothing', () => {
  const d = dict([]);
  for (const s of ['flcash', 'dsh', '人物关系很复杂']) assert.equal(d.correct(s), s, s);
  assert.equal(d.terms.length, 0);
});

test('it is idempotent', () => {
  const d = dict([
    'DSH', 'GitHub', 'APK',
    { say: 'FlClash', heard: ['flcash'] },
    { say: 'Cocos Creator', heard: ['cocoscreator'] },
    { say: 'DeepSeek', heard: ['deepseek', 'deep seek'] },
    { say: 'Harness', heard: ['哈里斯'] },
  ]);
  for (const s of [
    '用cocoscreator做的游戏要发到taptap',
    '反代到deep seek harness',
    '这应该是哈里斯的工作吗',
    'Cocos Creator Creator',
    'cocos creator',
    'dsh 和 flcash 和 ghub',
  ]) {
    const once = d.correct(s);
    assert.equal(d.correct(once), once, s);
    assert.equal(d.correct(d.correct(once)), once, s);
  }
});

test('non-string input is coerced, never thrown on', () => {
  const d = dict(['DSH']);
  assert.equal(d.correct(''), '');
  assert.equal(d.correct(null), '');
  assert.equal(d.correct(undefined), '');
  assert.equal(d.correct(42), '42');
});

// ── what it refuses to build ────────────────────────────────────────────────────────

test('a mis-hearing that collides with another term is rejected', () => {
  assert.throws(
    () => dict([{ say: 'Claude', heard: ['cloud'] }, { say: 'Cloud' }]),
    /canonical spelling of "Cloud"/,
  );
});

test('a mis-hearing claimed by two terms is rejected', () => {
  assert.throws(
    () => dict([{ say: 'FlClash', heard: ['flcash'] }, { say: 'FlCash', heard: ['flcash'] }]),
    /claimed by both/,
  );
});

test('a mis-hearing inside its own multi-word canonical is rejected', () => {
  // `cocos` under `Cocos Creator` made the phrase pass and the token pass feed each other.
  assert.throws(
    () => dict([{ say: 'Cocos Creator', heard: ['cocos'] }]),
    /substring of its own canonical form/,
  );
});

test('allowConflicts skips the exception, but the engine still refuses the unsafe entry', () => {
  const d = createDictionary({ terms: [{ say: 'Cocos Creator', heard: ['cocos'] }], allowConflicts: true });
  assert.ok(d.warnings.some((w) => /substring/.test(w)));
  // `allowConflicts` opts out of *throwing*. It does not opt out of safety: the engine runs
  // its own guards on whatever it is handed, so even this configuration cannot produce the
  // unbounded growth it used to (13 → 21 → 29 → 45 characters per pass).
  const once = d.correct('Cocos Creator');
  assert.equal(once, 'Cocos Creator');
  assert.equal(d.correct(once), once, 'must be idempotent even under allowConflicts');
});

test('the engine reports what it dropped, so a caller is never silently overruled', () => {
  const d = createDictionary({ terms: [{ say: 'Cocos Creator', heard: ['cocos'] }], allowConflicts: true });
  assert.ok(d.warnings.some((w) => /cocos/.test(w)), `dropped entry not surfaced: ${JSON.stringify(d.warnings)}`);
});

test('a short prefix mis-hearing is a warning, not a rejection', () => {
  const { errors, warnings } = validateTerms([{ say: 'WorkBuddy', heard: ['work'] }]);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
});

test('malformed terms are rejected with a useful message', () => {
  assert.throws(() => dict([{ heard: ['x'] }]), /expected a string or/);
  assert.throws(() => dict([{ say: 'A', heard: 'b' }]), /heard must be an array/);
  assert.throws(() => dict([{ say: 'A', heard: [''] }]), /heard must be an array/);
  assert.throws(() => dict('DSH'), /terms must be an array/);
});

test('duplicate canonical spellings are merged', () => {
  const d = dict([{ say: 'FlClash', heard: ['flcash'] }, { say: 'FlClash', heard: ['flclash'] }]);
  assert.equal(d.terms.length, 1);
  assert.deepEqual([...d.terms[0].heard].sort(), ['flcash', 'flclash']);
  assert.equal(d.correct('flclash'), 'FlClash');
});

// ── surface ─────────────────────────────────────────────────────────────────────────

test('the exposed terms are frozen copies', () => {
  const d = dict([{ say: 'FlClash', heard: ['flcash'] }]);
  assert.throws(() => { d.terms[0].say = 'X'; }, TypeError);
  assert.throws(() => { d.terms[0].heard.push('y'); }, TypeError);
});

test('options and helpers are reachable', () => {
  const d = dict(['DSH'], { fuzzyTerms: false });
  assert.equal(d.options.spacing, DEFAULTS.spacing);
  assert.equal(d.options.fuzzyTerms, false);
  assert.equal(typeof d.version, 'number');
  assert.equal(d.version, CORRECT_VERSION);
  assert.equal(fold('Deep-Seek'), 'deepseek');
  assert.equal(dict(['DSH']).warnings.length, 0);
});

test('spacing can be turned off', () => {
  const d = dict([{ say: 'GitHub', heard: ['ghub'] }], { spacing: 'none' });
  assert.equal(d.correct('发到 ghub 上'), '发到GitHub上');
});
