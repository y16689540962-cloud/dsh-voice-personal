/**
 * dsh-voice-personal / lib/voiceprint — 自测脚本（不依赖测试框架）
 *
 * 用法:
 *   node lib/voiceprint/selftest.mjs            # 全跑（需要真模型）
 *   node lib/voiceprint/selftest.mjs --no-model # 只跑不依赖模型的逻辑用例
 *
 * 退出码 0 = 全部通过。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  VoiceprintStore,
  parseWavToSamples,
  cosineSimilarity,
  l2normalize,
  resolveSherpa,
  SAMPLE_RATE,
  MIN_SAMPLES,
} from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const MODEL_PATH = path.join(PLUGIN_ROOT, 'models', 'campplus.onnx');

const USE_MODEL = !process.argv.includes('--no-model');

/* -------------------------------------------------------------------------- */
/* 极简测试框架                                                                */
/* -------------------------------------------------------------------------- */

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err && err.message ? err.message : err}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* -------------------------------------------------------------------------- */
/* 合成音频工具                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 生成 16kHz mono PCM16 WAV。
 * `partials` 描述谐波结构；`f0` 基频；`jitter` 随机相位/噪声，用来模拟「同一说话人的另一次录音」。
 * 返回 Buffer。
 */
function synthWav({ seconds = 2.0, f0 = 120, partials = [1, 0.5, 0.3, 0.15], noise = 0.02, seed = 1, amp = 0.35 }) {
  const n = Math.round(seconds * SAMPLE_RATE);
  const pcm = Buffer.alloc(n * 2);
  // 简易确定性 PRNG，保证可复现
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    let v = 0;
    for (let h = 0; h < partials.length; h += 1) {
      // 轻微颤音，避免完全稳态正弦（稳态信号对说话人模型是退化输入）
      const vibrato = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t + h);
      v += partials[h] * Math.sin(2 * Math.PI * f0 * (h + 1) * vibrato * t + h * 0.7);
    }
    // 起止淡入淡出，避免爆音
    const fade = Math.min(1, i / (0.02 * SAMPLE_RATE), (n - i) / (0.02 * SAMPLE_RATE));
    v = v * 0.25 * fade + (rand() * 2 - 1) * noise;
    const clamped = Math.max(-1, Math.min(1, v * amp * 3));
    pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return wavFromPcm(pcm);
}

/** 把裸 PCM 包成 44 字节 canonical 头。 */
function wavFromPcm(pcm, { sampleRate = SAMPLE_RATE, channels = 1, bits = 16, dataSize } = {}) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataSize === undefined ? pcm.length : dataSize, 40);
  return Buffer.concat([header, pcm]);
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `vp-${tag}-`));
}

/* -------------------------------------------------------------------------- */
/* 用例 1：WAV 解析与校验（不需要模型）                                         */
/* -------------------------------------------------------------------------- */

section('1. WAV 解析与校验');

test('合法 canonical WAV 能解析出正确的采样点数与幅值', () => {
  const wav = synthWav({ seconds: 1.0, amp: 0.5 });
  const samples = parseWavToSamples(wav);
  assert.equal(samples.length, SAMPLE_RATE);
  assert.ok(samples instanceof Float32Array);
  assert.ok(Math.abs(samples[100]) <= 1, 'sample 应在 [-1,1]');
  // 头部字节不进采样数据
  const expectedFirst = new DataView(wav.buffer, wav.byteOffset + 44, 2).getInt16(0, true) / 32768;
  assert.equal(samples[0], expectedFirst);
});

test('拒绝非 RIFF 数据', () => {
  const bad = Buffer.alloc(100);
  bad.write('XXXX', 0, 'latin1');
  assert.throws(() => parseWavToSamples(bad), /RIFF/);
});

test('拒绝 WAVE 标识错误', () => {
  const wav = synthWav({ seconds: 1 });
  wav.write('AVI ', 8, 'latin1');
  assert.throws(() => parseWavToSamples(wav), /WAVE/);
});

