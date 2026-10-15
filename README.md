# dsh-voice-personal

**中文** | [English](README.en.md)

**本地语音识别的后处理层 —— 个人词库、跨语种音译、从你会话历史里学出来的表达习惯。**

把中文听写打进 DeepSeek Harness 时，失败方式是固定的三种：产品名和项目术语识别错（`flcash` 而不是 `FlClash`）、中英混说的句子在交界处崩坏、口水词在每一条消息里烧 token。这个插件修这三件事，全部在本地完成，不碰识别引擎本身。

它**不替换** DSH 内置的 SenseVoice provider，而是包装它——模型准备、原生 worker、VAD 分段、队列、超时仍由内置 provider 负责，这一层只处理吐出来的文本。这条边界是刻意设计的，也是插件能跨 harness 版本存活的原因。

```
麦克风 → personal-local → sensevoice-local（本地 ONNX）→ 词库 → 风格 → 输入框
```

全部本地运行。不联网、不用云端 ASR、不落盘音频——录音按设计是瞬时的，从不写进磁盘。

---

## 值得先读的部分：为什么它**不做**同音纠正

这个项目上线过中文同音改写器，然后把它移除了。如果你在为中文评估 ASR 后处理方案，这个决定比功能列表有用。

想法看起来很自然：把个人词库按无调拼音建索引，术语的每一种误听都自动归位——`工作太`、`公作台`、`工作台` 共享同一个键 `gongzuotai`，一条规范词条教会引擎这个词所有错误写法。

它在数学上不成立，原因是算术而不是调参。两音节拼音键会命中**所有**同音词，而普通话同音词密度极高：

| 拼音 | 这些全是对的词 |
|---|---|
| rènwù | 人物 / 任务 |
| yībù | 一部 / 异步 |
| xìntiáo | 信条 / 心跳 |
| biànyī | 便衣 / 编译 |
| jiēdiǎn | 接点 / 接口 |
| pèizhì | 配制 / 配置 |

实际后果：`人物关系很复杂` 被改成 `任务关系很复杂`，`这是一部好电影` 被改成 `这是异步好电影`。上线过的 12 组两音节词条，碰撞面是 **160,454 个不同的两字组合**——等于整个常用字表。任何阈值都修不了，因为缺失的信息是上下文，而拼音里没有上下文。

活下来的是更窄、可验证的子集：**跨语种条目**修「中文误听拉丁术语」（`哈里斯` → `Harness`），要求 ≥3 音节、整段读音完整、拼音键完全匹配。`哈里王子` 和 `哈里发` 不会被动——裸 `哈里`（hālǐ）同时也是普通词。

完整推导（包括发现这个问题的对抗验证过程）在 [docs/DESIGN.md](docs/DESIGN.md)。

---

## 它实际做什么

**个人词库** —— 大小写折叠后精确匹配，词条从你会话历史里挖出来。仓库自带的词库是示例集，你的会不一样。

```
flcash → FlClash      workbody → WorkBuddy      哈里斯 → Harness
gHub → GitHub         toptop → TapTap           deep seek → DeepSeek
```

**中英混说规范化** —— 中英之间的空格跟随从你语料学到的习惯（技术中文写作者 85–87% 想要空格；画像测的是你的比例，不是猜的）。保护跨度——URL、文件路径、邮箱、版本号、CLI 参数、行内代码——在任何改写之前先被遮罩，所以路径里的 `harness.git` 完好无损。

**口水词清理，保守路线** —— 画像从**你自己的**语料学出口水词（作者的实测：`呃 ×11, 然后 ×12, 那个 ×8`），只在安全位置删除：独立成词、或后接标点。粘着实词的语气词（`唉声叹气`）保留，因为字符级上下文分不清语气词和词素，对抗验证证明了这点很重要。删除走画像白名单——文本永远不会被「通用清单」乱清理。

**风格画像，不是重写** —— 大小写投票、空格比例、标点习惯，全部是对你自己历史的确定性统计。不调 LLM、不联网、同语料可复现。

**声纹校验（可选，默认关）** —— sherpa-onnx 的 192 维说话人嵌入，用你自己的录音注册。默认关，因为目标是转写准确率；开启后 fail-closed，无法归因的录音一律拒绝。随包的阈值没有针对任何具体声音标定过——先注册再实测，不要盲信。

---

## 安装

