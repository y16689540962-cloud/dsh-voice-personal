# 第三方内容与许可证

本仓库分发了三样不是我们自己写的东西。这里把每一样的来源、许可证和它带来的义务写清楚。

**本项目的源代码本身没有任何第三方依赖**（`dependencies` 为空），也没有包含任何第三方源代码。下面只是数据与模型。

---

## 1. 拼音表 `lib/data/pinyin-table.txt`

**随 npm 包分发**（`dsh-voice-personal` 的 `lib/`、`asr-personal-dictionary` 的 `dist/data/`）。

| 项 | 值 |
| --- | --- |
| 上游 | [mozillazg/pinyin-data](https://github.com/mozillazg/pinyin-data) |
| 许可证 | MIT |
| 版权 | Copyright (c) 2016 mozillazg |
| 我们的改动 | 抽取 26,711 个汉字的普通话读音；去声调；`ü` 写作 `v`；压成 `字拼音字拼音…` 连排格式。**读音本身未改动** |
| 上游的再上游 | pinyin-data 的读音来自 [Unihan 数据库](https://www.unicode.org/reports/tr38/) 的 `kMandarin`、`kHanyuPinyin`、`kTGHZ2013`、`kXHC1983` 等字段 |

MIT 许可证要求「在软件的所有副本或实质部分中保留上述版权声明和许可声明」，因此原文附上：

```
The MIT License (MIT)

Copyright (c) 2016 mozillazg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. 声纹模型 `models/campplus.onnx`

**不随 npm 包分发**，只作为 GitHub Release 附件提供（`files` 白名单里没有 `models/`）。

| 项 | 值 |
| --- | --- |
| 上游文件 | `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx` |
| 分发方 | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（Apache-2.0） |
| 模型原始出处 | [3D-Speaker](https://github.com/modelscope/3D-Speaker)（Apache-2.0）——sherpa-onnx 只是托管与转换方，**许可证相同**，已核实 |
| 发布页 | https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models |
| 字节数 | `28281138` |
| SHA-256 | `f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11` |
| 许可证 | Apache-2.0 |
| 我们的改动 | **无**。逐字节原样分发，下载后可自行复算 SHA-256 比对 |

Apache-2.0 第 4 条要求向接收方提供许可证副本，完整文本见 [`LICENSE-APACHE-2.0.txt`](LICENSE-APACHE-2.0.txt)（取自 sherpa-onnx 上游，逐字节相同）。

模型的详细来源、下载时间与校验方式另见 [`models/SOURCES.md`](models/SOURCES.md)。

---

## 3. 明确没有使用的东西

记录下来，免得以后反复评估：

| 项目 | 许可证 | 为什么没用 |
| --- | --- | --- |
| [opencc-js](https://github.com/nk2028/opencc-js) | MIT | 简繁转换。项目明确不做简繁转换（静默改变文字体系是用户没要求的语义变更），所以不需要 |
| pypinyin | MIT | 只在审计时**对照验证**过拼音表读音，没有引入代码或数据 |
| 任何 ASR / LLM 模型 | — | 语音识别走 DSH 内置的 SenseVoice provider；纠错层是纯规则，不含模型 |

## 4. 关于参考过但未复制的项目

设计过程中阅读过 [zephyr4123/speakmore](https://github.com/zephyr4123/speakmore)（MIT）的公开源码与文档，用于评估「云端 LLM 一站式整理」与「本地规则纠正」两条路线。

**没有复制任何代码或文本**：对 `README.md`、`scripts/dev/eval-prompt.mjs`、`src/server/refine/prompt.mjs`、`src/server/refine/refiner.mjs`、`docs/implementation-notes.md` 做过连续 40 字符片段比对，与本仓库的 `test/eval.mjs`、`test/corpus/regression.json`、`packages/personal-dictionary/**`、`skills/**` 重合数为 **0**。

沿用过来的是**方法与思路**——按录音时长分层抽样、锁定样本集、改前改后各跑一次对比、每条规则后面跟一个实测数字。这些是方法，不是表达，本来也不在著作权保护范围内。

---

*本文件随仓库更新。若你发现遗漏了任何第三方内容，请开 issue。*
