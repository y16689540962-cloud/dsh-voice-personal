# lib/voiceprint — 说话人声纹注册与校验

用 DSH 自带的 `sherpa-onnx-node` + campplus 模型做说话人声纹（speaker verification）。
纯 ESM，只依赖 node 内置模块 + sherpa，无第三方 npm 依赖。

## 用法

```js
import { VoiceprintStore } from './lib/voiceprint/index.js';

const store = new VoiceprintStore({
  dir: '/path/to/data/voiceprint',        // 声纹数据目录（不存在会自动创建）
  modelPath: '/path/to/models/campplus.onnx',
  threshold: 0.62,                         // 可选，默认 0.62
  logger: console,                         // 可选
});

store.ready;                               // 模型是否可用（boolean）
store.enroll('me', wavBuffer);         // -> { name, dim, samples }
store.verify(wavBuffer);                   // -> { matched, name, score, best }
store.list();                              // -> [{ name, dim, createdAt, samples }]
store.remove('me');                    // -> boolean
store.clear();
```

`wavBuffer` 必须是 **canonical 16kHz 单声道 PCM16 WAV**（44 字节标准头 + PCM）。
不合规会抛带原因的 `Error`（非 RIFF/WAVE、采样率非 16000、非单声道、非 16bit、
扩展 fmt 块、音频短于 0.5s 等）。

## 关键实现说明

### 1. sherpa 模块解析必须走 Electron 路径

插件安装在 `~/.dsh/profiles/desktop/node_modules/`，那里**没有** sherpa，
所以 `createRequire(import.meta.url)('sherpa-onnx-node')` 必然失败。
`loadSherpa()` 按顺序回退：

1. `createRequire(import.meta.url)('sherpa-onnx-node')`（普通 node 开发时可用）
2. `createRequire(process.resourcesPath + '/app.asar/dsh/node_modules/sherpa-onnx-node/package.json')`
3. `createRequire('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/sherpa-onnx-node/package.json')`
4. 逃生口：环境变量 `DSH_SHERPA_PACKAGE_JSON`（非冻结要求，便于迁移/测试）

全部失败时抛出的错误会列出每条候选的具体失败原因。

**实测**：Electron 运行时下命中候选 2（`resources-path`）；普通 node 下 1/2/3 全部失败
（普通 node 读不了 `app.asar`），这是预期行为。

### 2. ⚠️ Electron 下必须关掉 external buffer

`sherpa-onnx-node` 的 `compute(stream, enableExternalBuffer = true)` **默认启用零拷贝外部缓冲**，
而 Electron 的 V8 配置禁止外部缓冲，直接抛：

```
External buffers are not allowed
```

因此本模块显式调用 `compute(stream, false)`，拿普通堆缓冲。
这是**本模块最容易踩的坑**，普通 node 下不会暴露，只有 Electron 下才复现。

### 3. 模型缺失不阻塞插件加载

构造时模型不存在/加载失败**不抛错**，只把 `ready` 置为 `false`，
`unavailableReason` 给出原因；真正调用 `enroll`/`verify` 时才抛清晰错误。
这样插件在没放模型的机器上仍可被加载。

### 4. 持久化

`<dir>/voiceprints.json`，纯 JSON：

```json
{
  "version": 1,
  "threshold": 0.62,
  "speakers": [
    { "name": "me", "dim": 192, "embedding": [ ... ], "createdAt": "2026-...Z", "samples": 1 }
  ]
}
```

写入用原子写（写 `.tmp` → `fsync` → `rename`），不留残file。
文件损坏时以空库启动并给出 `loadWarning`，不会崩溃；损坏的条目被单独丢弃。

同名重复 `enroll` 会对 L2 归一化后的向量做**增量平均**，`samples` 记录参与平均的样本数。

## 自测

```bash
cd dsh-voice-personal

# 不依赖模型：38 项（WAV 校验、余弦/L2、store 逻辑、持久化、降级）
node lib/voiceprint/selftest.mjs --no-model

# 全量：在普通 node 下真模型用例会自动跳过（sherpa 解析不到）
node lib/voiceprint/selftest.mjs

# 真模型 + Electron 运行时：12 项
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  lib/voiceprint/electron-sherpa-check.mjs
```

## 已知限制

1. **合成音频的阈值行为与真人录音不同。** 真模型在合成音频上的实测分数：

   | 输入 | score | 是否命中（阈值 0.62） |
   | --- | --- | --- |
   | 与注册音频完全相同 | 1.0000 | 命中 |
   | 同基频/谐波，噪声 0.005 | 0.9228 | 命中 |
   | 同基频/谐波，噪声 0.02（新随机相位） | 0.8252 | 命中 |
   | 同基频/谐波，噪声 0.05 | 0.6136 | **未命中** |
   | 同基频，时长 3s | 0.7368 | 命中 |
   | 异人 f0=235 | 0.4284 | 未命中 |
   | 异人 f0=300 | 0.4044 | 未命中 |
   | 纯白噪声 | 0.2832 | 未命中 |

   即：**合成音频噪声一高就会掉到阈值下方**。这是合成信号的局限，
   **不代表真人录音表现**。真人录音下的最佳阈值需要用户真实录音来标定。
2. **未用真人录音验证过**。用户音频是 transient 的、磁盘上不留存，
   因此本项目所有声纹测试均基于合成音频。真人场景的误拒/误受率未知。
3. **阈值为全局单一值**，不支持按说话人设置。
4. **未做重采样**。输入必须是 16kHz；其他采样率一律抛错，不做自动转换。
5. **未做静音/VAD 裁剪**。整段音频直接送模型，前后静音会稀释嵌入。
6. `enroll`/`verify` 是**同步阻塞**的（sherpa 的 `compute` 本身同步），
   长音频会阻塞事件循环。当前设计面向短句（1–3s）。
7. 模型文件 28MB **未纳入版本控制**。
