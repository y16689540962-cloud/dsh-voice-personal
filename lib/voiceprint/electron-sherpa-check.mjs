/**
 * Electron 运行时下的 sherpa 加载 + 真模型端到端验证。
 *
 * 用法（必须用 Electron 的 node 模式跑，普通 node 读不了 app.asar）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     dsh-voice-personal/lib/voiceprint/electron-sherpa-check.mjs
 *
 * 退出码 0 = 全部通过。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { VoiceprintStore, resolveSherpa, SAMPLE_RATE } from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const MODEL_PATH = path.join(PLUGIN_ROOT, 'models', 'campplus.onnx');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err && err.message ? err.message : err}`);
  }
}

function synthWav({ seconds = 2.0, f0 = 120, partials = [1, 0.5, 0.3, 0.15], noise = 0.02, seed = 1, amp = 0.35 }) {
  const n = Math.round(seconds * SAMPLE_RATE);
  const pcm = Buffer.alloc(n * 2);
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    let v = 0;
    for (let h = 0; h < partials.length; h += 1) {
      const vibrato = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t + h);
      v += partials[h] * Math.sin(2 * Math.PI * f0 * (h + 1) * vibrato * t + h * 0.7);
    }
    const fade = Math.min(1, i / (0.02 * SAMPLE_RATE), (n - i) / (0.02 * SAMPLE_RATE));
    v = v * 0.25 * fade + (rand() * 2 - 1) * noise;
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * amp * 3)) * 32767), i * 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0, 'latin1');
  hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write('WAVE', 8, 'latin1');
  hdr.write('fmt ', 12, 'latin1');
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(SAMPLE_RATE, 24);
  hdr.writeUInt32LE(SAMPLE_RATE * 2, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36, 'latin1');
  hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

console.log('=== Electron 运行时环境 ===');
console.log(`  process.versions.electron = ${process.versions.electron || '(未设置 —— 不是 Electron 运行时!)'}`);
console.log(`  process.versions.node     = ${process.versions.node}`);
console.log(`  process.resourcesPath     = ${process.resourcesPath || '(无)'}`);
console.log(`  process.platform/arch     = ${process.platform}/${process.arch}`);
console.log('');

if (!process.versions.electron) {
  console.log('[致命] 未在 Electron 运行时下执行。普通 node 无法读取 app.asar 内的 sherpa 包。');
  process.exit(2);
}

console.log('=== 1. sherpa 模块解析（三级回退） ===');
const resolution = resolveSherpa();
console.log(`  结果: ${resolution.ok ? '成功' : '失败'}`);
if (resolution.ok) {
  console.log(`  命中候选: ${resolution.candidate}`);
  console.log(`  解析表达式: ${resolution.detail}`);
} else {
  for (const a of resolution.attempts) console.log(`  - ${a.candidate}: ${a.error}`);
}
console.log('');

check('sherpa-onnx-node 在 Electron 下解析成功', () => {
  assert.equal(resolution.ok, true, `解析失败：${resolution.attempts.map((a) => a.error).join(' | ')}`);
});

check('解析命中的是 Electron 专属路径（不是本地 require）', () => {
  assert.notEqual(resolution.candidate, 'local-require', `命中了 ${resolution.candidate}`);
  assert.ok(
    resolution.candidate === 'resources-path' || resolution.candidate === 'app-asar-hardcoded',
    `候选应为回退路径 2/3，实际 ${resolution.candidate}`,
  );
});

check('导出的 SpeakerEmbeddingExtractor 是构造函数', () => {
  assert.equal(typeof resolution.sherpa.SpeakerEmbeddingExtractor, 'function');
});

console.log('=== 2. 真模型加载 ===');
console.log(`  模型: ${MODEL_PATH}`);
console.log(`  存在: ${fs.existsSync(MODEL_PATH)}`);
if (fs.existsSync(MODEL_PATH)) console.log(`  大小: ${fs.statSync(MODEL_PATH).size} 字节`);
console.log('');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-electron-'));
let store = null;

check('模型文件存在', () => {
  assert.equal(fs.existsSync(MODEL_PATH), true, '模型文件缺失');
});

if (fs.existsSync(MODEL_PATH)) {
  check('VoiceprintStore 在 Electron 下 ready === true', () => {
    store = new VoiceprintStore({ dir, modelPath: MODEL_PATH });
    assert.equal(store.ready, true, `未就绪：${store.unavailableReason}`);
  });
}

if (store && store.ready) {
  console.log('');
  console.log('=== 3. 真模型端到端（合成音频） ===');

  const speakerA1 = synthWav({ seconds: 2.0, f0: 118, partials: [1, 0.55, 0.32, 0.18, 0.08], noise: 0.02, seed: 11 });
  // 同一说话人的「另一次录音」：同基频/谐波结构，换随机相位与轻噪声
  const speakerA2 = synthWav({ seconds: 2.0, f0: 118, partials: [1, 0.55, 0.32, 0.18, 0.08], noise: 0.02, seed: 77 });
  const speakerB = synthWav({ seconds: 2.0, f0: 235, partials: [1, 0.2, 0.7, 0.05], noise: 0.02, seed: 33 });

  let hit = null;
  let miss = null;

  check('enroll 合成音频返回 dim=192', () => {
    const res = store.enroll('speaker-A', speakerA1);
    assert.equal(res.dim, 192, `campplus 应为 192 维，实际 ${res.dim}`);
  });

  check('同一说话人的另一段合成音频 verify 命中', () => {
    hit = store.verify(speakerA2);
    assert.equal(hit.matched, true, `应命中，实际 score=${hit.score.toFixed(4)}`);
    assert.equal(hit.name, 'speaker-A');
  });

  check('不同说话人 verify 不误命中，且分数明显更低', () => {
    miss = store.verify(speakerB);
    assert.equal(miss.matched, false, `不应命中，实际 score=${miss.score.toFixed(4)}`);
    assert.ok(
      hit.score - miss.score > 0.1,
      `分差应明显，实际 命中=${hit.score.toFixed(4)} 不命中=${miss.score.toFixed(4)}`,
    );
  });

  check('已知退化输入（强噪声同人）分数低于阈值——记录真实边界', () => {
    // 诚实记录：合成音频 + 0.05 噪声时分数约 0.61，会落在 0.62 阈值下方。
    // 这是合成信号的限制，不代表真人录音表现；仅作为边界行为存档。
    const degraded = synthWav({ seconds: 2.0, f0: 118, partials: [1, 0.55, 0.32, 0.18, 0.08], noise: 0.05, seed: 555 });
    const r = store.verify(degraded);
    assert.ok(r.score > 0.5 && r.score < 0.7, `退化同人分数应在 0.5~0.7 之间，实际 ${r.score.toFixed(4)}`);
  });

  check('注册第二个说话人后各自命中正确的人', () => {
    store.enroll('speaker-B', speakerB);
    const rA = store.verify(speakerA2);
    const rB = store.verify(synthWav({ seconds: 2.0, f0: 235, partials: [1, 0.2, 0.7, 0.05], noise: 0.02, seed: 99 }));
    assert.equal(rA.name, 'speaker-A', `A 实际匹配 ${rA.name} (${rA.score.toFixed(4)})`);
    assert.equal(rB.name, 'speaker-B', `B 实际匹配 ${rB.name} (${rB.score.toFixed(4)})`);
  });

  check('合成音频分数随「同一说话人」程度单调变化（行为合理性）', () => {
    // 真实录音无法用于测试（音频是 transient 的，磁盘上没有），因此用合成音频做
    // 单调性检查：噪声越大 → 越不像参考；未注册的异人 → 分数明显更低。
    // 注意：必须用**未注册**的第三方声音，否则会与自己的注册向量比出 1.0。
    const clean = synthWav({ seconds: 2.0, f0: 118, partials: [1, 0.55, 0.32, 0.18, 0.08], noise: 0.005, seed: 555 });
    const degraded = synthWav({ seconds: 2.0, f0: 118, partials: [1, 0.55, 0.32, 0.18, 0.08], noise: 0.05, seed: 555 });
    const stranger = synthWav({ seconds: 2.0, f0: 300, partials: [1, 0.15, 0.6, 0.05], noise: 0.02, seed: 404 });
    const sClean = store.verify(clean).score;
    const sDegraded = store.verify(degraded).score;
    const sStranger = store.verify(stranger).score;
    assert.ok(sClean > sDegraded, `低噪声(${sClean.toFixed(4)}) 应高于高噪声(${sDegraded.toFixed(4)})`);
    assert.ok(sDegraded > sStranger, `高噪声同人(${sDegraded.toFixed(4)}) 应高于未注册异人(${sStranger.toFixed(4)})`);
  });

  check('持久化后新实例（Electron + 真模型）仍能命中', () => {
    const reloaded = new VoiceprintStore({ dir, modelPath: MODEL_PATH });
    assert.equal(reloaded.list().length, 2);
    const r = reloaded.verify(speakerA2);
    assert.equal(r.name, 'speaker-A');
    assert.equal(r.matched, true);
  });

  if (hit && miss) {
    console.log('');
    console.log(`  实测分数: 同人 ${hit.score.toFixed(4)} / 异人 ${miss.score.toFixed(4)} （阈值 ${store.threshold}，分差 ${(hit.score - miss.score).toFixed(4)}）`);
  }
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('');
console.log('='.repeat(56));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(56));
process.exit(failed > 0 ? 1 : 0);
