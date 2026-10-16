# dsh-voice-personal 第二轮对抗审计报告

> 发布前脱敏：复现命令里的本机路径换成 `/Users/me/`、`<tmp>/`。除此之外未改动任何数字或结论。

**审计目标**：打破核心不变量 **「绝不破坏已经正确的文本」**。
**审计方式**：独立对抗审计。只读仓库（唯一写入是本报告），所有临时文件在 `/tmp`，全部结论都跑过代码。
**时间**：2026-10-16 18:39 – 19:05（Asia/Shanghai）。
**结论**：**11 类可复现缺陷 + 1 条信息级**，其中 **2 类严重**。全部附可复现命令与实际输出。
**同时**：历史九类缺陷逐条独立复验，**没有一类复活**；并发/重入、失败降级、非法输入、mtime 缓存（改动后）等 6 项阴性结果见 §5。

---

## 1. 审计方法与修订说明

### 1.1 实际做了什么

| 手段 | 规模 | 目的 |
| --- | --- | --- |
| 逐词喂英文词典 | `/usr/share/dict/words` 210,626 词 × (fuzzy 关/开) | 误伤普通英文 |
| 随机中文串 | 200,000 条（常见字池，2–5 字） | 同音误伤（历史 16 万碰撞回归） |
| 随机混合串幂等 | 60,000 条内置词库 + 30,000 条复跑 | 非幂等/逐轮增长 |
| 词条管线模糊测试 | 4,000 组随机用户词条 | 规范形被自己改写、增长 |
| fuzzy 门槛穷举 | 6,748 个内置词的 1 编辑变体 | 模糊通道到底能不能生效 |
| 端到端插件驱动 | 假 `ctx` 驱动 `apply()` → `transcribe()` | 真路径（配置、词库、降级、并发） |
| 并发压测 | 200 次听写 + 期间 20 次改词库 | 撕裂/丢结果 |
| 权限/损坏/半截文件 | chmod 000、目录、半个 JSON | 静默失忆 |

### 1.2 审计期间源码被改动（必须说明）

审计开始时（18:39）读到的 `lib/correct/user-terms.js` 用 `${mtimeMs}:${size}` 当缓存键；
**18:44:32 该文件被改成按文件内容当键**（有人在我审计过程中改了它，不是我改的——我从未写过仓库文件）。
随后 **18:49:20 `scripts/terms.mjs` 又被改**（只是颜色输出/帮助文本，与校验逻辑无关）。

因此本报告的处理方式：

1. 我把审计开始时的整棵树快照到 `<tmp>/audit2/snap/repo`；
2. 所有结论**在快照与当前树各跑一遍**，输出一致（唯一差异是打印的仓库路径）；
3. 与缓存键有关的那条（§5 N2）单独说明"改动前会碰撞、改动后已验证修好"；
4. 每条发现标注验证时的文件哈希。

### 1.3 被审计修订（sha256 前 16 位）

| 文件 | sha256(16) | mtime | 审计期间是否变动 |
| --- | --- | --- | --- |
| `index.js` | `f2170e1af868250c` | 10-16 18:36:21 | 否 |
| `lib/correct/index.js` | `883d3c7f7d510c3f` | 10-16 18:34:01 | 否 |
| `lib/correct/glossary.js` | `60444dd1d6960409` | 10-16 18:26:49 | 否 |
| `lib/correct/latin.js` | `212d1f216a5ce487` | 10-15 20:32:34 | 否 |
| `lib/correct/pinyin.js` | `0f9bb1b99a5e31c4` | 10-15 19:30:54 | 否 |
| `lib/correct/user-terms.js` | `edd550c3fe06b991` | **10-16 18:44:32** | **是**（内容键，修 mtime 缓存） |
| `scripts/terms.mjs` | `5fb7d15431924698` | **10-16 18:49:20** | **是**（仅颜色/帮助） |
| `test/corpus/regression.json` | `5c1571d76b47b9d1` | 10-16 18:20:26 | 否 |

基线（我自己跑的，不是引用）：`node test/eval.mjs` **70/70 PASS**；`node test/correct.test.mjs` **118/118**；`node --test test/user-terms.test.mjs` **22/22**；`node lib/voiceprint/selftest.mjs --no-model` **38/38**；`node lib/style/self-test.js` 全通过；`audit.mjs all` 三项 CLEAN。

复现材料：最小复现脚本 `<tmp>/audit2/repro/f1.mjs` … `f11.mjs`（源码见附录 C）；一键脚本 `<tmp>/audit2/verify/verify-all.mjs`（用法见附录 A）。
统一输出：**缺陷类断言复现 35 / 40；对照与负结果符合预期 15 / 15**。

---

## 2. 发现总表

| # | 严重度 | 缺陷一句话 | 实测复现 | 后果 |
| --- | --- | --- | --- | --- |
| **A1** | **高** | 遮罩/还原嵌套：反引号内含邮箱/版本/flag/URL(带空格) 时，正文被换成**不可见私用区字符**，且 `changes` 记录为空 | ✅ | 静默损坏已正确的文本，用户看不见 |
| **A2** | **高** | `terms.json` 的 `pairs` **完全绕过全部校验**：规范拼写自身被改写 + 反复应用**无界增长**（历史缺陷复活），CLI 却报 ✓ | ✅ | 逐轮增长、正常短语被改写 |
| **A3** | 中 | 中文后**紧跟**路径（无空格）不被遮罩 → 路径段被改大小写 | ✅ | `/…/flcash`→`/…/FlClash`、`~/.dsh`→`~/.DSH` |
| **A4** | 中 | 内置规范拼写是普通英文词 → 普通词义、句首大写、下划线标识符被改写 | ✅ | `test harness`→`test Harness`、`agent_id`→`Agent_id` |
| **A5** | 中 | `fuzzyTerms: true` 是**死开关**（开关前后都是 6,748 个 1 编辑变体里只改回 2 个，且那 2 个来自精确通道；40,000 词输出零差异） | ✅ | 用户以为开了模糊纠错，实际没有 |
| **A6** | 中低 | 冲突检测只做**条目内**：跨条目三类碰撞全部静默（别人多词规范形的一个词／拼音键撞车／仅大小写不同），`terms.mjs check` 全报 ✓ | ✅ | 用户明写的词条静默失效或被改写 |
| **A7** | 中低 | `terms.json` **读不动**（EACCES/EISDIR/EIO）时丢掉内存里上一次可用词库 | ✅ | 静默失忆（每次听写都报警告） |
| **A8** | 中低 | 配置值**类型/枚举不校验**：`spacing` 拼错静默按 `none` 删空格；`requireEnrolledSpeaker: "False"` 反向**打开**门禁 → 每次听写被拒 | ✅ | 配置写错 → 行为反向 + 丢听写 |
| **A9** | 低 | `tidy` 无法关闭，且改写**字符串字面量内**空白、首行缩进、结尾换行 | ✅ | `print("a  b")`→`print("a b")` |
| **A10** | 低 | URL/邮箱正则**平方复杂度**：50k 字符 8.5 s | ✅ | 真实听写够不到；对库的其它调用方是潜在 DoS |
| **A11** | 低 | `changes[].at` 单位不一致（cross-script 用码点、latin 用 UTF-16） | ✅ | `audit: true` 时高亮错位 |
| **A12** | 信息 | 内置 `TERMS` 里 `DeepSeek` 重复；无用户词条时 `BUILTIN_TERMS` 不经过 `mergeTerms`/`checkTerms` | ✅ | 使 fuzzy 次佳分=最佳分，永远差 0 |

