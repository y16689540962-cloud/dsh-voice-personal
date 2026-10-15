# 设计笔记 —— 以及为什么同音改写器被移除

**中文** | [English](DESIGN.en.md)

本文是项目的推理层。代码很小，但背后的决策并不显然——其中两个与「看起来显然的做法」相反。

## 1. 包装 provider，绝不替换

内置的 SenseVoice provider 掌管着一堆难写的机制：模型下载与校验、原生 worker 子进程、VAD 分段、队列、空闲回收、超时管理。重写其中任何一段都会分叉这些行为，并且随每次 harness 升级漂移。

所以本插件注册一个*新的* provider，通过 service 的公开 API 委托：

```js
const spec = ctx.speechToText.resolve({ audio, providerId: baseId, language });
const result = await ctx.speechToText.transcribe(spec, signal);
```

`resolve()` 会做 service 自己的注册身份校验，被撤销的底层 provider 会大声失败，而不是悄悄产出未纠正的文本。底层 provider 保留自己的 id、仍可选——回滚就是在设置里换 provider，卸载本插件不影响其他任何东西。

**递归守护。** 一个解析「默认 provider」的 provider，一旦自己成了默认就可能解析到自己。因此回退链显式排除自己的 id。这是测试发现、不是读代码发现的：底层 provider 缺席时，原来的回退列表里有 `personal-local`，委托递归到栈溢出。

**边界上 fail-open。** 纠错抛异常时，返回未改动的原始转写。听写绝不能因为文本层的 bug 而丢失。

## 2. 同音改写器为什么在数学上不成立

最初的设计把个人词库按无调拼音建索引，术语的任何误听都会归位到规范形式。它上线了，然后被证明是错的。

A two-syllable key matches every word with that reading. Mandarin homophone density makes
the collision space the whole language:

```
rènwù   人物 / 任务         yībù    一部 / 异步
xìntiáo 信条 / 心跳         biànyī  便衣 / 编译
jiēdiǎn 接点 / 接口         pèizhì  配制 / 配置
```

实测碰撞面：上线过的 12 组两音节词条，**160,454 个不同的两字 CJK 组合**命中键并被改写。观察到的破坏包括 `人物关系很复杂` → `任务关系很复杂` 和 `这是一部好电影` → `这是异步好电影`。

为什么调阈值修不了：匹配在拼音上精确、在语义上错误。选择「人物」还是「任务」靠的是句子上下文，而拼音已经把它丢掉了。调高阈值只是在同一个坏掉的空间里把假阳性换成假阴性。

**What replaced it** recognises that the *safe* subset is cross-script: a Chinese
mis-hearing of a Latin term. `哈里斯` → `Harness` has no same-script collision because the
canonical form is Latin. Three guards make it sound:

1. ≥3 音节——裸 `哈里`（hālǐ）是普通词（哈里发），短词条在建索引时直接拒绝；
2. 整段读音完整——跨度里有任何字不在表里，键就会变短，3 字跨度可能命中 2 音节键（873 个 CJK 字符不在表里，大部分在扩展 A 区；这条守护让它们无害）；
3. 整段拼音键完全匹配——不匹配部分跨度，无模糊边缘。

守护放在索引构建器里，而不是词库数据文件里。数据文件里的规则是文档；索引构建器里的规则对每个未来词条强制生效。

## 3. 拉丁词匹配：默认精确，模糊可选

精确匹配清单覆盖了作者历史里实际观察到的所有误听：
`flcash`, `workbody`, `gHub`, `toptop`, `deep seek`. The tempting next step — fuzzy
matching to catch unseen variants — was measured before shipping: scanning 210,604 English
dictionary words, a fuzzy pass with a length-scaled edit budget corrupted **97 real words**
(`harmless` → `Harness`, `upgrade` → `Gradle`, `cocoa` → `Cocos Creator`).

Two root causes, both structural:

- the index contained the *mis-spellings* as fuzzy references, so `grade` (listed under
  Gradle) acted as an attractor for `upgrade`;
- the runner-up margin guard compared against zero when only one reference scored, so a
  single weak match passed unconditionally.

两个都修了——参照只放规范形式、margin 要求真实第二名——但模糊匹配仍**默认关**。精确匹配已覆盖观察到的现实；模糊 pass 用可测量的损坏率换没观察到的收益。词表里全是新造产品名的用户可以自己开。

## 4. 保护跨度

任何改写 pass 迟早会碰到文件路径、URL、邮箱或版本号。
`harness.git` inside `cd ~/projects/harness.git` is a repository name, not a mis-hearing of
"Harness". The pipeline therefore masks protected spans behind private-use sentinels
before any pass runs, and restores them afterwards:

```js
const { masked, restore } = maskProtected(text);
// ... all passes operate on `masked` ...
cur = restore(cur);
```

这个模式比正则清单本身更重要：一个机制覆盖现在和未来的所有 pass，而不是每个 pass 各自维护「这是不是路径」的判断。

## 5. 口水词删除：白名单 + 保守上下文

口水词从用户自己的语料学（`呃 ×11, 然后 ×12`），不是通用清单——画像的白名单才是碰撞面的边界。上下文规则再逐处判定：

| 形态 | 动作 | 原因 |
|---|---|---|
| `呃，帮我…` | 删 | 标点前独立成词 |
| `嗯，那个，我觉得…` | 删，级联 | 句首口水词连用 |
| `就是这个问题` | 保留 | 这里「就是」有实义 |
| `那个插件` | 保留 | 指示代词，不是口水词 |
| `唉声叹气` | 保留 | 「唉」是真实词的词素 |

最后一行是承重的那条。旧版本曾允许「句首 + tier1 语气词 + 后接实词字符」时删除——立刻把 `唉声叹气` 改坏了。现在粘着实词的语气词只有命中白名单（`啊哈/哦豁/哎呀…`）才删，其余一律保留。粘字形态（`呃帮我稳定一下`）是已知且被接受的漏删：字符级上下文分不清语气词和词素，作者语料里粘字形态占口水词出现的 9.5%，可安全删除的带标点形态占 90.5%。

## 6. 幂等性是正确性属性，不是锦上添花

后处理层可能在同一段文本上运行多次（重试、重新插入、切换 provider）。任何不幂等的 pass 都会让文本无界增长。 The
worst case shipped briefly: `cocos creator` → `Cocos Creator Creator` → …, because the
phrase pass emitted a canonical form that the single-token pass then expanded again.
Two rules ended it: never re-expand a form that already equals its canonical, and never
list a canonical's own prefix as a mis-hearing of itself.

测试对精选用例和 fuzz 输入（4,000 个混合原子串）都断言 `correct(correct(x)) === correct(x)`。

## 7. 空白是内容

`tidy()` 曾把连续空格（包括行首缩进）折叠——静默重排了口述的 Python/YAML。缩进是行结构；现在 tidy 原样保留行首空白，只折叠*内部*连续空格。 The correction suite asserts a Python block
and a YAML document survive byte-identical.

## 8. 验证顺序

测试按重要性的固定顺序断言：

1. 绝不破坏已经正确的文本（假阳性是语义被静默改变）；
2. 修正真实历史里观察到的误听。

这个顺序裁决所有取舍。漏改一次的代价是用户手动补一个词；误改一次是用户说的话被悄悄改变。词库里每条 guard 都是一句被旧版本损坏过的句子。
