# 对抗审计 —— 九类缺陷：怎么发现的，怎么修的

**中文** | [English](ADVERSARIAL.en.md)

针对纠错引擎跑了一次独立的对抗审计，只有一条任务：**破坏「绝不破坏已经正确的文本」这条性质**。它成功了九次。本文逐条记录缺陷和复现器——失败不公开，修复就不可信。

The project's own suite passed 59/59 at the time. None of the nine were covered.

## D1 —— 同音 pass 改写了正常中文（严重）

Toneless-pinyin matching over 2-syllable CJK spans matched every homophone of every
glossary pair.

```
人物关系很复杂   → 任务关系很复杂     (rènwù)
这是一部好电影   → 这是异步好电影     (yībù)
信条很重要       → 心跳很重要         (xìntiáo)
便衣警察         → 编译警察           (biànyī)
接点电阻         → 接口电阻           (jiēdiǎn)
配制溶液         → 配置溶液           (pèizhì)
变异病毒         → 编译病毒           (biànyì)
一步一步来       → 异步异步来         (yībù, twice)
```

碰撞面（枚举碰撞空间算得）：12 组两音节词条共 **160,454 个不同的两字 CJK 组合**被改写。

**修复：** 同音 pass 整体删除。保留跨语种音译（中文误听拉丁术语），带 [DESIGN.md](DESIGN.md) §2 的三条守护。`PAIRS` 默认为空。

## D2 —— `heard` 变体改写了正确英文

词库把真实单词列为误听：`grade` 挂在 Gradle 下、`harris` 挂在 Harness 下、`cloud` 挂在 Claude 下。

```
my grade is A                 → my Gradle is A
the cloud is down             → the Claude is down
harris county                 → Harness county
upgrade to the new version    → Gradle to the new version
```

**修复：** 本身是正常词的形式不能进 `heard` 清单。词库词条只放产品拼写（`flcash`、`workbody`）或大小写归一。

## D3 —— 模糊拉丁匹配损坏了 97 个词典词

Scanning 210,604 dictionary words found 97 rewritten with a changed content fingerprint:
`sadness` → `Harness` (60 words hit Harness alone), `cocoa` → `Cocos Creator`, `hub` →
`GitHub`.

根因：(a) 误听拼写被当作模糊*参照*建索引，成为额外的吸引子；(b) 只有一个参照得分时，第二名的 margin 是和 0 比，任何单个弱匹配都无条件通过。

**修复：** 模糊参照只放规范形式；margin 要求真实存在第二名；模糊匹配改为可选且默认关。修复后词典扫描：开与关都是 **0 / 198,631** 个词被损坏。

## D4 —— 文件扩展名被吞

`LATIN_RUN` 把 `.` 当作 token 的一部分，所以 `harness.git` 是一个 token：

```
harness.git              → Harness
cd ~/projects/harness.git → cd ~/projects/Harness
grade.js                 → Gradle
```

**修复：** 所有 pass 之前先做保护跨度遮罩（URL、路径、邮箱、版本号、CLI 参数、行内代码、已知扩展名）。一个机制覆盖所有 pass。

## D5 —— 非幂等，无界增长

The phrase pass emitted `Cocos Creator`; the single-token pass then expanded the `Cocos`
inside its own output:

```
cocos creator → Cocos Creator Creator → Cocos Creator Creator Creator → …
```

Structured fuzzing (4,000 mixed-atom strings) found **705** non-idempotent cases.

**修复：** 规范形式永不二次展开；规范形式的自身前缀不进误听清单。修复后 fuzz：0 / 4,000。

## D6 —— 表缺字导致跨度坍缩

873 个 CJK 字符没有拼音条目（大部分在扩展 A 区）。`toPinyinArray` 静默跳过它们，4 字跨度能产出 3 音节键：

```
克㐂劳德 → Claude      哈㐂里斯 → Harness      普㐂朗普特 → prompt
```

**修复：** 只有整段每个字都有读音时才允许匹配（`readings.length === span.length`）。

## D7 —— 守护缝隙：字数 vs 音节数

新的 ≥3 字守护数的是字符，索引键数的是音节。含表缺字的 3 字 `heard` 通过了守护，却索引出 2 音节键——等于把 D1 对 `哈里` → `Harness` 重新上了膛。

**修复：** D6 的完整性守护让字数与音节数一致，从结构上封死这条缝，而不是再加一个计数。

## D8 —— `tidy()` 破坏缩进

折叠 2 个以上连续空格时把行首空白也包含了：

```
def foo():          →      def foo():
    if x:           →       if x:
        return 1    →        return 1
```

**修复：** 逐行原样保留行首空白，只折叠内部连续段。测试断言 Python 和 YAML 块逐字节不变。

## D9 —— 繁体被静默转换

匹配走拼音，所以 `工作臺` 命中了 `工作台` 的键被改写成简体。静默的文字体系转换是用户没有要求的语义变更。

**修复：** 随 D1 的同音 pass 一起移除。繁体现在原样保留，测试断言了这一点。

## 审计确认为可靠的部分

有边界的阴性结果，记录下来让「可靠」这个词有具体范围：

- **拼音表读音：** 全部 26,711 条与 pypinyin 0.55.0 对照——允许系统性的 u/ü 合并后，真正错误的读音为零。多音字抽查（行→xing、长→zhang、重→zhong、率→lu、薄→bao、削→xue）。
- **路径/URL/代码上的空格：** `~/Downloads/…`、`https://…`、`127.0.0.1:19387`、`C++`、`v1.2`、`user@example.com` —— 全部未被改动。
- **贪心最长匹配：** 没有发现更长跨度击败更优短跨度的案例。
- **Unicode 边界：** emoji、ZWJ 家族、组合记号、代理对、6 万字输入——无损坏、无病态耗时。

## 方法说明

- The audit pinned a frozen snapshot of the module before reporting, then re-confirmed
  every reproducer against the live module — the target was being edited mid-verification.
- Two of the auditor's own initial claims were wrong (`率=lu` judged a bad reading; the
  guard judged comment-only) and were retracted after re-reading source. A verifier that
  hides its own errors is worthless.
- 所有复现器保留在 `test/correct.test.mjs` 的第三至九节，每个修复都是可执行的证据，不是口头声明。