---

## 3. 逐条发现

### A1（高）遮罩/还原嵌套把正文换成不可见私用区字符

**实测复现**（`lib/correct/index.js` `883d3c7f`，当前树同）

```bash
node <tmp>/audit2/repro/f1.mjs
```

实际输出（`<…>` 是我为不可见字符加的可视化）：

```
泄漏 "这是 `v2.0.1` 版本" -> "这是 `<U+E000>0<U+E001>` 版本"
泄漏 "发给 `x@y.com` 就行" -> "发给 `<U+E000>0<U+E001>` 就行"
泄漏 "用 `--force` 参数" -> "用 `<U+E000>0<U+E001>` 参数"
泄漏 "run `npm i -g foo --verbose` now" -> "run `npm i <U+E000>0<U+E001> foo <U+E000>1<U+E001>` now"
泄漏 "看 `https://a.b/c 说明` 链接" -> "看 `<U+E000>0<U+E001> 说明` 链接"
```

`changes` 是空的（**审计模式也查不出来**）：

```
$ node -e "…const r=c.correct('这是 \`v2.0.1\` 版本'); console.log(r.text==='这是 \`v2.0.1\` 版本', JSON.stringify(r.changes), /[\uE000-\uF8FF]/.test(r.text))"
输出是否为原文: false
changes: []
输出里有私用区字符: true
```

**触发规则**（我做了 10 格矩阵，见下）：**只要有保护跨度在反引号对内被遮罩、且两个反引号都活下来**，内层哨兵就永远不会被还原。
内层类型中，邮箱、版本号、CLI flag 三个正则**没有前导分隔符要求**，必然留下成对反引号 → 必然泄漏；URL / Windows 路径的 `[^\s]+` 贪婪时会连尾反引号一起吃掉（安全），**但只要跨度内有空格就会泄漏**（`看 \`https://a.b/c 说明\` 链接`）。

```
泄漏   反引号内 版本号      泄漏   反引号内 邮箱      泄漏   反引号内 flag
正常   反引号内 win 路径     正常   反引号内 URL(紧贴)  泄漏   反引号内 URL(后有空格)
正常   反引号内 路径        正常   反引号内 扩展名     泄漏   反引号内 两个 flag
正常   仅一个反引号
```

**根因**：`lib/correct/index.js:78-90`。`maskProtected` 按 `PROTECTED` 顺序逐条替换成 `\uE000{idx}\uE001`，把被替换后的整串（**里面已经含有内层哨兵**）压进 `spans`；`restore` 用一次 `String.replace` 还原（`:88`）。`String.replace` **不会重新扫描替换进去的文本**，所以内层哨兵原样留在输出里。第 7 条 `行内代码` 的字符类是 `[^\`\n]*`，它能吞掉任何内层哨兵，是唯一会嵌套的规则。

**影响**：承诺"URLs、paths、emails、versions 和 CLI flags 在任何改写前被遮罩，`harness.git` 永远不会被碰"（`lib/correct/index.js:22-25`）——实际是**保护机制本身把内容换成了不可见字符**。私用区字符在编辑器里看不见，落进会话记录/代码里就是极难定位的污染；`changes` 为空意味着连事后审计都无从下手。触发需要转写结果里有成对反引号；项目自己的冻结语料里就有反引号用例（`prot-inline-code: \`github\``），说明作者认为反引号在听写里是现实存在的——只是他们只测了不含内层保护跨度的那一种形状。

**建议**：`restore` 迭代还原到不动点（有界循环，例如 `while (/\uE000\d+\uE001/.test(s))`，上限 = 保护规则条数），或把行内代码放到第一位遮罩，或让哨兵自身含反引号使其无法被 `[^\`\n]*` 吞掉。补一条矩阵化测试（邮箱/版本/flag/URL 带空格 × 反引号）。

---

### A2（高）`pairs` 完全绕过校验：规范形被改写 + 无界增长（历史缺陷复活）

**实测复现**

```bash
node <tmp>/audit2/repro/f2.mjs
```

```
规范拼写: "Cocos Creator" -> 第一遍: "Cocos Creator Creator"
第 1 遍: len=21 "Cocos Creator Creator"
第 2 遍: len=29 "Cocos Creator Creator Creator"
第 3 遍: len=37 "Cocos Creator Creator Creator Creator"
第 4 遍: len=45 "Cocos Creator Creator Creator Creator Creator"
pairs:[{heard:"harness",say:"ZzzOther"}] 下，"the harness is here" -> "the ZzzOther is here"
pairs:[{heard:"哈里斯",say:"ZzzOther"}] 下，"哈里斯" -> "ZzzOther"
```

端到端（真 `apply()` → `transcribe()`，`terms.json` 只写 `{"version":1,"terms":[],"pairs":[{"heard":"cocos","say":"Cocos Creator"}]}`）：

```
第 1 次听写 -> "Cocos Creator Creator 是我在用的引擎"  (len=29)
第 5 次听写 -> "Cocos Creator Creator 是我在用的引擎"  (len=29)
插件日志: (无警告)
```

CLI 不但不拦，还把它写回去（当前版本 `5fb7d154`，18:49）：

```
$ NO_COLOR=1 DSH_VOICE_PERSONAL_DIR=<tmp>/audit2/cli2 node scripts/terms.mjs check
✓ 1 条词条全部可用          exit=0
$ NO_COLOR=1 DSH_VOICE_PERSONAL_DIR=<tmp>/audit2/cli2 node scripts/terms.mjs add ZzzNew --heard zzznew
已添加「ZzzNew」，误听形态 zzznew
已写入 <tmp>/audit2/cli2/terms.json
  词条 2 条
$ cat <tmp>/audit2/cli2/terms.json
{ "version": 1, "terms": [ … ], "pairs": [ { "heard": "cocos", "say": "Cocos Creator" } ] }
```

**根因**：两处都只认 `terms`，不认 `pairs`。

* `index.js:143` 的"安全网"只对 `merged.terms` 调 `partitionTerms`；`:154` 把 `loaded.pairs` **原样**塞给 `createCorrector`。
* `lib/correct/index.js:131-142`（pairs 循环）对 `pairs` 只做"非空 + CJK 长度≥3"检查，没有 `checkTerms` 的任一守卫。
* `scripts/terms.mjs:98-99` 的 `report()` 只 `mergeTerms(normalizeTerms(doc.terms))`；`writeOrRefuse` 在 `:133` 用 `{version:1, ...doc}` 把 pairs 一起写回。

于是 `heard:'cocos'` 同时进了 `latinExact`（token 通道）和 `latinPhrases`（短语通道，来自内置 `Cocos Creator`），两条通道互相喂养——这正是 `glossary.js:54-56` 说已经修掉的那一类增长（"`Cocos Creator` -> `Cocos Creator Creator` -> …"）。而 `lib/correct/user-terms.js:19-27` 与 `index.js:141-142` 都写着"任何东西都不许未经审查到达听写"，pairs 是唯一的例外。

**影响**：只要用户在 `terms.json` 里手写一条 `pairs`（CLI 没有 pairs 命令，但文件格式接受、`terms.mjs list` 会打印它、`add/remove/import/apply` 都会把它原样写回），就能造出**无界增长**和"自己的规范拼写被自己改写"。README 完全没提 `pairs`，而 `glossary.js:31` 却写"README says so"——文档与实现对不上。

