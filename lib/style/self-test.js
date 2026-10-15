/**
 * dsh-voice-personal / lib/style / self-test.js
 *
 * 自测脚本（零依赖，node:assert + node:test）。
 * 运行：
 *   node --test dsh-voice-personal/lib/style/self-test.js
 *   node dsh-voice-personal/lib/style/self-test.js        # 直接跑也能出结果
 *
 * 覆盖 task-2 的 4 条验收标准 + 「就是」歧义的反例测试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  STYLE_VERSION,
  learnStyle,
  applyStyle,
  isFillerDeletable,
  fillerDeletionLength,
} from './index.js';

/* ------------------------------------------------------------------ *
 * 0. 冻结接口 & 纯 ESM / 零依赖
 * ------------------------------------------------------------------ */

test('冻结接口存在且 STYLE_VERSION === 1', () => {
  assert.equal(STYLE_VERSION, 1);
  assert.equal(typeof learnStyle, 'function');
  assert.equal(typeof applyStyle, 'function');
});

test('零外部依赖：源码里没有 import 裸模块 / require / 网络调用', () => {
  const files = ['index.js', 'lexicon.js'];
  for (const f of files) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    const specifiers = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const s of specifiers) {
      assert.ok(s.startsWith('./'), `${f} 引入了非相对路径模块：${s}`);
    }
    assert.ok(!/\brequire\s*\(/.test(src), `${f} 使用了 require`);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|node:https?|node:net/.test(src), `${f} 疑似联网`);
    // 只检查**可执行的调用形态**，且先剥掉注释 —— 否则文档注释里的
    // 「不调用任何 LLM」会把测试自己绊倒（假阳性）。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/\b(openai|anthropic|chatgpt|createChatCompletion)\b|\bllm\s*[.(]/i.test(code),
      `${f} 疑似调用 LLM`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * 1. 验收标准 1：构造语料 -> learnStyle -> 断言画像字段合理
 * ------------------------------------------------------------------ */

const CORPUS = [
  '嗯，那个，我觉得 dsh 这个插件挺好用的。',
  '呃，就是这个问题，我们要先修好它。',
  '然后我把 dsh 的语音模块写完了！',
  '其实这个方案 dsh 用起来更顺手，你试试。',
  '嗯，我觉得 DSH 的接口设计得不错。',
  '那个，呃，我先去测一下 dsh。',
  '就是这个问题，我们已经讨论过了。',
  '就是，我觉得可以再想想。',
];

test('learnStyle 返回纯 JSON（可 stringify/parse 往返）', () => {
  const p = learnStyle(CORPUS);
  const round = JSON.parse(JSON.stringify(p));
  assert.deepEqual(round, p);
});

test('stats：语料条数 / 字数 / 学习时间', () => {
  const p = learnStyle(CORPUS);
  assert.equal(p.stats.texts, CORPUS.length);
  const expectedChars = CORPUS.reduce((n, s) => n + s.length, 0);
  assert.equal(p.stats.chars, expectedChars);
  assert.ok(p.stats.cjkChars > 0 && p.stats.cjkChars < expectedChars);
  assert.match(p.stats.learnedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.ok(!Number.isNaN(Date.parse(p.stats.learnedAt)));
});

test('fillerWords：频次与人工核对一致（含「就是」的两种语境）', () => {
  const p = learnStyle(CORPUS);
  const byWord = Object.fromEntries(p.fillerWords.map((f) => [f.word, f.count]));

  // 「嗯」出现 2 次，都在句首 -> 都是可删的口水词
  assert.equal(byWord['嗯'], 2);
  // 「呃」出现 2 次（一次句中孤立、一次句首）-> 2
  assert.equal(byWord['呃'], 2);
  // 「那个」出现 2 次，都是孤立（逗号/句首夹着）-> 2
  assert.equal(byWord['那个'], 2);
  // 「就是」共出现 4 次：2 次「就是这个问题」(不删) + 1 次「就是这个问题，我们」+ 1 次「就是，我觉得」(可删)
  // 可删的只有 1 次 -> 证明歧义规则真的生效了
  assert.equal(byWord['就是'], 1);
  // 「其实这个方案」-> 左侧是句首、右侧是「这」-> tier2 要求右侧非词字符 -> 不计
  assert.equal(byWord['其实'], undefined);
  // 「这个插件」「这个方案」同理不计
  assert.equal(byWord['这个'], undefined);

  // 排序：按 count 降序
  const counts = p.fillerWords.map((f) => f.count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  // 每个条目都有 tier
  for (const f of p.fillerWords) assert.ok(f.tier === 1 || f.tier === 2);
});

test('fillerWords：minCount 与 maxFillers 生效', () => {
  const p1 = learnStyle(CORPUS, { maxFillers: 1 });
  assert.equal(p1.fillerWords.length, 1);
  // minCount 只作用于 commonPhrases / casing（口水词表是有界词表，不设阈值）
  const p2 = learnStyle(CORPUS, { minCount: 2 });
  assert.equal(p2.options.minCount, 2);
  assert.ok(p2.commonPhrases.every((g) => g.count >= 2));
});

test('sentenceEnders：句末标点倾向统计正确', () => {
  const p = learnStyle(CORPUS);
  const marks = Object.fromEntries(p.sentenceEnders.punctuation.map((m) => [m.mark, m.count]));
  assert.equal(marks['。'], 7);
  assert.equal(marks['！'], 1);
  assert.equal(p.sentenceEnders.total, 8);
});

test('punctuation：逗号/句号风格与感叹号偏好', () => {
  const p = learnStyle(CORPUS);
  assert.equal(p.punctuation.commaStyle, '，');
  assert.equal(p.punctuation.periodStyle, '。');
  assert.equal(p.punctuation.usesEnglishPunctuation, false);
  assert.equal(p.punctuation.fullWidthRatio, 1);
  assert.ok(p.punctuation.counts['，'] > 0);
  assert.equal(p.punctuation.exclamationHeavy, false);

  const shouty = learnStyle(['太好了！', '真的！', '牛！']);
  assert.equal(shouty.punctuation.exclamationHeavy, true);
  assert.equal(shouty.punctuation.exclamationRatio, 1);
});

test('punctuation：英文标点语料能识别出来', () => {
  const p = learnStyle(['hello, world. yes!', 'ok, fine.']);
  assert.equal(p.punctuation.usesEnglishPunctuation, true);
  assert.equal(p.punctuation.commaStyle, ',');
  assert.equal(p.punctuation.periodStyle, '.');
  assert.equal(p.punctuation.fullWidthRatio, 0);
});

test('commonPhrases：2-4 字 n-gram 只取自连续中文段', () => {
  const p = learnStyle(['语音模块很好用，语音模块很稳定。', '语音模块我测过了。']);
  const top = p.commonPhrases[0];
  assert.equal(top.phrase, '语音模块');
  assert.equal(top.count, 3);
  assert.equal(top.length, 4);
  assert.ok(p.commonPhrases.every((g) => g.phrase.length >= 2 && g.phrase.length <= 4));
  // 不含标点/英文
  assert.ok(p.commonPhrases.every((g) => !/[,，。.A-Za-z0-9]/.test(g.phrase)));
  // 未达 minCount 的短语被过滤
  assert.ok(!p.commonPhrases.some((g) => g.phrase === '很好'));
});

test('spacing：爱加空格 -> latinNeedsSpace/cjkNeedsSpace 为 true 且比例正确', () => {
  const p = learnStyle(CORPUS);
  assert.equal(p.spacing.tight, 0);
  assert.ok(p.spacing.spaced > 0);
  assert.equal(p.spacing.ratio, 1);
  assert.equal(p.spacing.latinNeedsSpace, true);
  assert.equal(p.spacing.cjkNeedsSpace, true);
  assert.equal(p.spacing.confident, true);
});

test('spacing：不加空格 -> 判定为 false（而非 null）', () => {
  const p = learnStyle(['我用dsh写代码。', '这个dsh插件很好用。', 'dsh的语音模块我测过了。']);
  assert.equal(p.spacing.spaced, 0);
  assert.ok(p.spacing.tight > 0);
  assert.equal(p.spacing.ratio, 0);
  assert.equal(p.spacing.latinNeedsSpace, false);
  assert.equal(p.spacing.cjkNeedsSpace, false);
});

test('spacing：样本不足 -> null，绝不臆测', () => {
  const p = learnStyle(['我用 dsh。']);
  assert.ok(p.spacing.total < 3);
  assert.equal(p.spacing.confident, false);
  assert.equal(p.spacing.latinNeedsSpace, null);
  assert.equal(p.spacing.cjkNeedsSpace, null);
});

test('casing：多数投票得出英文书写偏好', () => {
  const p = learnStyle([
    'dsh 很好用。',
    'dsh 的插件我写完了。',
    'DSH 也不错。',
  ]);
  const dsh = p.casing.find((c) => c.word === 'dsh');
  assert.ok(dsh, '应学到 dsh 这个词');
  assert.equal(dsh.preferred, 'dsh');
  assert.equal(dsh.total, 3);
  assert.equal(dsh.ratio, 0.6667);
  assert.equal(dsh.mixed, true);
  assert.deepEqual(dsh.variants.map((v) => v.form), ['dsh', 'DSH']);
});

test('casing：平票 -> preferred 为 null（不瞎猜）', () => {
  // 语料只有 2 条，必须显式放宽 minCount（默认 3）才能让 casing 出结果
  const p = learnStyle(['dsh 好。', 'DSH 好。'], { minCount: 2 });
  const dsh = p.casing.find((c) => c.word === 'dsh');
  assert.ok(dsh, 'minCount=2 时 dsh 应进入 casing');
  assert.equal(dsh.preferred, null);
  assert.equal(dsh.ambiguous, true);
  assert.equal(dsh.total, 2);
});

test('casing：全小写词 preferred 等于自身（幂等，不产生多余 changes）', () => {
  const p = learnStyle(['dsh 好。', 'dsh 的插件好。'], { minCount: 2 });
  const dsh = p.casing.find((c) => c.word === 'dsh');
  assert.ok(dsh);
  assert.equal(dsh.preferred, 'dsh'); // 全小写就是偏好形式
  assert.equal(dsh.mixed, false);
  // 关键性质：preferred === word 时 applyStyle 不产生任何改动
  assert.deepEqual(applyStyle('dsh 好。', p).changes, []);
});

test('casing：默认 minCount=3 时，2 条语料不产生 casing 条目', () => {
  const p = learnStyle(['dsh 好。', 'DSH 好。']);
  assert.deepEqual(p.casing, []);
});

test('learnStyle：确定性（同输入同输出，除时间戳）', () => {
  const strip = (p) => JSON.stringify({ ...p, stats: { ...p.stats, learnedAt: null } });
  assert.equal(strip(learnStyle(CORPUS)), strip(learnStyle(CORPUS)));
  assert.equal(strip(learnStyle([])), strip(learnStyle([])));
});

test('learnStyle：空输入不崩，返回结构完整的空画像', () => {
  const p = learnStyle([]);
  assert.equal(p.stats.texts, 0);
  assert.deepEqual(p.fillerWords, []);
  assert.deepEqual(p.commonPhrases, []);
  assert.deepEqual(p.casing, []);
  assert.equal(p.spacing.ratio, null);
  assert.equal(p.punctuation.fullWidthRatio, null);
});

test('learnStyle：接受 string / string[] / {text,weight}[] / {texts:[]}', () => {
  assert.equal(learnStyle('嗯，好的。').stats.texts, 1);
  assert.equal(learnStyle(['嗯。', '呃。']).stats.texts, 2);
  assert.equal(learnStyle({ texts: ['嗯。'] }).stats.texts, 1);
  const weighted = learnStyle([{ text: '嗯。', weight: 3 }]);
  assert.equal(weighted.fillerWords[0].count, 3);
  assert.equal(weighted.stats.texts, 1);
  assert.throws(() => learnStyle(42), TypeError);
});

/* ------------------------------------------------------------------ *
 * 2. 验收标准 2：「就是」歧义 —— 正例 + 反例
 * ------------------------------------------------------------------ */

const STYLE_CORPUS = [
  '嗯，那个，我觉得这个方案可以。',
  '呃，其实我想说的是这个。',
  '嗯，我先想想。',
  '呃，好的。',
  '那个，我们明天再聊。',
];

test('【反例】「就是这个问题」中的「就是」绝不能被删', () => {
  const p = learnStyle(STYLE_CORPUS);
  const out = applyStyle('就是这个问题，我们要先修好它。', p);
  assert.equal(out.text, '就是这个问题，我们要先修好它。');
  assert.deepEqual(out.changes, []);
});

test('【反例】「我就是觉得」「他就是不来」等实义/连接用法不删', () => {
  const p = learnStyle(STYLE_CORPUS);
  for (const s of ['我就是觉得不行。', '他就是不来。', '这就是问题所在。', '这个方案就是好。']) {
    const out = applyStyle(s, p);
    assert.equal(out.text, s, `不应改动：${s}`);
    assert.deepEqual(out.changes, []);
  }
});

test('【反例】「其实这个方案」「然后我们」中右侧粘实词，不删', () => {
  const p = learnStyle(STYLE_CORPUS);
  for (const s of ['其实这个方案更好。', '然后我们去测一下。', '那个插件有问题。', '这个功能还没写完。']) {
    assert.equal(applyStyle(s, p).text, s, `不应改动：${s}`);
  }
});

test('【反例】语气词粘实词：唉声叹气 / 呃逆 / 唔该 不删', () => {
  const p = learnStyle(['嗯，好的。', '呃，知道了。', '啊，这样。', '唉，算了。']);
  for (const s of ['唉声叹气没有用。', '他一直在呃逆。', '唔该晒。', '啊姨来了。']) {
    const out = applyStyle(s, p);
    assert.equal(out.text, s, `不应改动：${s}`);
  }
});

test('【正例】「嗯，那个，我觉得」能清理口水词', () => {
  const p = learnStyle(STYLE_CORPUS);
  const out = applyStyle('嗯，那个，我觉得这个方案可以。', p);
  assert.equal(out.text, '我觉得这个方案可以。');
  const words = out.changes.filter((c) => c.type === 'filler').map((c) => c.word);
  assert.deepEqual(words, ['嗯', '那个']);
});

test('【正例】孤立成词的「就是，」可以删（与「就是这个问题」形成对照）', () => {
  // 关键：必须先让语料里出现「就是，」这种孤立用法，「就是」才会进画像白名单。
  // STYLE_CORPUS 里没有「就是」，所以画像不含它 -> 不能拿它做正例。
  const p = learnStyle(['就是，我觉得可以再想想。', '就是，这个方案不错。', '嗯，好的。']);
  assert.ok(p.fillerWords.some((f) => f.word === '就是'), '「就是」应被学进画像');

  // 正例：孤立 -> 删
  const pos = applyStyle('就是，我觉得可以再想想。', p);
  assert.equal(pos.text, '我觉得可以再想想。');
  assert.deepEqual(pos.changes.map((c) => c.word), ['就是']);

  // 反例（同一 profile、同一个词）：粘着实词 -> 不删
  const neg = applyStyle('就是这个问题，我们要修。', p);
  assert.equal(neg.text, '就是这个问题，我们要修。');
  assert.deepEqual(neg.changes, []);
});

test('【正例】句首「呃，」「其实，」可删；多轮删除后新暴露的上下文会被重新判定', () => {
  const p = learnStyle(['呃，好的。', '其实，我觉得可以。', '其实，这个方案不错。', '那个，我们明天再聊。']);
  assert.ok(p.fillerWords.some((f) => f.word === '其实'), '「其实」应被学进画像');
  assert.equal(applyStyle('呃，好的。', p).text, '好的。');
  assert.equal(applyStyle('其实，这个不行。', p).text, '这个不行。');

  // 连锁：删掉句首「呃，」后，「那个，」暴露成新的段首，应被继续删掉
  const chain = applyStyle('呃，那个，好的。', p);
  assert.equal(chain.text, '好的。');
  assert.deepEqual(chain.changes.map((c) => c.word), ['呃', '那个']);
});

test('【反例】右侧粘实词时保守不删：嗯那个 / 呃其实', () => {
  // 「嗯」右侧是「那」（词字符）-> 不是孤立口水词，保守起见不删。
  // 这是**有意的漏删**（宁可漏，不可错），记录在此以免被当成 bug。
  const p = learnStyle(['嗯，那个，我觉得可以。', '呃，好的。', '那个，我们明天再聊。']);
  assert.equal(applyStyle('嗯那个我觉得可以。', p).text, '嗯那个我觉得可以。');
  assert.deepEqual(applyStyle('嗯那个我觉得可以。', p).changes, []);
  // 对照：加上逗号变成孤立 -> 就能删
  assert.equal(applyStyle('嗯，那个，我觉得可以。', p).text, '我觉得可以。');
});

test('【正例】句末/句中孤立的语气词（啊/呀/吧）不误伤正常句末语气', () => {
  const p = learnStyle(['啊，这样啊。', '呀，是你呀。']);
  // 「啊，」在句首可删；句末「啊」右侧是「。」但左侧是词字符 -> 不删
  const out = applyStyle('啊，这样啊。', p);
  assert.equal(out.text, '这样啊。');
});

test('fillerDeletionLength 直接单测：歧义判定表', () => {
  const cases = [
    // [word, left, right, expected, 说明]
    ['就是', undefined, '这', 0, '就是这个问题 —— 右侧粘实词'],
    ['就是', '，', '这', 0, '，就是这个问题'],
    ['就是', '，', '，', 2, '就是，我觉得 —— 完全孤立'],
    ['就是', undefined, '，', 2, '句首孤立'],
    ['嗯', undefined, '，', 1, '嗯，'],
    ['嗯', undefined, '我', 0, '嗯我…（粘连，保守不删）'],
    ['嗯', '。', '我', 0, '。嗯我'],
    ['唉', undefined, '声', 0, '唉声叹气'],
    ['啊', undefined, '哈', 2, '啊哈（整个叹词一起删）'],
    ['啊', undefined, '姨', 0, '啊姨'],
    ['哦', undefined, '豁', 2, '哦豁'],
    ['那个', undefined, '插', 0, '那个插件'],
    ['那个', '，', '，', 2, '那个，我们'],
    ['不存在的词', undefined, undefined, 0, '不在词表'],
  ];
  for (const [word, left, right, expected, note] of cases) {
    assert.equal(fillerDeletionLength(word, left, right), expected, note);
    assert.equal(isFillerDeletable(word, left, right), expected > 0, note);
  }
});

test('applyFillers：只删画像里学到的词（白名单机制）', () => {
  const p = learnStyle(['那个，好吧。', '那个，行。']);
  assert.ok(p.fillerWords.some((f) => f.word === '那个'));
  assert.ok(!p.fillerWords.some((f) => f.word === '呃'), '语料里没有「呃」，画像里就不该有');
  // 文本里有「呃，」但画像没学到 -> 不删
  const out = applyStyle('呃，那个，好吧。', p);
  assert.equal(out.text, '呃，好吧。');
});

test('applyStyle：可选关闭单项处理（每个开关都要真的生效）', () => {
  // 语料同时含口水词、大小写变体、空格习惯，才能一次验证三个开关
  const corpus = [
    '嗯，那个，我觉得 dsh 这个插件挺好用的。',
    '呃，就是这个问题，我们要先修好它。',
    '嗯，那个，DSH 的接口设计得不错。',
    '其实，dsh 用起来更顺手。',
    '嗯，那个，dsh 我先去测一下。',
  ];
  const p = learnStyle(corpus);
  assert.ok(p.fillerWords.length > 0, '画像应有口水词');
  assert.equal(p.spacing.latinNeedsSpace, true, '画像应判定为爱加空格');
  const dsh = p.casing.find((c) => c.word === 'dsh');
  assert.ok(dsh && dsh.preferred === 'dsh', '画像应偏好小写 dsh');

  const src = '嗯，那个，我觉得 DSH 好。';
  const full = applyStyle(src, p);
  assert.equal(full.text, '我觉得 dsh 好。'); // 全开：删口水词 + 改大小写
  assert.ok(full.changes.some((c) => c.type === 'filler'));
  assert.ok(full.changes.some((c) => c.type === 'casing'));

  // fillers:false -> 口水词必须**保留**（这正是之前写反的那条）
  const noFillers = applyStyle(src, p, { fillers: false });
  assert.equal(noFillers.text, '嗯，那个，我觉得 dsh 好。');
  assert.ok(!noFillers.changes.some((c) => c.type === 'filler'), '关掉后不应有 filler 改动');
  assert.ok(noFillers.changes.some((c) => c.type === 'casing'), 'casing 应仍然生效');

  // casing:false -> 大小写必须**保留**
  const noCasing = applyStyle(src, p, { casing: false });
  assert.equal(noCasing.text, '我觉得 DSH 好。');
  assert.ok(!noCasing.changes.some((c) => c.type === 'casing'), '关掉后不应有 casing 改动');
  assert.ok(noCasing.changes.some((c) => c.type === 'filler'), 'fillers 应仍然生效');

  // spacing:false -> 空格必须**不动**
  const tight = learnStyle(['我用dsh写代码。', '这个dsh插件很好用。', 'dsh的语音模块我测过了。', '我又用了dsh一次。']);
  assert.equal(tight.spacing.latinNeedsSpace, false);
  assert.equal(applyStyle('我用 dsh 写代码。', tight).text, '我用dsh写代码。');
  assert.equal(applyStyle('我用 dsh 写代码。', tight, { spacing: false }).text, '我用 dsh 写代码。');

  // 全部关掉 -> 原样返回
  const none = applyStyle(src, p, { fillers: false, casing: false, spacing: false });
  assert.equal(none.text, src);
  assert.deepEqual(none.changes, []);
});

/* ------------------------------------------------------------------ *
 * 3. 验收标准 3：profile 为空 -> 原样返回（回归保护）
 * ------------------------------------------------------------------ */

test('applyStyle：profile 为 null/undefined/{} 时原样返回', () => {
  const samples = [
    '嗯，就是这个问题，我觉得 dsh 可以。',
    '唉声叹气，呃逆不止。',
    '',
    '   ',
    '没有中文 only english 123',
    '多行\n文本\nwith mixed 中英',
  ];
  for (const s of samples) {
    for (const empty of [null, undefined, {}, [], 0, '', 'profile']) {
      const out = applyStyle(s, empty);
      assert.equal(out.text, s, `profile=${JSON.stringify(empty)} 时不应改动文本`);
      assert.deepEqual(out.changes, []);
    }
  }
});

test('applyStyle：版本不符 / 结构损坏的 profile 一律拒绝', () => {
  const broken = [
    { version: 99, fillerWords: [{ word: '嗯', count: 9 }] },
    { version: STYLE_VERSION, fillerWords: 'nope', casing: null, spacing: {} },
    { version: STYLE_VERSION },
  ];
  for (const b of broken) {
    const out = applyStyle('嗯，就是这个问题 dsh。', b);
    assert.equal(out.text, '嗯，就是这个问题 dsh。');
    assert.deepEqual(out.changes, []);
  }
});

test('applyStyle：空字符串 / 非字符串入参', () => {
  const p = learnStyle(STYLE_CORPUS);
  assert.deepEqual(applyStyle('', p), { text: '', changes: [] });
  assert.throws(() => applyStyle(null, p), TypeError);
  assert.throws(() => applyStyle(123, p), TypeError);
});

test('applyStyle：幂等（同一 profile 重复应用不再产生改动）', () => {
  const p = learnStyle(STYLE_CORPUS);
  const once = applyStyle('嗯，那个，我觉得 dsh 可以。', p);
  const twice = applyStyle(once.text, p);
  assert.equal(twice.text, once.text);
  assert.deepEqual(twice.changes, []);
});

/* ------------------------------------------------------------------ *
 * 4. applyStyle 行为 2/3：空格统一 + 大小写统一
 * ------------------------------------------------------------------ */

test('applyStyle：按 spacing 画像加空格（并记录 changes）', () => {
  const p = learnStyle(['我用 dsh 写代码。', 'dsh 的插件很好用。', '我测了 dsh 一下。']);
  const out = applyStyle('我用dsh写代码，dsh很好用。', p);
  assert.equal(out.text, '我用 dsh 写代码，dsh 很好用。');
  const sp = out.changes.filter((c) => c.type === 'spacing');
  assert.equal(sp.length, 3);
  assert.ok(sp.every((c) => c.after.includes(' ') && c.note === 'insert'));
});

test('applyStyle：按 spacing 画像去空格', () => {
  const p = learnStyle(['我用dsh写代码。', '这个dsh插件很好用。', 'dsh的语音模块我测过了。']);
  const out = applyStyle('我用 dsh 写代码，dsh 很好用。', p);
  assert.equal(out.text, '我用dsh写代码，dsh很好用。');
  assert.equal(out.changes.filter((c) => c.type === 'spacing').length, 3);
});

test('applyStyle：多余空格归一为单个空格', () => {
  const p = learnStyle(['我用 dsh 写代码。', 'dsh 的插件很好用。', '我测了 dsh 一下。']);
  const out = applyStyle('我用   dsh 写代码。', p);
  assert.equal(out.text, '我用 dsh 写代码。');
  const norm = out.changes.find((c) => c.note === 'normalize');
  assert.ok(norm, '应记录一次 normalize');
  assert.equal(norm.before, '   ');
  assert.equal(norm.after, ' ');
});

test('applyStyle：spacing 证据不足（null）时不动空格', () => {
  const p = learnStyle(['我用 dsh。']); // total = 1 < 3
  const s = '我用dsh写代码，dsh很好用。';
  const out = applyStyle(s, p);
  assert.equal(out.text, s);
  assert.deepEqual(out.changes, []);
});

test('applyStyle：按 casing 画像统一英文大小写', () => {
  const p = learnStyle(['dsh 很好用。', 'dsh 的插件我写完了。', 'DSH 也不错。']);
  const out = applyStyle('DSH 很好用，Dsh 也可以。', p);
  assert.equal(out.text, 'dsh 很好用，dsh 也可以。');
  const cs = out.changes.filter((c) => c.type === 'casing');
  assert.equal(cs.length, 2);
  assert.deepEqual(cs.map((c) => [c.before, c.after]), [['DSH', 'dsh'], ['Dsh', 'dsh']]);
});

test('applyStyle：casing 平票 / 证据不足时不改', () => {
  const tie = learnStyle(['dsh 好。', 'DSH 好。']);
  assert.equal(applyStyle('DSH 好。', tie).text, 'DSH 好。');
  const few = learnStyle(['dsh 好。']); // total=1 < minCount=3
  assert.equal(applyStyle('DSH 好。', few).text, 'DSH 好。');
});

test('applyStyle：不碰路径/文件名/邮箱里的英文', () => {
  const p = learnStyle(['dsh 很好用。', 'dsh 的插件我写完了。', 'DSH 也不错。']);
  const s = '打开 lib/style/index.js，发给 a@DSH.com 看看。';
  const out = applyStyle(s, p);
  assert.ok(out.text.includes('lib/style/index.js'), `路径被改坏了：${out.text}`);
  assert.ok(out.text.includes('a@DSH.com'), `邮箱被改坏了：${out.text}`);
});

test('changes 结构：每条都有 type/before/after，且 before !== after', () => {
  const p = learnStyle(STYLE_CORPUS);
  const out = applyStyle('嗯，那个，我觉得 DSH 可以。', p);
  assert.ok(out.changes.length > 0);
  for (const c of out.changes) {
    assert.equal(typeof c.type, 'string');
    assert.equal(typeof c.before, 'string');
    assert.equal(typeof c.after, 'string');
    assert.notEqual(c.before, c.after);
  }
});

/* ------------------------------------------------------------------ *
 * 5. 端到端：真实口语听写稿
 * ------------------------------------------------------------------ */

test('端到端：一段典型听写稿的清理结果', () => {
  const corpus = [
    '嗯，我今天主要是想把这个 dsh 的语音模块做完。',
    '那个，其实我觉得现在这个方案已经可以了。',
    '呃，就是这个问题，我们得先确认一下接口。',
    '然后我下午会把 dsh 的测试补上。',
    '嗯，好，那就这样。',
  ];
  const profile = learnStyle(corpus);
  const dictation = '嗯，那个，就是这个问题，我觉得 dsh 的方案可以先这样，然后我们明天再调。';
  const { text, changes } = applyStyle(dictation, profile);

  assert.equal(text, '就是这个问题，我觉得 dsh 的方案可以先这样，然后我们明天再调。');
  // 「就是这个问题」保留了（反例），只删了句首的「嗯，」「那个，」
  assert.ok(text.includes('就是这个问题'));
  assert.deepEqual(changes.filter((c) => c.type === 'filler').map((c) => c.word), ['嗯', '那个']);
  // 没有把「然后我们」误删
  assert.ok(text.includes('然后我们明天再调'));
});

test('端到端：口语稿里「然后」孤立时才会被删', () => {
  const profile = learnStyle(['然后，我们就开始吧。', '然后，他说不行。', '然后，就结束了。']);
  assert.equal(applyStyle('然后，我们就开始吧。', profile).text, '我们就开始吧。');
  assert.equal(applyStyle('然后我们就开始吧。', profile).text, '然后我们就开始吧。');
});

test('applyStyle：性能（1000 条语料学习 + 100 次应用 < 3s）', () => {
  const big = [];
  for (let i = 0; i < 1000; i += 1) big.push(`嗯，那个，我今天用 dsh 写了第 ${i} 段代码，挺好的。`);
  const t0 = Date.now();
  const p = learnStyle(big);
  for (let i = 0; i < 100; i += 1) applyStyle('嗯，那个，我觉得 dsh 不错。', p);
  const cost = Date.now() - t0;
  assert.ok(cost < 3000, `太慢：${cost}ms`);
});
