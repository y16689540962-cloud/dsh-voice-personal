# asr-personal-dictionary

把**你自己的词汇**应用到语音识别结果上：产品名、项目名、大小写、以及「中文误听成拉丁术语」。

零依赖、离线、纯文本进出。装上就能用，不需要模型、不需要联网、不需要 API key。

```js
import { createDictionary } from 'asr-personal-dictionary';

const dict = createDictionary({
  terms: [
    'DSH',                                          // 只归一大小写
    { say: 'FlClash', heard: ['flcash'] },           // 观察到过的误听
    { say: 'Harness', heard: ['哈里斯', '哈内斯'] },   // 中文误听英文词
  ],
});

dict.correct('帮我稳定我现在的flcash');
// '帮我稳定我现在的 FlClash'
```

---

## 它解决什么

语音识别模型很擅长「语言」，很不擅长**你的语言**。它没有任何办法知道：这个说话人说 `flcash` 指的是 `FlClash`，`哈里斯` 其实是个英文词，`DeepSeek` 中间没有空格。

结果就是：常用词全对，专有名词全错。而专有名词恰恰是你最需要打对的那部分——你要把它发到群里、写进 commit、粘进搜索框。

这个包就是补这一层的最小实现。

**它接在识别之后。** 如果你的应用还会调 LLM 润色，请在**调模型之前**先跑一遍，否则模型会很忠实地把一个错词润色成一个格式漂亮的错词；调完之后再跑一遍也无妨——这个操作是幂等的。

---

## 安装

```bash
npm install asr-personal-dictionary
```

要求 Node 18+，ESM。没有运行时依赖，拼音表已经打包在内（159 KiB）。

---

## 术语表怎么写

`terms` 接受字符串或对象，可以混用：

| 写法 | 作用 | 例子 |
|---|---|---|
| `'DSH'` | 只归一大小写。`dsh` → `DSH` | 你知道拼写对，只是识别器大小写不听话 |
| `{ say, heard: [...] }` | 精确匹配 `heard` 里的形态，替换成 `say` | `flcash` → `FlClash`，`workbody` → `WorkBuddy` |
| `{ say, heard: ['哈里斯'] }` | 中文误听映射到拉丁术语 | 3 字以上、每个字都有拼音、整段精确匹配才生效 |

`heard` 的匹配是**大小写折叠后的精确匹配**。这个包**没有模糊匹配通道**，见下面「选项」里为什么不提供。

---

## 安全性质

这个包的判据只有一条：**绝不破坏已经正确的文本**。一个偶尔改写正常句子的个人词典，比没有词典更糟——用户根本无从发现自己的哪句话被改过。

每条性质都有测试，不是声明：

| 性质 | 说明 |
|---|---|
| **不做中文到中文的重写** | 见下节。这是整个设计里最重要的一条约束 |
| **精确匹配** | `heard` 折叠大小写后精确比较；不做编辑距离、不做同音 |
| **保护跨度** | URL、文件路径、邮箱、版本号、命令行参数、行内代码、常见扩展名，在**所有**处理之前先遮罩，任何 pass 都碰不到 |
| **幂等** | `correct(correct(x)) === correct(x)`。规范形式绝不会被二次展开 |
| **保留空白** | 行首缩进逐字节保留——口述的 Python 或 YAML 不能被重排 |
| **保留繁体** | 不做简繁转换。静默改变文字体系是用户没要求的语义变更 |
| **宽松地失败** | 非字符串输入（`null`、数字）被强制转换，绝不抛错。这里抛错等于丢一次听写 |

### 为什么不做中文同音纠错

这是本项目最重要的一条经验，也是这个包存在的理由之一。

早期版本用**无调拼音**匹配中文，于是 `差件` → `插件`、`工作太` → `工作台`。它被整体删除，不是因为调得不好，而是因为**在原理上就不成立**：

```
人物 / 任务  (rènwù)      一部 / 异步  (yībù)
信条 / 心跳  (xìntiáo)    便衣 / 编译  (biànyī)
接点 / 接口  (jiēdiǎn)    配制 / 配置  (pèizhì)
```

一个两音节拼音键等于**所有**读这个音的词。实测：当时上线的 12 组两音节词条，共改写了 **160,454 个不同的两字中文串**——也就是整个语言。`人物关系很复杂` 变成了 `任务关系很复杂`，`这是一部好电影` 变成了 `这是异步好电影`。

任何阈值都救不了：选 `人物` 还是 `任务` 需要上下文，而拼音不携带上下文。

所以现在：中文只有在**整段映射到一个你列出的拉丁术语**时才允许改写。这是一个窄得多、也可检验得多的主张。

---

## 它不做什么

- **不偏置声学模型。** 这是文本进、文本出。它纠正已经识别出来的东西，不会让识别器更容易听出你的词。要那种能力需要引擎支持热词（hotword biasing）——本地 SenseVoice 这类非自回归固定词表模型不支持。如果你的识别器支持热词，两者应该一起用。
- **不做语音识别、不做标点、不做口语清理。** 删口水话、分段、把「第一…第二…」排成编号列表，都是另一层的事。
- **不判断英文词是不是正常词。** 把 `grade` 列为 `Gradle` 的误听会把 `my grade is A` 改成 `my Gradle is A`，这个包检测不到——它没有词典。构造时会拦下可判定的那一类，见下节。

---

## 冲突校验

