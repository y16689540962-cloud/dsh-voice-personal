#!/usr/bin/env node
/**
 * End-to-end regression test for the personal correction pipeline.
 *
 * Two properties, in this order of importance:
 *   1. **Never corrupt already-correct text.** A false negative (a missed fix) costs the
 *      user a small edit. A false positive silently changes the meaning of their message.
 *      Every `GUARDS` entry in the glossary exists because an earlier revision damaged it.
 *   2. Fix the real mis-hearings observed in the user's own session history.
 *
 * Sections 三 to 九 are the adversarial verification report's reproducers, kept as
 * executable proof that each confirmed defect stays fixed.
 *
 * Run: node test/correct.test.mjs
 */
import { createCorrector } from '../lib/correct/index.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, got, want) {
  if (got === want) { pass++; return true; }
  fail++;
  failures.push({ label, got, want });
  return false;
}

const corrector = createCorrector();

/** Real mis-hearings from the user's session history, with the text they meant. */
const CORRECTIONS = [
  { in: 'flcash 帮我稳定一下', want: 'FlClash 帮我稳定一下' },
  { in: '了解一下workbody好几个账号', want: '了解一下 WorkBuddy 好几个账号' },
  { in: '这应该是哈里斯的工作吗', want: '这应该是 Harness 的工作吗' },
  { in: '你给我上github前索一下', want: '你给我上 GitHub 前索一下' },
  { in: '反代到deepseek harness', want: '反代到 DeepSeek Harness' },
  { in: '发布到 toptop 是不是要屏蔽', want: '发布到 TapTap 是不是要屏蔽' },
  { in: '接入我的 obsidian', want: '接入我的 Obsidian' },
];

/** Text that must survive untouched. */
const IDENTITY = [
  '工作台的识别有点问题',
  '我想做一个插件',
  '就是这个问题',
  '这个功能不错',
  '那个方案可行',
  '然后我们就开始干活',
  '插件已经装好了',
  '心跳正常',
  '任务完成了',
  '灵感管家负责这个',
  '服务器已经重启',
  '数据库连接正常',
  '接口文档在这里',
];

console.log('=== 一、真实识别错误纠正 ===');
for (const c of CORRECTIONS) {
  const { text } = corrector.correct(c.in);
  if (check(c.in, text, c.want)) console.log(`  ok   ${JSON.stringify(c.in)} -> ${JSON.stringify(text)}`);
  else console.log(`  FAIL ${JSON.stringify(c.in)}\n       got  ${JSON.stringify(text)}\n       want ${JSON.stringify(c.want)}`);
}

console.log('\n=== 二、正确文本不得被破坏 ===');
for (const t of IDENTITY) {
  const { text, changes } = corrector.correct(t);
  const harmful = changes.filter(c => ['cross-script', 'latin', 'latin-phrase'].includes(c.type));
  if (check(t, text, t) && harmful.length === 0) console.log(`  ok   ${JSON.stringify(t)}`);
  else console.log(`  FAIL ${JSON.stringify(t)} -> ${JSON.stringify(text)} ${JSON.stringify(harmful)}`);
}

console.log('\n=== 三、回归：同音词不得误伤正常中文（对抗验证 D1）===');
const NO_FALSE_POSITIVES = [
  '人物关系很复杂', '他是个大人物', '人物设定很好',
  '一步一步来', '进一步说明', '一步到位', '这是一部好电影', '一部手机',
  '信条很重要', '遵守信条',
  '便衣警察', '便衣行动',
  '接点电阻', '接点氧化', '两个接点',
  '配制溶液', '配制方法', '按比例配制',
  '待码农来写', '变异病毒', '文当中的内容',
  '工作太累了', '哈里王子', '编译错误已修', '编译通过了',
  '代码写完了', '接口文档在这里', '这是输入框', '那是输出结果',
  '数据库连接正常', '服务器已经重启', '任务列表为空', '心跳检测正常',
  '配置文件在这里', '异步任务队列', '这个接口的输入输出都要改',
  '文档和代码都要同步', '服务器和数据库都重启了', '任务完成了，心跳正常',
  '异步配置需要调整',
];
for (const t of NO_FALSE_POSITIVES) {
  const { text, changes } = corrector.correct(t);
  const harmful = changes.filter(c => ['cross-script', 'latin', 'latin-phrase'].includes(c.type));
  if (check(`no-fp:${t}`, text, t) && harmful.length === 0) console.log(`  ok   ${JSON.stringify(t)}`);
  else console.log(`  FAIL ${JSON.stringify(t)} -> ${JSON.stringify(text)} ${JSON.stringify(harmful)}`);
}

console.log('\n=== 四、回归：英文实词不得被改写（对抗验证 D2/D3）===');
const LATIN_FP = [
  'my grade is A', 'the cloud is down', 'harris county',
  'upgrade to the new version', 'a harmless joke', 'sadness is normal',
  'cocoa is tasty', 'acloud storage', 'aggrade steel',
];
for (const t of LATIN_FP) {
  const { text, changes } = corrector.correct(t);
  if (check(`latin-fp:${t}`, text, t)) console.log(`  ok   ${JSON.stringify(t)}`);
  else console.log(`  FAIL ${JSON.stringify(t)} -> ${JSON.stringify(text)} ${JSON.stringify(changes)}`);
}