**建议**：把 `pairs` 送进同一套守卫（`normalizeTerm` + `checkTerms`/`partitionTerms`），或者直接删掉 `pairs` 通道（`PAIRS` 出厂就是空的、README 从未宣传）；CLI 的 `check`/`writeOrRefuse` 必须在**合并后的语义视图**上校验，而不是只看 `terms` 数组。

---

### A3（中）中文后紧跟的路径不受保护 → 路径被改写

**实测复现**

```bash
node <tmp>/audit2/repro/f3.mjs
```

```
"改~/.dsh/profiles/desktop/cordis.patch.yml 这个文件" -> "改~/.DSH/profiles/desktop/cordis.patch.yml 这个文件"
"打开/Users/me/flcash 看日志"                     -> "打开/Users/me/FlClash 看日志"
"改 ~/.dsh/profiles/desktop/cordis.patch.yml 这个文件" -> （不变，被保护）
"打开 /Users/me/flcash 看日志"                     -> （不变，被保护）
```

**根因**：`lib/correct/index.js:65` 的路径规则要求前导字符属于 `^`、空白或 `([<"'\``：

```js
/(?:^|[\s([<"'`])(?:~|\/|\.{1,2}\/)[^\s)\]}>"'`]*/g
```

中日韩汉字不在这个类里，所以 `改~/.dsh/…`、`打开/Users/…` 整段**不进遮罩**，后面的 `fixLatin` 就把它当普通文本改。这个前导要求本来是为了别把 `10/16` 当路径（合理），代价是漏掉了中文紧贴路径这一常见形态（中文本来就不在词间加空格）。

**影响**：违背"文件路径永不被碰"的承诺；`~/.DSH` 在大小写敏感的文件系统上是错的。讽刺的是：引擎自己的空格归一化会把空格**加在**中文和拉丁之间，但遮罩发生在空格归一化**之前**，所以那一遍救不了它（下一遍输入来自 ASR 原文，仍无空格，于是每次都复发）。

**建议**：前导类补上 CJK 区间（`[\u3400-\u4dbf\u4e00-\u9fff]`），或改成"左边界不是 `[A-Za-z0-9_.]`"这类负向条件。

---

### A4（中）内置规范拼写是普通英文词 → 普通词义/句首大写/下划线标识符被改写

**实测复现**

```bash
node <tmp>/audit2/repro/f4.mjs
```

```
"the test harness is broken" -> "the test Harness is broken"
"raise an issue"             -> "raise an Issue"
"Token 过期了"                -> "token 过期了"
"把 agent_id 传进去"          -> "把 Agent_id 传进去"
"harness_test 挂了"           -> "Harness_test 挂了"
"my_workbody_key"            -> "my_WorkBuddy_key"
词典被改写: 6/210626 -> agent, android, codex, harness, issue, obsidian
```

**根因**：`glossary.js:42-76` 的规范形里有大量**普通英文词/常用技术词**（`harness`、`agent`、`issue`、`token`、`prompt`、`commit`、`android`、`codex`、`obsidian`、`paperclip`、`claude`、`vpn`、`apk`）。`buildIndexes`（`lib/correct/index.js:100-101`）把 `fold(say)` 无条件写进 `latinExact`，`fixLatin`（`:195-200`）命中就按大小写改写；而 `latinTokens`（`latin.js:15`）的词界**不含下划线**，所以 `agent_id` 里的 `agent` 是独立 token。

这与词库自己的声明直接冲突：`glossary.js:38-40` 写 "Do not list a form that is itself an ordinary word … Entries that are real words are excluded by design"，`GUARDS` 里也专门保护了 `grade`/`cloud`/`harmless`/`upgrade`——但没保护 `harness`（test harness 是标准术语）、`token`/`prompt`/`commit`（句首会被降成小写）、`agent`。

**诚实边界**：下划线标识符的**大小写归一本身是团队有意的**——冻结语料 `miss-claude-codex` 的期望就是 `claude_local -> Claude_local`。所以这条不是"实现 bug"，而是**设计决定没有被记录、爆炸半径没人算过**：语料只祝福了两个 DSH provider id，规则却对任何含词库词的下划线标识符生效（顺带把 **heard 误听映射**也带了进去：`flcash_config -> FlClash_config`，这不是大小写归一，是把变量名改成了另一个词）。

**建议**：把"纯大小写差异"和"heard 误听映射"分开——大小写归一可以保留，误听映射在 `_` 相邻时应当跳过；句首位置（或全大写缩略语）不做降级；`glossary.js` 的"真实单词已排除"声明要么改掉，要么让它成真。

---

### A5（中）`fuzzyTerms: true` 是死开关

**实测复现**

```bash
node <tmp>/audit2/repro/f5.mjs
```

```
fuzzy 参考词: …, Harness, DeepSeek   <-- DeepSeek 出现 2 次
fuzzyTerms=false: 6748 个 1 编辑变体中被改回 2 个: flcash, gihub
fuzzyTerms=true:  6748 个 1 编辑变体中被改回 2 个: flcash, gihub
```

那 2 个（`flcash`、`gihub`）本来就在内置 `heard` 里，是**精确通道**改回的；40,000 个词典词在开关前后输出差异 **0 条**、`audit.mjs` 的 210,604 词扫描也是同样 6 条大小写归一。也就是说 **fuzzy 通道一次都没生效过**。

**根因**：`lib/correct/index.js:213-214`

```js
if (best && bestScore >= opts.minLatinSimilarity
    && runnerUp > 0 && bestScore - runnerUp >= opts.fuzzyMargin) {
```

`runnerUp > 0` 要求**至少还有第二个参考词也相似**。18 个唯一参考词里没有任何两个彼此在 2 编辑内（最近的一对是 `Codex`/`token`，相距 3），所以现实中的情形（一个产品名、一个拼错）永远是 `best=0.857, runnerUp=0` → 不通过（门槛分布实测：`flcash 0.857/0.000`、`orkbuddy 0.889/0.000`、`aperclip 0.889/0.000` …）。唯一 `runnerUp>0` 的样例是 `eepseek/deepseek` 这类，但那是因为 **`TERMS` 里 `DeepSeek` 重复了两次**（`glossary.js:48` 与 `:75`），两个分数都是 0.875 → 差 0 → 仍不通过。`createCorrector` 在无用户词条时直接用 `BUILTIN_TERMS`（`index.js:134`），既没 `mergeTerms` 去重，也没 `checkTerms` 检查。

**代价/收益是反的**：同一批 6,748 个变体，把 `runnerUp > 0` 去掉后（仅在 `<tmp>/audit2/patched` 副本上改，仓库未动）能改回 **4,576 个（67.8%）**；而重扫 210,626 个词典词只多坏 **5 个**：`aneroid->Android`、`commixt->commit`、`farness/hardness/hoarness->Harness`。也就是说这个门槛用 5 个词典词的代价，换掉了 4,576 个真实拼写错误的修复能力。

**用户可见的后果**：README `:250` 写着 `fuzzyTerms: false # 模糊英文匹配（默认关，见下）`，而**下面没有"下"**（下一节是"五、结构"），README 通篇不再解释这个开关。用户按提示打开它，什么都不会发生，也没有任何提示——典型的"以为改好了、实际没生效"。

**建议**：三选一——删掉这个开关；或者去掉 `runnerUp > 0`（保留 0.85 下限）并把那 5 个词的代价写进文档；或者改成"只在词不在英文词典里时才模糊"（`glossary.js:40` 已经这么宣称了，只是没实现）。顺手给 `TERMS` 去重。

---

### A6（中低）冲突检测只做条目内：三类跨条目碰撞全部静默

**实测复现**

```bash
node <tmp>/audit2/repro/f6.mjs
```

```
用户词条 [{"say":"Cursor","heard":["creator"]}]                      errors=0  Cocos Creator -> "Cocos Cursor"
用户词条 [{"say":"Foo","heard":["哈利斯"]}]                          errors=0  哈利斯 -> "Harness"
用户词条 [{"say":"dsh","heard":[]}]                                  errors=0  dsh -> "DSH"
用户词条 [{"say":"Foo","heard":["哈利斯"]},{"say":"Bar","heard":["哈里斯"]}]  errors=0  哈里斯 -> "Bar"
```

`errors=0` 表示 `checkTerms` 通过、`terms.mjs check` 会打印"✓ … 全部可用"。

**根因**：`checkTerms`（`lib/correct/index.js:394-449`）的三条判据都是条目内的：

1. `heard` 是否等于**某条规范拼写**——用 `fold(h)` 精确比 `canonicalByFold`，因此**看不出**"`heard` 是别人多词规范形里的一个词"（`creator` 不是 `Cocos Creator` 的 fold，但它是它的一个 token）；
2. CJK 音译键（`:136-137`）没有查重，`pinyinCanon.set` 后来者覆盖 → 用户明写的 `哈利斯→Foo` 被内置 `哈里斯→Harness` 顶掉；
3. 规范拼写查重用的是精确字符串（`:403`），`dsh` 与 `DSH` 不算重复 → 合并后 `buildIndexes` 的 `latinExact.set(fold(say))`（`:100`）里后写的内置条目获胜（用户词条永远排在前面），于是**用户声明的规范形被引擎自己改写**，而 `user-terms.js:160-163` 承诺的是"用户重定义 → 用户说了算"。

**影响**：三类都不会崩、不会警告，只会"静默地不按用户说的做"或"顺手改掉另一个词"。第 4 例更糟：两条用户音译词条共享拼音键时，两条映射**塌成一条**，而 CLI 报 ✓。

**建议**：`checkTerms` 增加三类判据——(a) `heard` 是否命中**任何**条目的规范形 token 集合；(b) CJK 音译键查重（`toPinyinArray(h).join('')`）；(c) `fold(say)` 查重（现在只查精确）。另外让合并顺序确定（用户永远赢）并有报告。

---

### A7（中低）`terms.json` 读不动时丢掉"上一次可用词库"

**实测复现**

```bash
node <tmp>/audit2/repro/f7.mjs
```

```
第一次 load(): 1 条
  warn: [voice-personal] 用户词库：无法读取 <tmp>/audit2/repro/perm/terms.json（EACCES），已忽略
chmod 000 后 load(): 0 条  error= null   <-- 内存里明明还有 1 条可用
  warn: [voice-personal] 用户词库：… 解析失败，暂时沿用上一次可用的 1 条词条：…
对照：JSON 损坏时 load(): 1 条（沿用上一次可用值）
```

端到端也一样（`chmod 000` 文件 / 目录 / 把文件换成目录，三种都发生）：

```
1) 正常      : "ZzzAlpha"
2) 目录 000  : "zzzprod"   ← 用户词库消失，只剩内置词库
4) 文件 000  : "zzzprod"
6) 文件变目录: "zzzprod"
7) 半个 JSON : "ZzzAlpha"  ← 对照：解析失败时才沿用上一次可用值
```

**根因**：`lib/correct/user-terms.js:78-83`——`readFileSync` 失败（非 ENOENT）直接 `return { ...EMPTY, key: ABSENT_KEY }`，`terms: []`；而 `lastGood`（`:73`、`:106`）只在**解析失败**分支（`:114-124`）被使用。于是"文件读不动"和"文件不存在"被当成同一件事。

**影响**：与文件里写着的设计规则冲突——"**Keep the last good set.** A broken file at 3am should not empty the glossary"（`:25-26`）。权限错误/IO 错误/文件被换成目录都会让用户的几十条词条当场失效，而用户只看到一条日志（每次听写都重复打一次）。修复前的老版本至少 stat 失败才丢，新版把 EACCES/EISDIR 也一起丢了——范围反而更大了一点。

**建议**：读失败时返回 `lastGood`（`terms: lastGood.terms, pairs: lastGood.pairs, error: …`），只有 ENOENT 才返回空；把"读失败"的警告也做成 `warnedFor` 去重。

---

### A8（中低）配置值类型/枚举不校验 → 行为反向

**实测复现**

```bash
node <tmp>/audit2/repro/f8.mjs
```

```
spacing="space"     -> "中文 Hello 中文"
spacing="none"      -> "中文Hello中文"
spacing="preserve"  -> "中文 Hello 中文"
spacing="Space"     -> "中文Hello中文"     ← 拼错 = 静默按 none
spacing="spaces"    -> "中文Hello中文"
spacing="true"      -> "中文Hello中文"
```

门禁反向（真 `apply()`，`requireEnrolledSpeaker` 传字符串）：

```
requireEnrolledSpeaker=false    -> 听写成功: "FlClash 测试"
requireEnrolledSpeaker="False"  -> 抛错拒绝: 个人语音：已开启「只认我的声音」，但声纹模型不可用…
requireEnrolledSpeaker="false"  -> 抛错拒绝
requireEnrolledSpeaker="no"     -> 抛错拒绝
requireEnrolledSpeaker="off"    -> 抛错拒绝
```

**根因**：`index.js:76-81` 的 `readConfig` 只把 `undefined/null/''` 换成默认值，不做类型检查；`lib/correct/index.js:282-289` 的 `fixSpacing` 用 `if (spacing === 'space') … else …`，**任何非 `space`/`preserve` 的值都落进 `none` 分支**（删空格，最有破坏性的那一支）。

**影响**：两个方向都是"用户写的和实际做的相反"。`spacing: Space`（大小写笔误）或 `spacing: true`（误读文档）会安静地删掉中英之间所有空格——而 README `:158` 说"默认自动加空格（因为你的历史消息里 82% 是加空格的）"，用户想要的是加。`requireEnrolledSpeaker: "False"`/`False`/`"no"`/`"off"`（YAML 里只有裸 `false` 是布尔）会把门禁**打开**，在模型不可用时**每次听写都被拒绝**——直接违反"绝不丢一次听写"。注意 YAML 1.1 的裸 `no`/`off` 是布尔（安全），出问题的是引号形式和 Python 风格的 `False`。

**建议**：`spacing` 用白名单，非法值 → 用默认 + `warn`（绝不落到 `none`）；`readConfig` 对布尔项做 `typeof === 'boolean'` 校验，字符串 `'false'/'no'/'off'` → `false` + 警告。

---

### A9（低）`tidy` 无法关闭，且改写字符串字面量/首行缩进/结尾换行

**实测复现**

```bash
node <tmp>/audit2/repro/f9.mjs
```

```
"print(\"a  b\")"        -> "print(\"a b\")"
"{\"k\":  \"v  v\"}"     -> "{\"k\": \"v v\"}"
"| a   | b   |"          -> "| a | b |"
"    x = 1\ny = 2"       -> "x = 1\ny = 2"
"def f():\n    return 1\n" -> "def f():\n    return 1"
spacing=preserve 时 print("a  b") -> "print(\"a b\")"   <-- tidy 关不掉
```

**根因**：`lib/correct/index.js:301-313`；`tidy(cur)` 在 `:538` **无条件**执行，`spacing: 'preserve'` 只让 `fixSpacing` 提前返回（`:278`），不影响 `tidy`。`/[ \t]{2,}/g` 对缩进之外的**一切**空白生效，包括引号内部；结尾 `.replace(/^[\s]+|[\s]+$/g, '')` 顺带削掉首行缩进和结尾换行。

**诚实边界**：把 `a  b → a b` 当作期望写进了冻结语料（`edge-inner-double-space`），所以"折叠空白"本身是有意行为，Python/YAML 的**缩进**也真的保住了（`ws-python`/`ws-yaml`/`ws-tab-indent` 三条我复验通过）。这条的分量在于：(1) 它改的是**引号里的内容**（`print("a  b")`、JSON 值、Markdown 表格列宽），(2) 首行缩进和结尾换行会被削（文档 `lib/correct/index.js:28-29` 说 "Indentation and newlines survive"），(3) **没有任何配置能关掉它**——用户遇到 `print("a  b")` 被改坏时无路可走。

**建议**：给 `tidy` 一个开关（`tidy: false`），至少不要动引号内的连续空白；把 `^[\s]+|[\s]+$` 的裁剪限制在纯空白输入（`edge-spaces` 那条用例的实际需求）。

---

### A10（低）URL/邮箱正则平方复杂度

**实测复现**

```bash
node <tmp>/audit2/repro/f10.mjs
```

```
10000 个 a: 330 ms
30000 个 a: 2979 ms
50000 个 a: 8497 ms
```

单条正则计时定位（50,000 个 `a`）：URL `5199 ms`、邮箱 `4949 ms`（纯数字输入时邮箱 `4228 ms`）。即 `[a-z][a-z0-9+.-]*:\/\/[^\s]+` 与 `[\w.+-]+@[\w-]+\.[\w.-]+` 在每个起点都回溯到串尾。

**诚实边界**：真实听写到不了这个长度（10k 字符≈几十分钟连续语音），所以对插件是**潜在**问题，我没有观察到实际卡顿。但 `lib/correct/index.js:15-17` 说这个引擎同时给独立包 `asr-personal-dictionary` 用，那边的输入是任意文本；`correct()` 也没有长度上限或超时。标注为"实测耗时 / 可达性推断为低"。

**建议**：给输入加长度上限（超限直接跳过纠正或分块），或把这两条正则改成原子组/占有量词等线性写法。

---

### A11（低）`changes[].at` 单位不一致

**实测复现**

```bash
node <tmp>/audit2/repro/f11.mjs
```

```
原文: "😀 哈里斯 说的"  changes.at = 2  但 UTF-16 下标应为 3 -> " 哈里"
```

`fixCrossScript` 的 `at: i` 是 `[...text]` 的**码点**下标（`lib/correct/index.js:242,260`），`fixLatin` 的 `at: tok.index` 是 UTF-16 下标（`:221`）。有非 BMP 字符（emoji）时前者偏小。只影响 `audit: true` 时返回的 `changes`（`index.js:293`），不会改坏文本；但如果有 UI 拿它做高亮，会标错位置。

**建议**：统一成一种下标（建议码点，并同时给出 `length`），或在文档里写明单位。

---

### A12（信息）内置词表重复项 / 无用户词条时不走去重与检查

`TERMS` 里 `DeepSeek` 出现两次（`glossary.js:48`、`:75`），实测 `fuzzy` 参考词表里也是两次；`index.js:134` 在用户词条为空时直接 `terms = BUILTIN_TERMS`，跳过 `mergeTerms`（去重）与 `partitionTerms`（一致性检查）。当前没有造成可见损坏，但它让 `best === runnerUp`，是 A5 的一部分成因。建议：对内置表也跑一遍 `mergeTerms`+`checkTerms`，并在测试里断言 `checkTerms(TERMS)` 无 error。

---

## 4. 历史九类缺陷的独立复验（全部未复活）

| 历史缺陷 | 我的复验方式 | 结果 |
| --- | --- | --- |
| 2 字同音匹配碰撞 16 万（机制已删） | 200,000 条随机中文串（含 `人物/任务`、`一部/异步` 等同音字池） | **0 条被改写**；`GUARDS` 16 条原文全部保持不变 |
| `heard` 变体改坏正常英文 | 210,626 词典词逐词过 `correct()` | 仅 6 条（大小写归一，见 A4），无词义替换 |
| 模糊匹配改坏 97 个词典词 | 同上，`fuzzyTerms: true` | 仍是同样 6 条，fuzzy 未触发（见 A5） |
| 扩展名被吞 | `看 index.js 这段`、`a.json b.yaml c.py d.ts e.lock`、`node_modules 和 package.json`、`x.apk y.ipa` | 全部原样 |
| 非幂等增长 | 60,000 + 30,000 条随机混合串，逐条比对一遍/两遍 | **0 条非幂等、0 条增长**（内置词库；`pairs` 通道除外，见 A2） |
| 拼音表缺字导致跨度坍缩 | 用真实缺字（`烪` U+70EA，表中 26,711 字不含它）插在 `迪普西克` 前后 | `烪迪普西克 -> 烪 DeepSeek`（正确）；`迪普烪西克` 不动（安全漏改）。**没有**把 5 字跨度缩成 3 音节去命中别的键 |
| 字数 vs 音节数守护缝隙 | 同上 + `哈里烪斯`、`烪烪烪迪普西克` | 跨度不完整就放弃，不猜 |
| tidy 破坏缩进 | `def f():\n    return 1`、`if x:\n\treturn 1`、Python/YAML 三连 | 续行缩进与 Tab 全部保住（首行/结尾见 A9） |
| 繁体被静默转换 | `工作臺的识别`、`編譯通過了`、`這是一個測試`、`繁體中文不應該被轉換` | 全部原样 |

---

## 5. 有范围的阴性结果（我试过，但没能破坏）

**N1 并发/重入：未发现撕裂**（实测）
200 次并发听写 + 期间 20 次改写 `terms.json`（延迟 1 ms 的假 provider 让它们在途交错），断言每次输出都必须是"某一版词库的正确结果"：

```
200 次并发，异常 0 条（无撕裂、无空结果、无抛错）
```

机制上也说得通：`correct()` 是同步的，`correctorFor(...)` 的"构建 + 使用"在同一个同步块里（`index.js:291`），`built`（`:131-159`）只是缓存，不存在"A 在用、B 把它换掉"的窗口。**局限**：这条只覆盖同步纠正路径；`config.applyStyle` 若被传成 async 函数，`correct()` 会把 Promise 当文本返回（`lib/correct/index.js:549-555`）——插件自己传的是同步函数，所以插件路径不可达，标为**推断**。

**N2 缓存键：改动前确实会碰撞，改动后已验证修好**（实测 + 代码重建）
改动前 `key = ${mtimeMs}:${size}`。我把旧 `load()` 逐行重建成 `<tmp>/audit2/old-loader.mjs`（源码我在 18:40 读过，重建是忠实的），用"内容换成另一条词条、字节数相同、把 mtime 精确还原"（`cp -p`/`rsync -a`/`tar -x`/`git checkout` 的效果）复现：

```
修复前的键 (load#1): 1792147727760.9202:117 | 词条: ZzzAlpha
磁盘内容已是 ZzzBravo；mtimeMs 相同: true ; size 相同: true
修复前的键 (load#2): 1792147727760.9202:117 | 词条: ZzzAlpha   <-- 改动不生效
```

当前版本（`edd550c3`，内容当键）同样条件下会重载：

```
对照通过  N2 当前版本：mtime/size 相同但内容变了仍能重载  mtime 相同=true，读到 ZzzBravo
```

**注意**：我第一次写的 mtime 复现是**错的**（两个版本的词条对自身名字都是空操作，看起来"没碰撞"其实什么也没测到），重写后才拿到上面的结论；细节见 §7。

**N3 失败降级：fail-open 成立**（实测）
把 `lib/data/pinyin-table.txt` 删掉（模拟安装包缺文件），挂上真 `apply()`：

```
结果: "flcash 和 zzzprod"
是否保住原始听写: 是（fail-open）
日志: warn:[voice-personal] 纠错已跳过，返回原始识别结果：ENOENT: … pinyin-table.txt
```

抛错被 `index.js:296-300` 接住，返回原始转写，词库全部失效但听写不丢。**边界**：`voiceprint` 门禁的抛错**不在**这个 try 里（`:259-281`），那是有意的 fail-closed。

**N4 半截文件（编辑器正在写）**：`{"version":1,"terms":[{` → 沿用上一次可用词条，且只警告一次（`warnedFor` 去重生效）。

**N5 非字符串输入**：`null/undefined/42/{}/[]` 分别得到 `""/""/"42"/"[object Object]"/""`，不抛错（`lib/correct/index.js:511-513`）。

**N6 词库管线的健壮性**：4,000 组随机用户词条经 `mergeWithUserTerms → partitionTerms` 后，没有让引擎抛错、也没有让某条规范形在**内置词库**里被改写（唯一例外是 A6 的三类跨条目碰撞）。

---

## 6. 我怀疑但没能证实的

1. **`applyStyle` 走异步会污染输出**（§5 N1）：库 API 层面真实，插件路径不可达，标为推断。
2. **`Buffer.from(input.audio)` 在 `requireEnrolledSpeaker` 打开且 `audio` 非 Buffer 时抛错**（`index.js:272`）：这会让听写直接失败（不在 fail-open 覆盖范围内）。我没构造出真实调用方会传非 Buffer 的场景，**未复现**。
3. **两个 `terms.mjs` 进程同时写**会对固定名 `${full}.tmp` 竞争（`user-terms.js:136-138`），可能丢更新。我没实际并发跑两个 CLI，**未复现**。
4. **`style.json` 读一次就永久缓存**（`index.js:170-183`）：改了风格画像要重启才生效。README `:256` 已写"除词库外都要重启"，所以是**文档一致**的，我不算作缺陷，但它与"加词即时生效"的宣传并列时容易误解。
5. **`maskProtected` 的哨兵若出现在用户文本里会被 `?? ''` 删成空**（`lib/correct/index.js:88`）：需要转写结果里含 U+E000…U+E001，ASR 不可能产出，**未复现**，仅记录。
6. **`spacing: 'none'` 模式下，被遮罩的跨度会挡住空格删除**（哨兵既非 CJK 也非拉丁），造成同一句话里空格处理不一致。属观感问题，未列为缺陷。

---

## 7. 我自己的复现脚本写错的地方（诚实记录）

1. **第一版 mtime 复现是无效的**：我用 `AAAA`/`BBBB` 两条"规范拼写"验证缓存是否重载，而这两条对自身名字都是空操作 —— 无论用哪版词库，输出都是原文，看起来像"没有碰撞"。重写成 `ZzzAlpha`/`ZzzBravo` + 共同 `heard: zzzprod` 后，才在**重建的旧代码**上拿到真实的陈旧命中（改动后的当前代码本来就该重载）。
2. **第一版权限测试也是无效的**：我用 `FlClash`/`flcash` 检测"用户词库是否还在"，但这对映射**内置词库里本来就有**，所以用户词库被丢掉后输出照样是 `FlClash`，缺陷被掩盖。换成内置词库没有的 `ZzzAlpha`/`zzzprod` 后，`chmod 000` 造成的静默失忆才显形。
3. **fail-open 的对照组断言写错了**：我的脚本对完整仓库打印了"是否保住了原始听写: 否 —— 丢了！"，那只是因为对照组**正确地做了纠正**（`flcash -> FlClash`），文本理应改变。结论来自删掉拼音表的实验组，对照组那句话是我脚本的 bug，与产品无关。
4. **第一版并发测试证明不了它想证明的事**：120 个任务全部在改文件之后才读词库（纠正发生在 provider promise resolve 之后，而 `writeFileSync` 是同步的），所以"输出全是新词库"并不说明没有撕裂。改成延迟 provider + 断言"输出必须落在合法集合内"才是有效测试。
5. **词条模糊测试一开始把"一次性变长"当成"增长"**：`Cocos Creator -> Claude Creator` 这种一次性改写被我算成增长，出了 228 个假阳性。真正的信号是**规范形被自己改写**（1071 次）和**跨轮单调增长**，后来用"A→A→A"这种稳定性判据重跑。
6. **`fuzz-fuzzy.mjs` 的计数分母**最初把长度 < 5 的变体也算进去了（7148），修正后是 6748。报告里用的是 6748。

---

## 8. 为什么 118 + 22 + 38 + 70 条测试没抓到（覆盖缺口）

不是"测试写得差"，而是**输入分布**恰好绕开了这些形状：

1. **`audit.mjs` 的 4,000 条对抗串**由固定原子拼成（`cocos creator`/`工作台`/`哈里斯`/`🙂`/`v1.2`/`。`…），**没有反引号、没有路径、没有下划线标识符、没有 `pairs`/用户词条这个维度**。所以 A1/A2/A3/A4 一个都碰不到。
2. **词典扫描是"单词逐个喂"**：210,626 个单词里当然不会有 `agent_id`、`test harness is broken`、`打开/Users/…`。A3/A4 需要**句子语境**才出现。
3. **冻结语料的保护跨度用例都带空格**：`prot-cd-path: 'cd ~/projects/harness.git'` 有空格 → 被保护；没有任何"中文紧贴路径"的用例（全部 70 条里 `/tmp` 出现 0 次）。唯一一条反引号用例 `prot-inline-code: '\`github\`'` 内部恰好没有保护跨度 —— 正是 A1 矩阵里唯一安全的那一格。
4. **下划线只出现一次**：`claude_local 和 codex_local`（输入与期望各一处），而它们的期望**就是被改写**（`Claude_local`/`Codex_local`）。规则的一般化后果（`agent_id`、`harness_test`、`flcash_config`）无人覆盖。
5. **`user-terms.test.mjs` 的 22 项**覆盖了冲突丢弃、损坏文件、CLI 往返 —— 但**没有**：`pairs`、读取权限错误、跨条目碰撞（token/拼音键/大小写）、配置值写错、并发改库。
6. **`eval.mjs` 的幂等检查**只在 70 条语料输入上跑 `correct`，而 A2 的增长需要 **`pairs` 配置**这个额外维度。
7. **`checkTerms` 只被当作"用户词条过滤器"测试**，从没被要求回答"合并后的语义视图是否自洽"；`pairs` 与内置 `TERMS` 都在它的视野之外。

**建议新增的回归用例（按发现编号）**：`A1` 反引号 × {邮箱, 版本, flag, URL+空格} 矩阵；`A2` pairs 炸弹（含"pairs.heard = 某规范拼写"）必须被拒绝或至少报警 + `check` 退出码非 0；`A3` `中文+p/a/t/h`、`中文+~/…`；`A4` `test harness`/`raise an issue`/`agent_id`/`harness_test`/`Token 过期了`；`A5` 断言 fuzzy 开关至少能改回一个真实拼错（否则删掉开关）；`A6` 三类跨条目碰撞各一条；`A7` chmod 000 后仍应使用上一次可用词库；`A8` `spacing: Space` 与 `requireEnrolledSpeaker: "False"`；`A9` `print("a  b")` 与首行缩进。

---

## 9. 如果只修三条

1. **A1**：`restore` 迭代到不动点 + 反引号矩阵测试。它是唯一一类"保护机制自己损坏文本、且事后不留痕迹（`changes` 为空）"的缺陷。
2. **A2**：`pairs` 要么进同一套守卫，要么删掉。它复活了项目历史上最严重的那类缺陷（无界增长），而 CLI 还在报 ✓。
3. **A3 + A6**：保护跨度与冲突检测的边界补全（中文紧贴路径；跨条目 token/拼音键/fold 碰撞）。这两条都属于"用户看不见的静默改写"。

---

## 附录 A：一键复现脚本

完整的统一验证脚本（35 条缺陷断言 + 15 条对照/负结果断言）在运行环境中位于
`<tmp>/audit2/verify/verify-all.mjs`，可直接对任意修订重跑：

```bash
node <tmp>/audit2/verify/verify-all.mjs /Users/me/Downloads/工作台/dsh-voice-personal
# 输出末尾：===== 缺陷类断言复现 35 / 40；对照与负结果符合预期 15 / 15 =====
```

建议把它收编成 `test/audit-2-verify.mjs`（去掉对 `/usr/share/dict/words` 的硬依赖后可进 CI）。脚本内容见随本报告附出的运行记录；最小复现见附录 B。

## 附录 B：最小复现文件清单（均只读仓库、临时文件在 /tmp）

| 文件 | 对应发现 |
| --- | --- |
| `<tmp>/audit2/repro/f1.mjs` | A1 遮罩/还原嵌套 |
| `<tmp>/audit2/repro/f2.mjs` | A2 pairs 无校验（增长 + 覆盖规范形） |
| `<tmp>/audit2/repro/f3.mjs` | A3 中文紧贴路径 |
| `<tmp>/audit2/repro/f4.mjs` | A4 普通词/标识符被改写 |
| `<tmp>/audit2/repro/f5.mjs` | A5 fuzzy 死开关 |
| `<tmp>/audit2/repro/f6.mjs` | A6 跨条目冲突 |
| `<tmp>/audit2/repro/f7.mjs` | A7 读失败丢 lastGood |
| `<tmp>/audit2/repro/f8.mjs` | A8 配置值类型/枚举 |
| `<tmp>/audit2/repro/f9.mjs` | A9 tidy |
| `<tmp>/audit2/repro/f10.mjs` | A10 平方复杂度 |
| `<tmp>/audit2/repro/f11.mjs` | A11 changes.at 单位 |
| `<tmp>/audit2/verify/verify-all.mjs` | 全部 + 阴性结果 + 历史回归 |
| `<tmp>/audit2/old-loader.mjs` + `<tmp>/audit2/old-mtime-test.mjs` | N2 改动前缓存键碰撞（旧代码忠实重建） |
| `<tmp>/audit2/e2e/harness.mjs`、`t1`–`t8*.mjs` | 端到端（真 `apply()`/`transcribe()`）用例 |

> 本报告未改动仓库中的任何既有文件；`docs/audit-2.md` 是唯一新增文件。

## 附录 C：最小复现文件源码（把 `<仓库根>` 换成 `/Users/me/Downloads/工作台/dsh-voice-personal`）

### `repro/f1.mjs`

```js
import { createCorrector } from '<仓库根>/lib/correct/index.js';
const c = createCorrector();
const vis = (s) => [...s].map((ch) => { const p = ch.codePointAt(0); return p >= 0xE000 && p <= 0xF8FF ? '<U+E000/U+E001 私用区>' : ch; }).join('');
for (const t of ['这是 `v2.0.1` 版本', '发给 `x@y.com` 就行', '用 `--force` 参数', 'run `npm i -g foo --verbose` now', '看 `https://a.b/c 说明` 链接']) {
  const out = c.correct(t).text;
  console.log(/[\uE000-\uF8FF]/.test(out) ? '泄漏' : '正常', JSON.stringify(t), '->', JSON.stringify(vis(out)));
}
```

### `repro/f2.mjs`

```js
import { createCorrector, TERMS } from '<仓库根>/lib/correct/index.js';
const bomb = createCorrector({ terms: TERMS, pairs: [{ heard: 'cocos', say: 'Cocos Creator' }] });
let s = 'Cocos Creator';
console.log('规范拼写:', JSON.stringify(s), '-> 第一遍:', JSON.stringify(bomb.correct(s).text));
for (let i = 0; i < 4; i++) { s = bomb.correct(s).text; console.log(`第 ${i + 1} 遍: len=${s.length} ${JSON.stringify(s)}`); }

