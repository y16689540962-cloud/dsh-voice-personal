# 踩坑清单 —— 在 DeepSeek Harness 桌面面上做语音/插件

**中文** | [English](PITFALLS.en.md)

发布这个插件的过程中留下的现场笔记。每一条都花了真实调试时间，搜索引擎里很难找到。大致按耗费时间排序。

## Electron 下的 sherpa-onnx

**`compute(stream)` 抛 `External buffers are not allowed`。**

sherpa-onnx-node 1.13.8 的 `SpeakerEmbeddingExtractor.compute(stream, enableExternalBuffer)` 默认 `true`——零拷贝外部缓冲——被 Electron 的 V8 内存笼禁止。显式传 `false`：

```js
const embedding = extractor.compute(stream, /* enableExternalBuffer */ false);
```

普通 Node 下不可见；只在 Electron 内复现。用系统 Node 测插件的话，harness 加载之前你都不会看见它。

## profile 安装 bundle 的模块解析

**`createRequire(import.meta.url)('sherpa-onnx-node')` fails for profile bundles.**

profile 的 node_modules 只有 pnpm 装进去的东西。harness 内置的包从安装目录解析——但你的 bundle 不在那里。内置 sensevoice provider 没这个坑，因为它本身就在安装里。

```js
const candidates = [
  () => createRequire(import.meta.url)('sherpa-onnx-node'),
  () => createRequire(join(process.resourcesPath, 'app.asar/dsh/node_modules/sherpa-onnx-node/package.json'))('sherpa-onnx-node'),
  () => createRequire('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/sherpa-onnx-node/package.json')('sherpa-onnx-node'),
];
```

原生二进制在 `app.asar.unpacked`，Electron 的 fs 补丁会自动把 `*.node` 的加载重定向过去——Host 进程里从 `app.asar` 内部 require 是可以的。

## 路径

**`new URL(import.meta.url).pathname` keeps percent-encoding.**

任何非 ASCII 安装路径（本项目就在中文目录下）都会在 pathname 里产生 `%E5%B7%A5...`，作为文件系统路径直接失效。永远用：

```js
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
```

**The Electron process does not carry `$DSH_HOME`.**

CLI 启动 profile 时会设置它；桌面 App 不会。用 `process.env.DSH_HOME ?? here` 解析数据路径的插件会悄悄落回自己的安装目录。这条作为真实 bug 发布过：严格声纹门禁读到空库，在每次听写上 fail-closed。应回退到 `~/.dsh`——App 实际的存储目录。

## 数据格式

**Session logs are multi-frame zstd.**

`~/.dsh/sessions/*/**/session.v4.jsonl.zstd` 是一串 zstd 帧，每次追加一帧。`zstdDecompressSync` 只解第一帧就返回——静默丢掉对话的其余部分。要逐帧走：

```js
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
let pos = 0;
while (pos < buf.length) {
  let next = buf.indexOf(MAGIC, pos + 4);
  if (next === -1) next = buf.length;
  try { parts.push(zlib.zstdDecompressSync(buf.subarray(pos, next))); } catch {}
  pos = next;
}
```

**ffmpeg's default WAV output is not canonical.**

ffmpeg 会写 `LIST/INFO` 元数据块，把 `data` 推过 36 偏移。harness 校验严格的 44 字节规范头（16kHz、单声道、PCM16），会拒绝这个文件。
强制裸头：

```
-fflags +bitexact -flags:a +bitexact -map_metadata -1 -f wav out.wav
```

**Canonical WAV 契约：** `RIFF/WAVE/fmt(16)/data`、16000 Hz、单声道、16-bit、头恰好 44 字节、PCM 从 44 开始。浮点采样 = `int16LE / 32768`。

## Cordis / DSH 细节

**Cordis rejects undeclared property assignment on the context.**

`ctx.voicePersonal = {...}` 抛 `cannot set property "voicePersonal" without provide` 并杀死激活。改用模块级 `export let internals`，或注册真正的 service。

**Inject optional services.**

`export const inject = ['speechToText']` 让插件在没有该 service 的 profile 里保持未激活（显示为「pending, waiting for service」）——这正是想要的行为。改成直接 import service 模块会让 bundle 到处加载失败。

**`pnpm file:` dependencies are hardlinks.**

`plugin add file:$PWD` 链接目录；改源码等于改已安装副本，所有 profile 的安装副本共享一个 inode。用旧备份覆盖工作区文件会把*所有* profile 一起回退。整体替换文件前先断链（复制 + 重装）。

**`files` in package.json governs file: installs too.**

`files` 白名单漏掉目录（比如 `models/`）会把它静默排除出安装包——插件正常激活，然后模型不在代码期望的位置。探针结果是 `voiceprintReady: false`，且无任何报错。

**desktop is not a profile template.**

`--from-default-profile desktop` 会失败；模板是 `web`、`headless`、`sdk`、`sdk-minimal`、`acp`。要镜像 desktop profile 做测试，建一个 `web` profile 再追加需要的 bundle——但注意从 npm 拉的 voice bundle 钉着更旧的 peer 范围，会因不兼容被禁用；desktop profile 是从安装目录解析那些包的。

**Version-compatibility gating is exact.**

`peerDependencies` 钉住不同 dsh 版本的 bundle 会在启动时被禁用，错误信息精确到给出 `dsh plugin allow-version` 这个覆盖手段。读启动日志；每个插件一行。

## 模型溯源

每个随附模型在下载时就记录上游 URL、字节数和 SHA-256（`models/SOURCES.md`）。事后验证一个 28MB 二进制是猜谜；下载时验证只是一条 `shasum -a 256`。