构造词典时会检查两类**已经真实造成过损坏**的配置，并在默认情况下**拒绝构造**：

```js
// 1) 误听形态撞上了另一个术语的规范拼写 —— 会把那个术语全改掉
createDictionary({ terms: [{ say: 'Claude', heard: ['cloud'] }, { say: 'Cloud' }] });
// Error: "cloud" is listed as a mis-hearing of "Claude" but is the canonical spelling
//        of "Cloud" — that would rewrite every real occurrence of "Cloud".

// 2) 误听形态是自己多词规范形的子串 —— 输出会逐轮增长
createDictionary({ terms: [{ say: 'Cocos Creator', heard: ['cocos'] }] });
// Error: "cocos" is a substring of its own canonical form "Cocos Creator", which made
//        the output grow on every pass. List the full phrase instead.
```

第二条是实测出来的：`Cocos Creator` → `Cocos Creator Creator` → `Cocos Creator Creator Creator` → …，4000 条混合 fuzz 里命中 705 次。引擎已经挡住了增长，但**这个配置本身就是错的**，所以拦在构造期。

同一个 `heard` 被两个术语同时声明、以及「误听形态是自身规范拼写的前缀」会给**警告**而不是拒绝。

确实需要这些配置时，`{ allowConflicts: true }` 把拒绝降级为 `dict.warnings`。请注意它是逃生舱而不是修复——上面的测试用例把这个配置的不安全后果也断言下来了。

---

## 选项

```js
createDictionary({ terms, options: { ... } })
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `canonicalTerms` | `true` | 是否把已知术语改写为规范拼写 |
| `crossScript` | `true` | 是否启用中文误听 → 拉丁术语 |
| `maxPhraseChars` | `8` | 跨语种匹配考虑的最长中文跨度 |
| `spacing` | `'space'` | 中英之间的空格：`'space'` / `'none'` / `'preserve'` |

**这里没有模糊匹配，而且是刻意的。** 早先版本提供过一个 `fuzzyTerms` 开关；独立审计实测它是**空开关**——对真实词条的 6,748 个单编辑变体，开与关改回来的都是同样 2 个（且那 2 个走的是精确通道），40,000 个英文词典词的输出零差异。让它安全的那些条件（要求存在真实的第二名、相似度下限 0.85）同时也让它永远不触发。

**一个什么都不做的开关比没有开关更糟**：用户打开「模糊纠错」，以为打错的词现在能兜住了，实际什么都没变。所以它被删掉了，而不是留着当装饰。

历史背景仍然有效：早先那次模糊匹配没有这些守卫时，扫描 210,604 个英文单词**改坏了 97 个**（`harmless` → `Harness`、`upgrade` → `Gradle`）。要重新引入模糊匹配，得先拿出一个能在实测语料上跑赢精确通道的设计——老的那个没做到。

---

## API

```js
const dict = createDictionary({ terms, pairs?, options?, allowConflicts? });

dict.correct(text)              // → string
dict.correctWithChanges(text)   // → { text, changes }  每次改写都记录了 before/after/reason
dict.terms                      // 冻结后的术语表（同一规范拼写的条目已合并）
dict.options                    // 实际生效的选项
dict.warnings                   // string[]，构造期的告警
dict.version                    // 引擎版本号

validateTerms(terms)            // → { errors, warnings }，构造前自检用
```

另外导出底层工具：`toPinyinArray`、`latinTokens`、`fold`、`similarity`、`similarityStrict`、`segments`、`DEFAULTS`、`CORRECT_VERSION`。

---

## 验证你自己的词库

安全性质是可以用工具验证的，不用靠读代码相信。

本仓库带一个独立的审计脚本（发布在 [asr-text-correction-safety](https://clawhub.ai/skills/asr-text-correction-safety)），它回答三个问题：**你的层会不会改坏正常文本？**

```bash
# 用 examples/audit-shim.mjs 指向你自己的词库
PERSONAL_DICTIONARY=./my-glossary.json \
  node path/to/audit.mjs all path/to/examples/audit-shim.mjs
```

它跑三项：英文词典扫描（每个被改坏的真词）、幂等性 fuzz（4000 条混合串）、碰撞面（常见词被改写的数量）。任何一项非零就以退出码 1 结束，可以直接卡 CI。

建议把它接进你的 CI。这个包自己的测试（`npm test`，24 项）也是从同一次对抗审计里长出来的。

---

## 出处与许可

从 [dsh-voice-personal](https://github.com/y16689540962-cloud/dsh-voice-personal) 的纠错层生成——那个项目把它包在本地 SenseVoice 模型外面，做成 DSH 的听写插件。

**只有一个源。** 这个包的 `dist/` 由 `scripts/build.mjs` 从上游的 `lib/correct/` 生成，不手工维护第二份拷贝；构建脚本会拒绝发布引用了未打包模块的引擎，并在写完之后真的 import 一次、跑一次真实纠正。唯一不复制的是词库本身——上游的词库是一个人的私人词汇，发出来既泄隐私对别人也没用，所以这里生成一份空的，术语全部由调用方提供。

MIT。拼音表来自 [pinyin-data](https://github.com/mozillazg/pinyin-data)（MIT，Copyright © 2016 mozillazg），共 26,711 条：抽取读音、去声调、压成连排格式，**读音本身未改动**——另与 pypinyin 0.55.0 逐条对照验证过（允许系统性的 u/ü 合并后，真正错误的读音为零）。完整归属见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
