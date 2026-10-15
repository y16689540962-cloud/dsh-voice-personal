# `lib/style` — 风格学习模块

从**用户自己的语料**统计出确定性风格画像，并作为听写后处理应用。

> **这不是 AI 重写。** 全程零依赖、不联网、不调用任何 LLM。
> 所有结论都来自可复现的计数统计，`applyStyle` 的每一处改动都记进 `changes` 供审计。

---

## 接口（冻结，`STYLE_VERSION = 1`）

```js
import { STYLE_VERSION, learnStyle, applyStyle } from './lib/style/index.js';

const profile = learnStyle(texts, options);        // -> 纯 JSON
const { text, changes } = applyStyle(text, profile, options);
```

### `learnStyle(texts, options) -> profile`

`texts` 接受：`string` | `string[]` | `{text, weight}[]` | `{texts: [...]}`。

| option | 默认 | 说明 |
| --- | --- | --- |
| `minCount` | `3` | `commonPhrases` / `casing` 的最低出现次数 |
| `maxFillers` | `40` | 画像里最多保留多少个口水词 |
| `maxPhrases` | `60` | 高频短语上限 |
| `maxCasing` | `100` | casing 词条上限 |
| `minPhraseLen` | `2` | n-gram 最短长度 |
| `maxPhraseLen` | `4` | n-gram 最长长度 |
| `minSpacingSamples` | `3` | 中英边界观测数低于此值就不对空格表态 |

返回**纯 JSON**（内部 `JSON.parse(JSON.stringify(...))` 往返一次，保证没有 Map/Set/函数泄漏）。

### `applyStyle(text, profile, options) -> { text, changes }`

| option | 默认 | 说明 |
| --- | --- | --- |
| `fillers` | `true` | 删口水词 |
| `spacing` | `true` | 统一中英文间空格 |
| `casing` | `true` | 统一英文大小写 |
| `cleanup` | `false` | 收尾清理（折叠重复标点、去掉开头孤立逗号） |
| `casingMinCount` | `2` | casing 生效的最低总次数 |
| `fillerList` | — | 覆盖画像里的口水词白名单（测试/调试用） |

**处理顺序**（有意为之）：`casing` → `spacing` → `fillers` → `cleanup`。
先把书写统一，口水词的上下文判定看到的才是「最终形态」的文本。

**空画像保护**：`profile` 为 `null` / `undefined` / `{}` / `[]` / 版本不符 / 结构损坏时，
**原样返回** `text` 且 `changes` 为空。这条有专门的回归测试。

---

## 画像字段

| 字段 | 含义 |
| --- | --- |
| `version` | 恒为 `STYLE_VERSION`（1） |
| `fillerWords` | `[{word, count, tier}]`，按频次降序。**只含语料里真实出现过的词** |
| `sentenceEnders` | `{total, words, punctuation}` — 句末习惯用词 + 句末标点分布 |
| `punctuation` | 逗号/句号风格、全角半角比例、`exclamationHeavy`、`usesEnglishPunctuation` |
| `commonPhrases` | `[{phrase, count, length}]`，2–4 字 n-gram，只取自**连续中文段** |
| `spacing` | 中英空格习惯（见下） |
| `casing` | `[{word, variants, total, preferred, ratio, mixed, ambiguous}]` |
| `stats` | `{texts, chars, cjkChars, sentences, learnedAt}` |
| `options` | 本次学习实际生效的参数（便于复现） |

### `spacing` 子字段

```js
{
  spaced, tight, total, ratio,          // 有空格 / 无空格的边界数
  spacedCjkLatin, tightCjkLatin,        // 中文→英文 方向
  spacedLatinCjk, tightLatinCjk,        // 英文→中文 方向
  latinNeedsSpace, cjkNeedsSpace,       // true / false / null（null = 不表态）
  threshold: 0.6, minSamples: 3,
  sampleSize, confident
}
```

判定规则：某方向「有空格」占比 ≥ `0.6` 即判为 `true`，否则 `false`。
**该方向一次都没观测到**（例如用户从不写 `English 中文`）时沿用另一方向的结论；
**总体观测 < `minSpacingSamples`** 时一律 `null`，`applyStyle` 就不会碰空格。
→ 宁可不动，也不臆测。

### `casing` 子字段

从语料多数投票。`preferred` 在以下情况为 `null`（= 不猜）：

- 平票（`ambiguous: true`）
- 没有过半数（`top.count * 2 <= total`）
- 单词只有 1 个字母（`i` / `a` 的大小写由语法决定，不是习惯）

`preferred` 等于全小写原文时也会写进画像，但 `applyStyle` 不会产生多余 `changes`（幂等）。

---

## 口水词：如何避免误删（核心难点）

问题：「就是」在「**就是**这个问题」里是实词，在「**就是**，我觉得」里是口水词。
一刀切删掉会改语义。本模块的做法是**分层 + 双向词法判定**，不靠猜测。