test('拒绝非 44 字节标准头（扩展 fmt 块）', () => {
  const wav = synthWav({ seconds: 1 });
  wav.write('LIST', 36, 'latin1');
  assert.throws(() => parseWavToSamples(wav), /data 块/);
});

test('拒绝 44100Hz', () => {
  const wav = synthWav({ seconds: 1 });
  wav.writeUInt32LE(44100, 24);
  assert.throws(() => parseWavToSamples(wav), /采样率 44100Hz/);
});

test('拒绝立体声', () => {
  const wav = synthWav({ seconds: 1 });
  wav.writeUInt16LE(2, 22);
  assert.throws(() => parseWavToSamples(wav), /单声道/);
});

test('拒绝 8bit 位深', () => {
  const wav = synthWav({ seconds: 1 });
  wav.writeUInt16LE(8, 34);
  assert.throws(() => parseWavToSamples(wav), /16bit/);
});

test('拒绝非 PCM 编码（如 IEEE float=3）', () => {
  const wav = synthWav({ seconds: 1 });
  wav.writeUInt16LE(3, 20);
  assert.throws(() => parseWavToSamples(wav), /PCM/);
});

test('拒绝短于 44 字节的缓冲', () => {
  assert.throws(() => parseWavToSamples(Buffer.alloc(20)), /太短/);
});

test('拒绝短于 0.5s 的音频（不喂给 native）', () => {
  const wav = synthWav({ seconds: 0.3 });
  assert.throws(() => parseWavToSamples(wav), /音频太短/);
});

test('恰好 0.5s 边界通过', () => {
  const wav = synthWav({ seconds: 0.5 });
  const samples = parseWavToSamples(wav);
  assert.equal(samples.length, MIN_SAMPLES);
});

test('非 Buffer 类型报错', () => {
  assert.throws(() => parseWavToSamples('not a buffer'), /Buffer 或 Uint8Array/);
});

test('Buffer 视图（byteOffset 非 0）也能正确解析', () => {
  const wav = synthWav({ seconds: 1 });
  const padded = Buffer.concat([Buffer.alloc(7, 0xaa), wav]);
  const view = padded.subarray(7);
  assert.equal(view.byteOffset, 7);
  const samples = parseWavToSamples(view);
  assert.equal(samples.length, SAMPLE_RATE);
});

/* -------------------------------------------------------------------------- */
/* 用例 2：数学工具                                                            */
/* -------------------------------------------------------------------------- */

section('2. 余弦相似度 / L2 归一化');

test('相同向量余弦为 1', () => {
  const v = Float32Array.from([0.1, -0.4, 0.9, 0.33]);
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-6);
});

test('正交向量余弦为 0', () => {
  assert.ok(Math.abs(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))) < 1e-6);
});

test('反向向量余弦为 -1', () => {
  assert.ok(Math.abs(cosineSimilarity(Float32Array.from([1, 2]), Float32Array.from([-1, -2])) + 1) < 1e-6);
});

test('L2 归一化后模长为 1', () => {
  const n = l2normalize(Float32Array.from([3, 4]));
  assert.ok(Math.abs(Math.hypot(n[0], n[1]) - 1) < 1e-6);
});

test('维度不一致抛错', () => {
  assert.throws(() => cosineSimilarity(Float32Array.from([1]), Float32Array.from([1, 2])), /维度不一致/);
});

/* -------------------------------------------------------------------------- */
/* 用例 3：Store 逻辑（用假提取器，不需要模型）                                  */
/* -------------------------------------------------------------------------- */

section('3. VoiceprintStore 逻辑（假提取器）');

/**
 * 假提取器：32 维对数间隔频带能量（类 Goertzel），用于确定性验证 store 的
 * 余弦 / 阈值 / 持久化逻辑。与真模型无关，但**必须具有真实的区分度**，
 * 否则「异音不误命中」这条用例测的是 fixture 而不是 store。
 */
const FAKE_BANDS = 32;
const FAKE_DIM = FAKE_BANDS;