// 追加：pairs 的 heard 命中别人的规范拼写时，会直接改掉那个词
const { createCorrector: cc2, TERMS: T2 } = await import('<仓库根>/lib/correct/index.js');
const bomb2 = cc2({ terms: T2, pairs: [{ heard: 'harness', say: 'ZzzOther' }] });
console.log('pairs:[{heard:"harness",say:"ZzzOther"}] 下，"the harness is here" ->', JSON.stringify(bomb2.correct('the harness is here').text));
console.log('pairs:[{heard:"哈里斯",say:"ZzzOther"}] 下，内置音译条目被顶掉：');
const bomb3 = cc2({ terms: T2, pairs: [{ heard: '哈里斯', say: 'ZzzOther' }] });
console.log('  "哈里斯" ->', JSON.stringify(bomb3.correct('哈里斯').text));
```

### `repro/f3.mjs`

```js
import { createCorrector } from '<仓库根>/lib/correct/index.js';
const c = createCorrector();
for (const t of ['改~/.dsh/profiles/desktop/cordis.patch.yml 这个文件', '打开/Users/me/flcash 看日志', '改 ~/.dsh/profiles/desktop/cordis.patch.yml 这个文件', '打开 /Users/me/flcash 看日志']) {
  console.log(JSON.stringify(t), '->', JSON.stringify(c.correct(t).text));
}
```

### `repro/f4.mjs`

```js
import fs from 'node:fs';
import { createCorrector } from '<仓库根>/lib/correct/index.js';
const c = createCorrector();
for (const t of ['the test harness is broken', 'raise an issue', 'Token 过期了', '把 agent_id 传进去', 'harness_test 挂了', 'my_workbody_key']) {
  console.log(JSON.stringify(t), '->', JSON.stringify(c.correct(t).text));
}
const w = fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n').filter((x) => /^[a-z]{3,}$/.test(x));
const hits = w.filter((x) => c.correct(x).text !== x);
console.log(`词典被改写: ${hits.length}/${w.length} -> ${hits.join(', ')}`);
```

### `repro/f5.mjs`

```js
import { createCorrector, TERMS } from '<仓库根>/lib/correct/index.js';
const refs = TERMS.map((t) => t.say).filter((x) => !/\s/.test(x) && x.length >= 5);
console.log('fuzzy 参考词:', refs.join(', '), '  <-- DeepSeek 出现', refs.filter((r) => r === 'DeepSeek').length, '次');
const A = 'abcdefghijklmnopqrstuvwxyz'; const vs = new Set();
for (const w of refs) { const b = w.toLowerCase();
  for (let i = 0; i < b.length; i++) vs.add(b.slice(0, i) + b.slice(i + 1));
  for (let i = 0; i < b.length - 1; i++) vs.add(b.slice(0, i) + b[i + 1] + b[i] + b.slice(i + 2));
  for (let i = 0; i < b.length; i++) for (const ch of A) vs.add(b.slice(0, i) + ch + b.slice(i + 1));
  for (let i = 0; i <= b.length; i++) for (const ch of A) vs.add(b.slice(0, i) + ch + b.slice(i)); }
