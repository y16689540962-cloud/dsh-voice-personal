/**
 * Tests for the learning filter in `scripts/learn.mjs`.
 *
 * This filter is load-bearing: `style.json` is applied to every dictation automatically, so
 * whatever leaks through becomes the user's "writing habits". The first version of it only
 * rejected whole messages whose *opening* matched a boilerplate pattern, which let three
 * things straight into the profile:
 *
 *   - `<goal_round>` autonomous-continuation prompts   → goal, objective, round
 *   - `Current runtime context…` snapshots             → justin, Users, Downloads
 *   - `Instructions from: AGENTS.md`                   → policy, workspace, available, claim
 *
 * The last two are *appended* to the user's own turn and are multi-paragraph, so the fix is
 * to strip injected blocks and judge what remains — not to reject the message, which would
 * throw away the dictation the message actually contains.
 *
 * The test drives the real script over a synthetic corpus rather than re-implementing the
 * filter, so it fails if the script and these expectations ever disagree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEARN = path.join(ROOT, 'scripts', 'learn.mjs');

let n = 0;
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), `vp-learn-${process.pid}-${n++}-`));

/** Write a session file the way the harness does: one zstd frame per appended message. */
function writeSession(dir, texts) {
  const sessionDir = path.join(dir, '--workspace--', `session-${n++}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const frames = texts.map((t) => zlib.zstdCompressSync(
    Buffer.from(`${JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: t }] } })}\n`),
  ));
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
}

/**
 * Run the learner over `dir` and return its stdout.
 *
 * A non-zero exit is expected when nothing survives the filter — the script refuses to write
 * a profile built from no corpus, which is the right behaviour. Tests that care about the
 * exit code drive the process themselves.
 */
function runLearn(dir) {
  const out = tmpdir();
  try {
    return execFileSync(process.execPath, [LEARN, '--sessions', dir, '--out', out, '--dry-run'], {
      encoding: 'utf8',
    });
  } catch (error) {
    return String(error.stdout ?? '');
  }
}

/** Parse "其中本人手写 N 条（M 字）" out of the summary line. */
function keptCount(stdout) {
  const m = stdout.match(/其中本人手写 (\d+) 条/);
  assert.ok(m, `summary line not found in:\n${stdout}`);
  return Number(m[1]);
}

test('a plain user message is kept', () => {
  const dir = tmpdir();
  writeSession(dir, ['帮我稳定我现在使用的 vpn']);
  assert.equal(keptCount(runLearn(dir)), 1);
});

test('a dictation with a trailing AGENTS.md block keeps the dictation and drops the block', () => {
  const dir = tmpdir();
  writeSession(dir, [
    '呃帮我稳定我现在的flcash。订阅要续一下。\n\n'
    + 'Instructions from: /tmp/AGENTS.md\n\n'
    + '# 项目约定\n\n这是注入的正文，里面有很多 policy 和 workspace 这样的英文词，'
    + '它不该被当成用户说的话。继续写很长很长很长，确保如果只剥掉标题行，正文会整个漏进来。',
  ]);
  const stdout = runLearn(dir);
  assert.equal(keptCount(stdout), 1, 'the dictation must survive');
  // The injected body must not contribute vocabulary.
  assert.ok(!/policy|workspace/.test(stdout), 'AGENTS.md body leaked into the candidates');
});

test('a trailing runtime-context snapshot is stripped', () => {
  const dir = tmpdir();
  writeSession(dir, [
    '这个是机场，我害怕他跑路了\n\n'
    + 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n'
    + 'Current DSH file policy: workspace-write. Any available operation is permitted. '
    + 'Approval policy changed. claim temporary request available write operation.',
  ]);
  const stdout = runLearn(dir);
  assert.equal(keptCount(stdout), 1);
  assert.ok(!/Downloads|Users/.test(stdout), 'path fragments leaked from the snapshot');
});

test('injection-only messages and notifications are dropped entirely', () => {
  const dir = tmpdir();
  writeSession(dir, [
    '<goal_round>\nObjective: "build the thing"\nRound: 1/12\n继续推进。\n</goal_round>',
    '[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: [{"schedule_id":"x"}]',
    'background job bash-1 (bash: echo hi) finished [status: completed]',
    'Agent 12345678-1234-1234-1234-123456789abc sent a message: INTERIM FINDING',
    '你是 DSH 语音插件项目的声纹模块负责人。先读共享任务板上的 task-1（用 team_task_get），然后 claim 它。',
  ]);
  assert.equal(keptCount(runLearn(dir)), 0, 'none of these are the user speaking');
});

test('over-long messages are dropped as agent prose', () => {
  const dir = tmpdir();
  writeSession(dir, ['短消息', '这'.repeat(900)]);
  assert.equal(keptCount(runLearn(dir)), 1);
});

test('the cutoff is configurable and reported', () => {
  const dir = tmpdir();
  writeSession(dir, ['这'.repeat(300)]);
  const out = tmpdir();
  const stdout = execFileSync(process.execPath,
    [LEARN, '--sessions', dir, '--out', out, '--dry-run', '--max-chars', '900'],
    { encoding: 'utf8' });
  assert.equal(keptCount(stdout), 1);
});

test('an unknown flag is refused instead of silently running for real', () => {
  // This destroyed a profile once: `learn.mjs --bad-arg` was expected to complain about the
  // argument, but unknown flags were ignored, so it ran the full pipeline and overwrote the
  // user's existing style.json.
  const dir = tmpdir();
  writeSession(dir, ['帮你稳定我现在使用的 vpn']);
  const out = tmpdir();
  let code = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [LEARN, '--sessions', dir, '--out', out, '--bad-arg'],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    code = error.status;
    stderr = String(error.stderr ?? '');
  }
  assert.equal(code, 2, 'an unknown flag must be a hard stop');
  assert.match(stderr, /未知参数/);
  assert.ok(!fs.existsSync(path.join(out, 'style.json')), 'nothing may be written');
  assert.ok(!fs.existsSync(path.join(out, 'glossary.json')), 'nothing may be written');
});

test('writing keeps a copy of the profile it replaces', () => {
  const dir = tmpdir();
  writeSession(dir, ['帮你稳定我现在使用的 vpn']);
  const out = tmpdir();
  const run = () => execFileSync(process.execPath,
    [LEARN, '--sessions', dir, '--out', out], { encoding: 'utf8' });

  const first = run();
  assert.ok(fs.existsSync(path.join(out, 'style.json')));
  assert.ok(!/将覆盖/.test(first), 'first run has nothing to replace');

  const second = run();
  assert.match(second, /将覆盖已有画像/);
  assert.ok(fs.existsSync(path.join(out, 'style.json.prev')), 'the replaced profile must be kept');
});