function fakeExtractorFactory() {
  return {
    createStream: () => ({
      _samples: null,
      acceptWaveform({ samples }) {
        this._samples = samples;
      },
      free() {},
    }),
    compute(stream) {
      const s = stream._samples;
      const out = new Float32Array(FAKE_DIM);
      // 频带中心：80Hz ~ 3500Hz 对数分布
      for (let b = 0; b < FAKE_BANDS; b += 1) {
        const f = 80 * Math.pow(3500 / 80, b / (FAKE_BANDS - 1));
        let re = 0;
        let im = 0;
        for (let i = 0; i < s.length; i += 1) {
          const ph = (2 * Math.PI * f * i) / SAMPLE_RATE;
          re += s[i] * Math.cos(ph);
          im += s[i] * Math.sin(ph);
        }
        out[b] = Math.sqrt(re * re + im * im) / s.length;
      }
      // 加一个能量维度，保证零信号也有稳定向量
      return out;
    },
  };
}

test('enroll 返回 {name, dim, samples}', () => {
  const dir = tmpdir('enroll');
  const store = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  assert.equal(store.ready, true, '注入假提取器后 ready 应为 true');
  const res = store.enroll('alice', synthWav({ seconds: 1, f0: 120 }));
  assert.equal(res.name, 'alice');
  assert.equal(res.dim, FAKE_DIM);
  assert.equal(res.samples, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('相同音频 enroll 后 verify 命中', () => {
  const dir = tmpdir('hit');
  const store = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  const wav = synthWav({ seconds: 1, f0: 120, seed: 42 });
  store.enroll('alice', wav);
  const r = store.verify(wav);
  assert.equal(r.matched, true, `应命中，实际 score=${r.score}`);
  assert.equal(r.name, 'alice');
  assert.ok(r.score > 0.99, `同音频分数应接近 1，实际 ${r.score}`);
  assert.equal(r.best.name, 'alice');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('明显不同的音频 verify 不误命中，且分数明显更低', () => {
  const dir = tmpdir('miss');
  const store = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  const a = synthWav({ seconds: 1, f0: 110, partials: [1, 0.5, 0.3, 0.15], noise: 0.01, seed: 1 });
  const b = synthWav({ seconds: 1, f0: 300, partials: [1, 0.2, 0.7, 0.05], noise: 0.20, seed: 2 });
  store.enroll('alice', a);
  const hit = store.verify(a);
  const miss = store.verify(b);
  assert.equal(miss.matched, false, `不应命中，实际 score=${miss.score}`);
  assert.equal(miss.name, 'alice', 'best 仍应指向最相近的已注册说话人');
  assert.ok(hit.score - miss.score > 0.1, `分差应明显，实际 hit=${hit.score} miss=${miss.score}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('阈值可配：调高阈值后同一说话人的另一次录音可能被判不命中', () => {
  const dir = tmpdir('thr');
  // 同一基频/谐波结构，但换随机相位与噪声 → 模拟「同人不同次录音」，分数高但不为 1
  const ref = synthWav({ seconds: 1, f0: 120, seed: 5 });
  const probe = synthWav({ seconds: 1, f0: 120, noise: 0.35, seed: 6 });

  const loose = new VoiceprintStore({
    dir,
    modelPath: null,
    threshold: 0.62,
    extractorFactory: fakeExtractorFactory,
  });
  loose.enroll('alice', ref);
  const looseScore = loose.verify(probe).score;

  const strict = new VoiceprintStore({
    dir,
    modelPath: null,
    threshold: 0.9999,
    extractorFactory: fakeExtractorFactory,
  });
  const strictRes = strict.verify(probe);

  assert.ok(looseScore < 0.9999, `探针分数应低于 0.9999，实际 ${looseScore}`);
  assert.equal(strictRes.matched, false, `阈值 0.9999 下应不命中，实际 score=${strictRes.score}`);
  assert.equal(strict.threshold, 0.9999);
  assert.ok(looseScore >= 0.62, `同一说话人分数应高于默认阈值，实际 ${looseScore}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('重复 enroll 同名会合并样本数', () => {
  const dir = tmpdir('merge');
  const store = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  store.enroll('alice', synthWav({ seconds: 1, f0: 120, seed: 1 }));
  const second = store.enroll('alice', synthWav({ seconds: 1, f0: 125, seed: 2 }));
  assert.equal(second.samples, 2);
  assert.equal(store.list().length, 1, '同名不应产生两条记录');
  assert.equal(store.list()[0].samples, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('list() 返回 name/dim/createdAt/samples 且不含 embedding', () => {
  const dir = tmpdir('list');
  const store = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  store.enroll('alice', synthWav({ seconds: 1 }));
  const l = store.list();
  assert.equal(l.length, 1);
  assert.deepEqual(Object.keys(l[0]).sort(), ['createdAt', 'dim', 'name', 'samples']);
  assert.ok(!Number.isNaN(Date.parse(l[0].createdAt)), 'createdAt 应是 ISO 时间');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('remove 已存在返回 true，不存在返回 false', () => {
  const dir = tmpdir('rm');
  const store = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  store.enroll('alice', synthWav({ seconds: 1 }));
  assert.equal(store.remove('alice'), true);
  assert.equal(store.remove('alice'), false);
  assert.equal(store.list().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('clear 清空全部', () => {
  const dir = tmpdir('clear');
  const store = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  store.enroll('alice', synthWav({ seconds: 1, seed: 1 }));
  store.enroll('bob', synthWav({ seconds: 1, f0: 200, seed: 2 }));
  assert.equal(store.list().length, 2);
  store.clear();
  assert.equal(store.list().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('空库 verify 不报错且不命中', () => {
  const dir = tmpdir('empty');
  const store = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  const r = store.verify(synthWav({ seconds: 1 }));
  assert.deepEqual(r, { matched: false, name: null, score: 0, best: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('enroll 空 name 抛错', () => {
  const dir = tmpdir('badname');
  const store = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  assert.throws(() => store.enroll('   ', synthWav({ seconds: 1 })), /非空字符串/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* 用例 4：持久化                                                              */
/* -------------------------------------------------------------------------- */

section('4. 持久化（原子写 / JSON 结构 / 目录自建）');

test('自动创建不存在的目录', () => {
  const base = tmpdir('mkdir');
  const dir = path.join(base, 'nested', 'deep');
  assert.equal(fs.existsSync(dir), false);
  const store = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  store.enroll('alice', synthWav({ seconds: 1 }));
  assert.ok(fs.existsSync(dir), '目录应被自动创建');
  assert.ok(fs.existsSync(path.join(dir, 'voiceprints.json')));
  fs.rmSync(base, { recursive: true, force: true });
});

test('落盘 JSON 结构符合冻结 schema，且不含 .tmp 残留', () => {
  const dir = tmpdir('schema');
  const store = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  store.enroll('alice', synthWav({ seconds: 1 }));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'voiceprints.json'), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(typeof raw.threshold, 'number');
  assert.ok(Array.isArray(raw.speakers));
  assert.deepEqual(Object.keys(raw.speakers[0]).sort(), [
    'createdAt',
    'dim',
    'embedding',
    'name',
    'samples',
  ]);
  assert.equal(raw.speakers[0].embedding.length, raw.speakers[0].dim);
  assert.ok(Array.isArray(raw.speakers[0].embedding), 'embedding 必须是纯数组（可 JSON 序列化）');
  assert.equal(fs.existsSync(path.join(dir, 'voiceprints.json.tmp')), false, '不应残留 .tmp');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('新实例能读回已注册的声纹并命中', () => {
  const dir = tmpdir('reload');
  const wav = synthWav({ seconds: 1, f0: 130, seed: 7 });
  const s1 = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  s1.enroll('alice', wav);

  const s2 = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  assert.equal(s2.list().length, 1);
  assert.equal(s2.list()[0].name, 'alice');
  const r = s2.verify(wav);
  assert.equal(r.matched, true);
  assert.equal(r.name, 'alice');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('threshold 会被持久化并在新实例中沿用', () => {
  const dir = tmpdir('thrpersist');
  const s1 = new VoiceprintStore({
    dir,
    modelPath: null,
    threshold: 0.85,
    extractorFactory: fakeExtractorFactory,
  });
  s1.enroll('alice', synthWav({ seconds: 1 }));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'voiceprints.json'), 'utf8'));
  assert.equal(raw.threshold, 0.85);
  const s2 = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  assert.equal(s2.threshold, 0.85, '新实例应沿用文件里的阈值');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('损坏的 JSON 不会崩溃，以空库启动并给出告警', () => {
  const dir = tmpdir('corrupt');
  fs.writeFileSync(path.join(dir, 'voiceprints.json'), '{ this is not json', 'utf8');
  const store = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  assert.equal(store.list().length, 0);
  assert.ok(store.loadWarning, '应有 loadWarning');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('损坏的条目被丢弃，合法条目保留', () => {
  const dir = tmpdir('partial');
  const good = { name: 'alice', dim: 2, embedding: [1, 0], createdAt: '2026-01-01T00:00:00.000Z', samples: 1 };
  const bad = { name: 'bob', dim: 2, embedding: [1, 'x'], createdAt: '2026-01-01T00:00:00.000Z', samples: 1 };
  fs.writeFileSync(
    path.join(dir, 'voiceprints.json'),
    JSON.stringify({ version: 1, threshold: 0.62, speakers: [good, bad] }),
    'utf8',
  );
  const store = new VoiceprintStore({ dir, modelPath: null, extractorFactory: fakeExtractorFactory });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].name, 'alice');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('未提供 dir 时构造抛 TypeError', () => {
  assert.throws(() => new VoiceprintStore({}), /非空字符串目录/);
});

/* -------------------------------------------------------------------------- */
/* 用例 5：模型缺失时的降级行为                                                 */
/* -------------------------------------------------------------------------- */

section('5. 模型不可用时的降级（不崩溃、清晰报错）');

test('modelPath 指向不存在的文件时 ready=false 且不抛错', () => {
  const dir = tmpdir('nomodel');
  const store = new VoiceprintStore({ dir, modelPath: '/nonexistent/campplus.onnx' });
  assert.equal(store.ready, false);
  assert.match(store.unavailableReason, /不存在/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('模型不可用时 enroll 抛清晰错误', () => {
  const dir = tmpdir('nomodel2');
  const store = new VoiceprintStore({ dir, modelPath: '/nonexistent/campplus.onnx' });
  assert.throws(() => store.enroll('alice', synthWav({ seconds: 1 })), /声纹提取器不可用/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('模型不可用时 verify 空库仍返回未命中（不抛错）', () => {
  const dir = tmpdir('nomodel3');
  const store = new VoiceprintStore({ dir, modelPath: '/nonexistent/campplus.onnx' });
  const r = store.verify(synthWav({ seconds: 1 }));
  assert.equal(r.matched, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* 用例 6：真模型端到端                                                        */
/* -------------------------------------------------------------------------- */

if (USE_MODEL) {
  section('6. 真模型端到端（campplus.onnx + sherpa-onnx-node）');

  const modelExists = fs.existsSync(MODEL_PATH);
  const resolution = resolveSherpa();

  console.log(`  模型路径: ${MODEL_PATH}`);
  console.log(`  模型存在: ${modelExists}${modelExists ? ` (${fs.statSync(MODEL_PATH).size} 字节)` : ''}`);
  console.log(`  sherpa 解析: ${resolution.ok ? `成功 via ${resolution.candidate}` : '失败'}`);
  if (!resolution.ok) {
    for (const a of resolution.attempts) console.log(`    - ${a.candidate}: ${a.error}`);
  }

  if (!modelExists || !resolution.ok) {
    console.log('\n  [跳过] 真模型用例需要模型文件 + 可解析的 sherpa-onnx-node。');
    console.log('         请用 Electron 运行时执行本脚本，见 electron-sherpa-check.mjs。');
  } else {
    const dir = tmpdir('real');
    const store = new VoiceprintStore({ dir, modelPath: MODEL_PATH });

    test('真模型下 ready === true', () => {
      assert.equal(store.ready, true, `模型未加载：${store.unavailableReason}`);
    });

    if (store.ready) {
      // 「同一说话人」：同 f0/谐波结构，不同随机相位与噪声 → 模拟同一人两次录音
      const speakerA1 = synthWav({ seconds: 2.0, f0: 118, partials: [1, 0.55, 0.32, 0.18, 0.08], noise: 0.02, seed: 11 });
      const speakerA2 = synthWav({ seconds: 2.0, f0: 118, partials: [1, 0.55, 0.32, 0.18, 0.08], noise: 0.05, seed: 77 });
      // 「另一个说话人」：明显不同的基频与谐波结构
      const speakerB = synthWav({ seconds: 2.0, f0: 235, partials: [1, 0.2, 0.7, 0.05], noise: 0.02, seed: 33 });

      let hit = null;
      let miss = null;

      test('enroll 合成音频 A，返回 dim=192', () => {
        const res = store.enroll('speaker-A', speakerA1);
        assert.equal(res.dim, 192, `campplus 应为 192 维，实际 ${res.dim}`);
        assert.equal(res.samples, 1);
      });

      test('同一说话人的另一段合成音频 verify 命中', () => {
        hit = store.verify(speakerA2);
        assert.equal(hit.matched, true, `应命中，实际 score=${hit.score.toFixed(4)}`);
        assert.equal(hit.name, 'speaker-A');
      });

      test('不同说话人 verify 不误命中，且分数明显更低', () => {
        miss = store.verify(speakerB);
        assert.equal(miss.matched, false, `不应命中，实际 score=${miss.score.toFixed(4)}`);
        assert.ok(
          hit.score - miss.score > 0.1,
          `分差应明显，实际 命中=${hit.score.toFixed(4)} 不命中=${miss.score.toFixed(4)}`,
        );
      });

      test('注册第二个说话人后各自命中正确的人', () => {
        store.enroll('speaker-B', speakerB);
        const rA = store.verify(speakerA2);
        const rB = store.verify(synthWav({ seconds: 2.0, f0: 235, partials: [1, 0.2, 0.7, 0.05], noise: 0.05, seed: 99 }));
        assert.equal(rA.name, 'speaker-A', `A 应匹配 speaker-A，实际 ${rA.name} (${rA.score.toFixed(4)})`);
        assert.equal(rB.name, 'speaker-B', `B 应匹配 speaker-B，实际 ${rB.name} (${rB.score.toFixed(4)})`);
      });

      test('持久化后新实例（真模型）仍能命中', () => {
        const reloaded = new VoiceprintStore({ dir, modelPath: MODEL_PATH });
        assert.equal(reloaded.list().length, 2);
        const r = reloaded.verify(speakerA2);
        assert.equal(r.name, 'speaker-A');
        assert.equal(r.matched, true);
      });

      if (hit && miss) {
        console.log(
          `\n  实测分数：同人 ${hit.score.toFixed(4)} / 异人 ${miss.score.toFixed(4)} ` +
            `（阈值 ${store.threshold}，分差 ${(hit.score - miss.score).toFixed(4)}）`,
        );
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
} else {
  section('6. 真模型端到端 — 已跳过（--no-model）');
}

/* -------------------------------------------------------------------------- */
/* 汇总                                                                        */
/* -------------------------------------------------------------------------- */

console.log(`\n${'='.repeat(56)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.log('\n失败详情：');
  for (const f of failures) {
    console.log(`  - ${f.name}`);
    console.log(`    ${f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 3).join('\n    ') : f.err}`);
  }
}
console.log('='.repeat(56));
process.exit(failed > 0 ? 1 : 0);
