# 更新日志

本文件记录面向使用者的变化。内部取舍与失败记录见 [docs/](docs/)。

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
