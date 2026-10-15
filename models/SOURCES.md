# 模型来源与校验（models/）

## campplus.onnx

| 项 | 值 |
| --- | --- |
| 本地路径 | `dsh-voice-personal/models/campplus.onnx` |
| 字节数 | `28281138` |
| sha256 | `f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11` |
| 上游文件名 | `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx` |
| 上游下载地址 | https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx |
| 发布页 | https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models |
| 上游最后修改时间 | `Mon, 14 Oct 2024 03:41:20 GMT`（HTTP `last-modified`，下载时实测） |
| 许可证 | Apache-2.0 |
| 用途 | 说话人声纹嵌入（speaker embedding），campplus 中文通用 16k 模型 |
| 嵌入维度 | `192`（本机实测，见下） |

### 校验方式（可复现）

本机已独立复算，并**重新下载上游文件做过逐字节比对**：

```bash
# 1) 本地文件校验
shasum -a 256 dsh-voice-personal/models/campplus.onnx
# -> f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11

# 2) 重新下载上游同名文件并比对
curl -L -o /tmp/upstream.onnx \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"
stat -f%z /tmp/upstream.onnx      # -> 28281138
shasum -a 256 /tmp/upstream.onnx  # -> f682b514...d21fd11（与本地一致）

# 3) 运行时确认维度
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  -e "..."   # 见 lib/voiceprint/electron-sherpa-check.mjs，输出 dim=192
```

**结论**：本地文件与上游发布产物**字节完全一致**（大小 + sha256 双项吻合），来源与完整性均可确认。

## 相关依赖（非本目录文件，供溯源）

| 组件 | 版本 / 位置 |
| --- | --- |
| `sherpa-onnx-node` | `1.13.8`（Apache-2.0） |
| 原生库 | `sherpa-onnx-darwin-arm64`，位于 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/` |
| 原生模块解析 | Electron 运行时经 `process.resourcesPath + '/app.asar/dsh/node_modules/sherpa-onnx-node/package.json'` 解析成功（见 `lib/voiceprint/index.js` 的 `loadSherpa()`） |

## 注意

- 该模型**未纳入版本控制**（28MB）；仓库根 `.gitignore` 未包含 `models/`，如需提交请自行确认是否要忽略大文件。
- 不要写入 `~/.dsh`（沙箱会拒绝）。
