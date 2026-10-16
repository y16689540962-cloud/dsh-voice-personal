# 更新日志

本文件记录面向使用者的变化。内部取舍与失败记录见 [docs/](docs/)。

## 0.1.3 — 2026-10-17

### 修复：复现命令里的本机用户名进了 0.1.1 的 npm 包

`docs/collision-report.md` 的复现步骤写的是 `/Users/<用户名>/...` 这种绝对路径，
而 `files` 白名单里有 `docs/`，于是同一个字符串同时出现在仓库和 0.1.1 的 tarball 里。
`0.1.0` 与 `0.0.0-stage` 不受影响——该文件是 0.1.1 之前那次文档提交才加的。

处理：路径改成 `/Users/me/`（与 `docs/audit-2.md` 已有的脱敏口径一致）；
仓库历史用 git-filter-repo 重写，0.1.1 从 npm 撤回，本版本重发。

教训记在这里：**脱敏检查要扫 `files` 白名单里的一切**，
`docs/` 一旦入选，文档里的绝对路径就是包的一部分，发布脚本不会替你看这一层。

## 0.1.3 — 2026-10-17

### 修复：`@路径` 与全角标点后的路径被改写

`@/Users/me/flcash/log.txt` 会变成 `@/Users/me/FlClash/log.txt` —— 路径里的目录名被当成术语归一了大小写。`工作目录：/Users/me/flcash`（中文全角冒号后紧跟路径）同样中招。

根因是路径保护规则要求一个「前导分隔符」，而那个字符类永远不可能穷举：`@`、中文、全角标点都不在里面。改成**负向先行断言**——路径开始 = `/` 或 `~` 前面不是字母数字。这样空格、引号、括号、`@`、中文、全角标点全覆盖，而 `10/16` 这类分数仍然安全（`/` 前面是数字）。

顺带修正了同类的一个判断：`@flcash` 是 @提及 不是路径，仍然会被正常纠正。

### 修复：学习流水线把注入内容当成「用户说的话」

`learn.mjs` 原来只在消息**开头**匹配样板并整条丢弃，于是三类注入直接进了画像：
`<goal_round>` 续跑提示（→ goal / objective / round）、`Current runtime context` 快照（→ justin / Users / Downloads）、`Instructions from: AGENTS.md`（→ policy / workspace / available / claim）。

这三种都是**追加在用户消息尾部**且**多段**的，所以只剥掉标题行会把正文整个留下。现在改为**剥离注入块再判断剩下什么**——不能整条丢，因为那句话里有用户的真实听写。

同时：
- 词频统计前先遮罩路径/URL/版本/代码，目录名不再变成「你的词汇」；
- 超过 `--max-chars`（默认 600，取自实测长度分布的双峰间隙）的消息不算本人手写；
- **未知参数直接报错**。这条来自一次真实事故：`learn.mjs --bad-arg` 本意是试参数校验，但未知参数被忽略、`--dry-run` 不在其中，于是它跑了完整流程并覆盖了上一份画像；
- 写入前打印将覆盖的画像并留一份 `.prev`。

### 新增测试

`test/learn-filter.test.mjs`（8 例）驱动真实脚本跑合成语料；`test/audit2-regressions.test.mjs` 增加 `@路径` 用例。

## 0.1.1 — 2026-10-16

### 新增：词库不用改源码、不用重启

你的词条现在存在 **`~/.dsh/voice-personal/terms.json`**，插件每次听写前检查一次文件内容，改了下次说话就生效。

这不是锦上添花，是修一个真实的坑：插件通过 `pnpm file:` 安装，源码和安装副本之间是**硬链接**，多数编辑器保存时会断掉链接——改了源码，DSH 加载的仍是旧的，而测试读源码所以**全部通过**。这个坑在本项目里真的发生过一次（见 [docs/PITFALLS.md](docs/PITFALLS.md)）。

配一个命令行工具：

```bash
node scripts/terms.mjs add FlClash --heard flcash
node scripts/terms.mjs list / check / export / import / candidates / apply
```

写进去之前会校验。**会改坏正确文本的条目被拒绝写入并说明原因**，例如把 `cloud` 声明成 `Claude` 的误听形态（那会改掉每一处真实的 `Cloud`）。听写时若文件损坏（正在编辑、JSON 写坏），插件沿用上一次可用的词条并返回原文，不会丢这次听写。

### 修复：冻结语料找到的三个识别缺口

新增 70 条冻结回归语料（`test/corpus/regression.json`）和 A/B 评测（`test/eval.mjs`）。第一次跑就找到三处真实的漏改：

| 输入 | 之前 | 现在 |
| --- | --- | --- |
| `你给我上gHub搜一下` | `gHub`（只插了空格） | `GitHub` |
| `反代到deep seek harness` | `deep seek`（半对） | `DeepSeek Harness` |
| `cocos creator 项目` | **完全没改** | `Cocos Creator 项目` |

第三条是引擎缺陷：多词术语的短语匹配用**折叠比较**判断「是否已经规范」，于是把全小写当成了已规范。改成字节相等比较。引擎版本 `CORRECT_VERSION` 2 → 3。

修复后：70/70 通过，且 210,604 个英文词典词扫描、4,000 条幂等 fuzz、20 个常见词碰撞检查全部为 0。

### 引擎：词条卫生检查移入引擎

`normalizeTerms` / `mergeTerms` / `checkTerms` / `validateTerms` / `partitionTerms` 现在由引擎提供，插件与独立包共用一份，不再各写各的。

插件用的是 `partitionTerms`：**只丢弃出问题的那条误听形态，不丢弃整个条目，也不丢弃文件里其它条目**。用户手写的文件不该让插件崩溃，也不该因为一行写错就失去另外四十行。

### 文档

- [docs/NOT-DOING.md](docs/NOT-DOING.md) —— 明确不做的事及依据。第一条尤其值得读：**转写前偏置不做**，因为 sherpa-onnx 官方文档明确 hotwords 只支持 transducer 模型，SenseVoice 不支持，而且这个模型根本没有「提示词」这个概念。
- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) —— 拼音表（pinyin-data，MIT）与声纹模型（3D-Speaker / sherpa-onnx，Apache-2.0）的完整归属，含许可证原文。
- README 的加词章节改写；`docs/PITFALLS.md` 增加硬链接这一条。

### 独立包 `asr-personal-dictionary` 0.1.0

同一套纠错层现在单独发布，零依赖、离线，供别的听写工具嵌入：

```bash
npm install asr-personal-dictionary
```

它的 `dist/` 由构建脚本从本仓库的 `lib/correct/` 生成——**只有一份源**。构建会拒绝发布引用了未打包模块的引擎，并在写完之后真的 import 一次、跑一次真实纠正。词库不复制：上游词库是某个人的私人词汇，发出来既泄隐私对别人也没用，所以生成一份空的，术语全部由调用方提供。

---

## 0.1.0 — 2026-10-15

首个发布。

- 包装 DSH 内置的 `sensevoice-local` provider，在文本层做后处理，不替换识别引擎
- 个人词库精确匹配（大小写折叠）+ 跨语种音译（`哈里斯` → `Harness`）
- 保护跨度：URL、路径、邮箱、版本号、CLI 参数、行内代码、常见扩展名
- 表达习惯画像：从你自己的会话历史里确定性统计，不调模型
- 可选声纹校验（默认关）
- 对抗审计九类缺陷的复现器与修复，见 [docs/ADVERSARIAL.md](docs/ADVERSARIAL.md)