### 两个层级

| tier | 词例 | 删除条件 |
| --- | --- | --- |
| **1** | 嗯 呃 啊 唉 哎 哦 咦 呀 哟 唔 诶 欸 | 左侧必须是分隔符（或段首）。右侧若粘着词字符则**默认不删** |
| **2** | 就是 那个 这个 然后 其实 对吧 是吧 所以说 … | **左右两侧都必须是分隔符**（完全孤立）才删 |

核心判定函数 `fillerDeletionLength(word, left, right)` 是导出的，可直接单测：

```js
fillerDeletionLength('就是', undefined, '这') // 0  「就是这个问题」→ 不删
fillerDeletionLength('就是', '，',     '，') // 2  「就是，我觉得」→ 删
fillerDeletionLength('嗯',   undefined, '，') // 1  「嗯，」→ 删
fillerDeletionLength('唉',   undefined, '声') // 0  「唉声叹气」→ 不删
fillerDeletionLength('啊',   undefined, '哈') // 2  「啊哈」→ 整个叹词一起删
```

### 三个额外护栏

1. **右侧粘实词 → 不删。** `其实这个方案` / `然后我们去` / `那个插件` 全部保留。
2. **左侧粘词字符 → 不删。** `我觉得这个` / `我就是觉得` 保留。
3. **叹词白名单 `GLUED_FILLERS`。** 层级 1 的词若右侧粘着词字符，
   只有命中 `啊哈 / 哦豁 / 哦哟 / 啊哟 / 哎哟 / 诶呀 / 哎呀` 才删，
   且**连同后面那个字一起删**（否则「啊哈」会剩下半截「哈」）。
   不在白名单的一律不删 —— 保护 `唉声叹气`、`呃逆`、`唔该`（粤语）、`啊姨`。

### 白名单机制（重要）

`applyStyle` **只删画像里学到的词**。语料里没出现过「呃」，就算文本里有「呃，」也不会删。
这保证「学到的才是习惯」，而不是套用一张通用词表。

### 已知的有意漏删

- `嗯那个我觉得` → 「嗯」右侧粘「那」，**不删**。这是刻意保守：宁可漏删，不可错删。
  写成 `嗯，那个，我觉得` 就能正常清理。
- 多轮删除：每次只删一处并重新扫描，所以 `呃，那个，好的。` → `好的。`（级联生效）。

---

## `changes` 结构

```js
{ type: 'filler' | 'spacing' | 'casing' | 'punctuation',
  before, after, index, word?, note? }
```

`spacing` 的 `note` 为 `insert` / `remove` / `normalize`；
`punctuation` 的 `note` 为 `collapse` / `strip-leading`。

---

## 自测

```bash
cd dsh-voice-personal
node --test lib/style/self-test.js     # 推荐
node lib/style/self-test.js            # 直接跑也可以（exit code 一致）
```

47 项测试，覆盖 4 条验收标准 + 「就是」歧义的正例/反例 + 空画像回归保护。
当前状态：**47 pass / 0 fail**。

---

## 遗留限制（诚实清单）

1. **口水词发现是有界词表，不是无词典自动发现。**
   `FILLER_TIERS` 是人工维护的表；语料里出现表外的口语词不会被学到。
   扩充方式：往 `lib/style/lexicon.js` 的 `FILLER_TIERS` 加词并标注层级。
2. **`commonPhrases` 只统计、不参与改写。** 它是给上层做术语/搭配提示用的，
   `applyStyle` 不会用短语去替换文本（那样风险太高）。
3. **`sentenceEnders.words` 只统计、不改写。** 句末语气词（吧/呢/啊）语义敏感，不自动增删。
4. **`punctuation` 画像默认不生效。** 只有显式传 `cleanup: true` 才会做标点收尾清理；
   全角/半角「统一」没有实现（`punctuation` 字段只做统计供上层决策）。
5. **`casing` 用简单词边界。** 路径/文件名/邮箱做了护栏（`lib/style/index.js`、`a@DSH.com`
   不会被改），但更复杂的代码片段（如带命名空间的标识符）可能仍被误改。
6. **不处理简繁转换、不处理数字/单位格式、不做同音纠错**（同音纠错属于 `lib/correct/`）。
7. **`stats.learnedAt` 是唯一的非确定字段**（`new Date().toISOString()`）。
   除它之外同输入必然同输出，测试里显式剥离该字段后做全量比对。
8. **只面向中文为主的语料。** 纯英文语料下 `commonPhrases` 恒为空，
   `fillerWords` 也不会命中（词表是中文的）。

---

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | `STYLE_VERSION` / `learnStyle` / `applyStyle` + 判定函数 |
| `lexicon.js` | 词表、字符范围、判定谓词（纯数据 + 纯函数） |
| `self-test.js` | 47 项自测 |
| `README.md` | 本文件 |