for (const fuzzyTerms of [false, true]) {
  const c = createCorrector({ options: { fuzzyTerms } });
  const fixed = [...vs].filter((v) => v.length >= 5 && refs.includes(c.correct(v).text) && c.correct(v).text.toLowerCase() !== v);
  console.log(`fuzzyTerms=${fuzzyTerms}: ${vs.size} 个 1 编辑变体中被改回 ${fixed.length} 个: ${fixed.join(', ')}`);
}
```

### `repro/f6.mjs`

```js
import { createCorrector, TERMS, partitionTerms, normalizeTerms, mergeTerms } from '<仓库根>/lib/correct/index.js';
import { mergeWithUserTerms } from '<仓库根>/lib/correct/user-terms.js';
const run = (user) => {
  const merged = mergeWithUserTerms(TERMS, mergeTerms(normalizeTerms(user)));
  const checked = partitionTerms(merged.terms);
  const errs = checked.issues.filter((i) => i.severity === 'error');
  const c = createCorrector({ terms: checked.terms });
  return { errs: errs.length, c };
};
for (const [user, probe] of [
  [[{ say: 'Cursor', heard: ['creator'] }], 'Cocos Creator'],
  [[{ say: 'Foo', heard: ['哈利斯'] }], '哈利斯'],
  [[{ say: 'dsh', heard: [] }], 'dsh'],
  [[{ say: 'Foo', heard: ['哈利斯'] }, { say: 'Bar', heard: ['哈里斯'] }], '哈里斯'],
]) {
  const { errs, c } = run(user);
  console.log(`用户词条 ${JSON.stringify(user)}  errors=${errs}  ${probe} -> ${JSON.stringify(c.correct(probe).text)}`);
}
```

### `repro/f7.mjs`

```js
import fs from 'node:fs'; import path from 'node:path';
import { createUserTermsLoader } from '<仓库根>/lib/correct/user-terms.js';
const dir = '<tmp>/audit2/repro/perm'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
const f = path.join(dir, 'terms.json');
fs.writeFileSync(f, JSON.stringify({ version: 1, terms: [{ say: 'ZzzAlpha', heard: ['zzzprod'] }] }));
const l = createUserTermsLoader({ dir, logger: { warn: (m) => console.log('  warn:', m) } });
console.log('第一次 load():', l.load().terms.length, '条');
fs.chmodSync(f, 0o000);
const r = l.load();
console.log('chmod 000 后 load():', r.terms.length, '条  error=', JSON.stringify(r.error), '  <-- 内存里明明还有 1 条可用');
fs.chmodSync(f, 0o644);
fs.writeFileSync(f, '{"version":1,"terms":[{');
console.log('对照：JSON 损坏时 load():', l.load().terms.length, '条（沿用上一次可用值）');
```

### `repro/f8.mjs`

```js
import { createCorrector, DEFAULTS } from '<仓库根>/lib/correct/index.js';
for (const spacing of ['space', 'none', 'preserve', 'Space', 'spaces', 'true']) {
  const c = createCorrector({ options: { ...DEFAULTS, spacing } });
  console.log(`spacing=${JSON.stringify(spacing).padEnd(11)} -> ${JSON.stringify(c.correct('中文 Hello 中文').text)}`);
}
```

### `repro/f9.mjs`

```js
import { createCorrector, DEFAULTS } from '<仓库根>/lib/correct/index.js';
const c = createCorrector();
for (const t of ['print("a  b")', '{"k":  "v  v"}', '| a   | b   |', '    x = 1\ny = 2', 'def f():\n    return 1\n']) {
  console.log(JSON.stringify(t), '->', JSON.stringify(c.correct(t).text));
}
const p = createCorrector({ options: { ...DEFAULTS, spacing: 'preserve' } });
console.log('spacing=preserve 时 print("a  b") ->', JSON.stringify(p.correct('print("a  b")').text), '  <-- tidy 关不掉');
```

### `repro/f10.mjs`

```js
import { createCorrector } from '<仓库根>/lib/correct/index.js';
const c = createCorrector();
for (const n of [10000, 30000, 50000]) {
  const t0 = process.hrtime.bigint(); c.correct('a'.repeat(n));
  console.log(`${n} 个 a: ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)} ms`);
}
```

### `repro/f11.mjs`

```js
import { createCorrector } from '<仓库根>/lib/correct/index.js';
const c = createCorrector();
const t = '😀 哈里斯 说的';
const ch = c.correct(t).changes.find((x) => x.type === 'cross-script');
console.log('原文:', JSON.stringify(t), ' changes.at =', ch.at, ' 但 UTF-16 下标应为 3 ->', JSON.stringify(t.slice(ch.at, ch.at + 3)));
```

### `old-loader.mjs`（改动前 `load()` 的忠实重建，用于 N2）

```js
// 忠实重建 18:44 之前的 load()（键 = `${stat.mtimeMs}:${stat.size}`），用于验证「改前确实会碰撞」
import fs from 'node:fs';
import path from 'node:path';
import { normalizeTerms, mergeTerms, partitionTerms } from '<仓库根>/lib/correct/index.js';
export function oldLoader({ dir, file = 'terms.json' }) {
  const full = path.join(dir, file);
  let lastGood = { terms: [], pairs: [] }; let cache = null; let warnedFor = null;
  function read() {
    const raw = fs.readFileSync(full, 'utf8');
    const doc = JSON.parse(raw);
    const normalized = mergeTerms(normalizeTerms(doc.terms ?? []));
    const { terms, issues, dropped } = partitionTerms(normalized);
    return { terms, pairs: doc.pairs ?? [], issues, dropped };
  }
  return { path: full, load() {
    let stat; try { stat = fs.statSync(full); } catch { return { terms: [], pairs: [], key: 'absent' }; }
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (cache && cache.key === key) return cache.result;
    try {
      const { terms, pairs, issues, dropped } = read();
      lastGood = { terms, pairs };
      const result = { terms, pairs, issues, dropped, key, error: null };
      cache = { key, result }; warnedFor = null; return result;
    } catch (error) {
      if (warnedFor !== key) warnedFor = key;
      const result = { terms: lastGood.terms, pairs: lastGood.pairs, key, error: String(error?.message) };
      cache = { key, result }; return result;
    }
  } };
}
```

> 运行记录（实际输出）见本报告各发现的「实际输出」段；统一脚本 `verify-all.mjs` 的输出存于 `<tmp>/audit2/verify-output.txt`（快照）与 `<tmp>/audit2/verify-live.txt`（当前树），两者除打印的仓库路径外完全一致。