console.log('\n=== 五、回归：路径/文件名/代码不得被改（对抗验证 D4）===');
const PROTECTED_CASES = [
  'cd ~/projects/harness.git',
  'rm -rf harness.git',
  'look at grade.js please',
  'open cocos.js',
  'https://github.com/foo/bar.git',
  'user@example.com sent it',
  'we upgraded to v1.2.3 today',
  'run with --force flag',
  'see `npm run build` output',
  '~/Downloads/工作台/dsh-voice-personal',
];
for (const t of PROTECTED_CASES) {
  const { text, changes } = corrector.correct(t);
  const harmful = changes.filter(c => ['cross-script', 'latin', 'latin-phrase'].includes(c.type));
  if (check(`protected:${t}`, text, t) && harmful.length === 0) console.log(`  ok   ${JSON.stringify(t)}`);
  else console.log(`  FAIL ${JSON.stringify(t)} -> ${JSON.stringify(text)} ${JSON.stringify(harmful)}`);
}

console.log('\n=== 六、回归：幂等性（对抗验证 D5）===');
const IDEMPOTENCE = [
  'cocos creator 是个引擎',
  'cocoscreator 是个引擎',
  'CocosCreator',
  '哈里斯Pro',
  '呃 flcash 帮我稳定一下',
  '反代到deepseek harness',
  '了解一下workbody好几个账号',
];
for (const t of IDEMPOTENCE) {
  const once = corrector.correct(t).text;
  const twice = corrector.correct(once).text;
  const thrice = corrector.correct(twice).text;
  if (check(`idem:${t}`, twice, once) && check(`idem3:${t}`, thrice, once)) {
    console.log(`  ok   ${JSON.stringify(t)} -> ${JSON.stringify(once)}`);
  } else {
    console.log(`  FAIL ${JSON.stringify(t)}\n       once  ${JSON.stringify(once)}\n       twice ${JSON.stringify(twice)}\n       thrice ${JSON.stringify(thrice)}`);
  }
}

console.log('\n=== 七、回归：缺字/生僻字不得让跨度坍缩（对抗验证 D6/D7）===');
const SPAN_CASES = [
  '克㐂劳德', '哈㐂里斯', '哈内㐂斯', '普㐂朗普特',
  '哈㐂里㐂斯', '哈里发', '哈力士', '哈丽',
];
for (const t of SPAN_CASES) {
  const { text } = corrector.correct(t);
  if (check(`span:${t}`, text, t)) console.log(`  ok   ${JSON.stringify(t)}`);
  else console.log(`  FAIL ${JSON.stringify(t)} -> ${JSON.stringify(text)}`);
}

console.log('\n=== 八、回归：缩进与换行必须保留（对抗验证 D8）===');
const INDENT_CASES = [
  'def foo():\n    if x:\n        return 1\n    return 0',
  'server:\n  host: localhost\n  port: 8080\nlist:\n  - a\n  - b',
];
for (const t of INDENT_CASES) {
  const { text } = corrector.correct(t);
  if (check(`indent:${t.slice(0, 20)}`, text, t)) console.log(`  ok   ${JSON.stringify(t.slice(0, 30))}...`);
  else console.log(`  FAIL ${JSON.stringify(t)} -> ${JSON.stringify(text)}`);
}

console.log('\n=== 九、回归：繁体不得被转成简体（对抗验证 D9）===');
const TRADITIONAL = ['工作臺的识别', '編譯通過了', '任務完成了', '靈感管家負責這個'];
for (const t of TRADITIONAL) {
  const { text } = corrector.correct(t);
  if (check(`trad:${t}`, text, t)) console.log(`  ok   ${JSON.stringify(t)}`);
  else console.log(`  FAIL ${JSON.stringify(t)} -> ${JSON.stringify(text)}`);
}

console.log('\n=== 十、边界情况 ===');
const EDGES = [
  ['', ''], ['   ', ''], ['abc', 'abc'], ['。', '。'],
  ['flcash', 'FlClash'], ['哈里斯', 'Harness'],
];
for (const [input, want] of EDGES) {
  const { text } = corrector.correct(input);
  if (check(`edge:${JSON.stringify(input)}`, text, want)) console.log(`  ok   ${JSON.stringify(input)} -> ${JSON.stringify(text)}`);
  else console.log(`  FAIL ${JSON.stringify(input)} -> ${JSON.stringify(text)} (want ${JSON.stringify(want)})`);
}

console.log('\n=== 十一、非字符串输入不崩溃 ===');
for (const bad of [null, undefined, 42, {}, []]) {
  try {
    const r = corrector.correct(bad);
    if (typeof r.text === 'string' && Array.isArray(r.changes)) { pass++; console.log(`  ok   ${JSON.stringify(bad)} -> ${JSON.stringify(r.text)}`); }
    else { fail++; console.log(`  FAIL ${JSON.stringify(bad)} -> bad shape`); }
  } catch (e) { fail++; console.log(`  FAIL ${JSON.stringify(bad)} threw ${e.message}`); }
}

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log('\n失败明细:');
  for (const f of failures) console.log(`  - ${f.label}: got ${JSON.stringify(f.got)} want ${JSON.stringify(f.want)}`);
  process.exit(1);
}
console.log('全部通过');