需要已安装并能运行的 DeepSeek Harness 桌面版。

```bash
git clone https://github.com/y16689540962-cloud/dsh-voice-personal.git
cd dsh-voice-personal

DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add "file:$PWD"
```

重启 Harness。卸载是 `plugin remove dsh-voice-personal`——被包装的 provider 保留自己的 id，其他什么都不动。

从你的会话历史构建自己的词库：

```bash
node scripts/learn.mjs --dry-run   # 预览挖到什么，不写文件
node scripts/learn.mjs             # 写入 ~/.dsh/voice-personal/style.json
```

注册声纹：

```bash
node scripts/record.mjs --out /tmp/sample.wav --seconds 12
node scripts/enroll.mjs --name me --audio /tmp/sample.wav --check /tmp/sample2.wav
```

---

## 验证

```bash
node test/correct.test.mjs        # 118 项：真实误听被修正，正确文本不动
node lib/style/self-test.js       # 47 项：删除守护、幂等、画像边界
node lib/voiceprint/selftest.mjs  # 38 项：存储、WAV 契约、原子持久化
```

测试断言两条性质，顺序固定：

1. **绝不破坏已经正确的文本。** 漏改一次的代价是用户手动补一个词；误改一次是用户说的话被悄悄改变了。词库里每条 guard 都是一句被旧版本损坏过的真实句子。
2. 修正真实历史里观察到的误听。

纠正测试的第三至第九节，是对抗审计在一个旧版本上发现的九类缺陷的复现用例——同音越界、词典词损坏、非幂等增长、缩进破坏、表缺字导致的跨度坍缩。它们作为可执行证据保留，证明那些回归不会回来。[docs/ADVERSARIAL.md](docs/ADVERSARIAL.md) 逐条记录。

---

## DSH 插件表面的踩坑笔记

花掉真实调试时间的事，写下来因为别处搜不到：

- **`sherpa.compute(stream)` 在 Electron 下抛 `External buffers are not allowed`**。sherpa-onnx-node 1.13.8 默认零拷贝外部缓冲，Electron 的 V8 禁止。显式传 `false`。普通 Node 下看不到。
- **profile 安装的 bundle 解析不到 `sherpa-onnx-node`** —— profile 的 node_modules 只有 pnpm 装进去的东西。要从安装目录解析：`process.resourcesPath` + `createRequire`。内置 sensevoice provider 没这个坑，因为它就在安装里。
- **`new URL(import.meta.url).pathname` 保留百分号编码** —— 任何非 ASCII 安装路径下直接失效。用 `fileURLToPath`。
- **Electron 进程不带 `$DSH_HOME`** —— 从这个变量解析数据路径的插件会悄悄落回自己的安装目录。这条作为 bug 发布过：严格声纹门禁因此在每次听写上 fail-closed，直到被发现。应回退到 `~/.dsh`。
- **会话日志是多帧 zstd**。一次 `zstdDecompressSync` 只返回第一帧，静默丢掉整段对话。要逐帧走。
- **ffmpeg 默认 WAV 输出不是 canonical**。LIST/INFO 块把 `data` 推过 36 偏移，破坏识别器校验的 44 字节规范头。加 `-fflags +bitexact -map_metadata -1`。

完整清单在 [docs/PITFALLS.md](docs/PITFALLS.md)。

---

## 仓库结构

```
index.js                 host 插件：注册 provider、委托、套用管线
lib/correct/             纠错引擎（词库、跨语种、保护跨度）
lib/style/               风格画像：学习 + 应用
lib/voiceprint/          说话人嵌入：注册 / 校验（可选）
lib/data/pinyin-table.txt  26,711 字，打包后 160 KB
scripts/                 learn.mjs · enroll.mjs · record.mjs
models/campplus.onnx     28 MB，Apache-2.0 —— 安装时获取，见 models/SOURCES.md
test/                    回归测试
docs/                    DESIGN.md · ADVERSARIAL.md · PITFALLS.md
```

`models/SOURCES.md` 记录每个随附模型的上游 URL、字节数和 SHA-256。拼音表由 [pinyin-data](https://github.com/mozillazg/pinyin-data)（MIT）生成；声纹模型是 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 的 3D-Speaker CAM++（Apache-2.0）。

## 许可证

代码 MIT。上游模型许可证见 `models/SOURCES.md`，均兼容。
