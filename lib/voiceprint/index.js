/**
 * dsh-voice-personal / lib/voiceprint — 说话人声纹注册与校验
 *
 * 设计要点
 * - 纯 ESM，只依赖 node 内置模块 + DSH 自带的 sherpa-onnx-node（原生）。
 * - 全同步 API：sherpa 的 compute() 本身是同步的，避免调用方被迫 await。
 * - 模型不可用时构造不抛错，只把 `ready` 置为 false；enroll/verify 时再抛清晰错误，
 *   这样插件在没放模型的机器上仍然能被加载。
 * - 声纹向量持久化到 `<dir>/voiceprints.json`，写入用 tmp + fsync + rename 的原子写。
 *
 * 冻结接口（不要改签名）：
 *   new VoiceprintStore({ dir, modelPath, threshold = 0.62, logger })
 *   .ready  .list()  .enroll(name, wavBuffer)  .verify(wavBuffer)  .remove(name)  .clear()
 *
 * 额外可选项 `extractorFactory` 只用于自测注入假提取器，生产不要传。
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

export const STORE_VERSION = 1;
export const VOICEPRINTS_FILE = 'voiceprints.json';
export const WAV_HEADER_BYTES = 44;
export const SAMPLE_RATE = 16000;
export const MIN_DURATION_SECONDS = 0.5;
export const MIN_SAMPLES = Math.round(SAMPLE_RATE * MIN_DURATION_SECONDS);
export const DEFAULT_THRESHOLD = 0.62;

/** Electron 打包后 sherpa 包的 package.json 绝对路径（回退路径 3）。 */
export const SHERPA_ASAR_PACKAGE_JSON =
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/sherpa-onnx-node/package.json';

/* -------------------------------------------------------------------------- */
/* logger                                                                     */
/* -------------------------------------------------------------------------- */

function noop() {}

/** 把 logger（对象 / 函数 / undefined）规整成 {debug,info,warn,error}。缺省静默。 */
export function normalizeLogger(logger) {
  if (!logger) return { debug: noop, info: noop, warn: noop, error: noop };
  if (typeof logger === 'function') {
    return { debug: logger, info: logger, warn: logger, error: logger };
  }
  const bind = (key) => (typeof logger[key] === 'function' ? logger[key].bind(logger) : noop);
  return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') };
}

/* -------------------------------------------------------------------------- */
/* sherpa 模块解析                                                            */
/* -------------------------------------------------------------------------- */

let cachedResolution = null;

function sherpaCandidates() {
  const list = [];

  // 1) 正常解析（插件被 pnpm 链接进 ~/.dsh/profiles/.../node_modules 时会失败）
  list.push({
    id: 'local-require',
    detail: "createRequire(import.meta.url)('sherpa-onnx-node')",
    load: () => createRequire(import.meta.url)('sherpa-onnx-node'),
  });

  // 2) Electron 运行时：process.resourcesPath + /app.asar/dsh/node_modules/...
  const resourcesPath =
    typeof process !== 'undefined' && typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (resourcesPath) {
    const pkgJson = path.join(resourcesPath, 'app.asar', 'dsh', 'node_modules', 'sherpa-onnx-node', 'package.json');
    list.push({
      id: 'resources-path',
      detail: `createRequire(${pkgJson})('sherpa-onnx-node')`,
      load: () => createRequire(pkgJson)('sherpa-onnx-node'),
    });
  }

  // 3) 硬编码 App 安装路径
  list.push({
    id: 'app-asar-hardcoded',
    detail: `createRequire(${SHERPA_ASAR_PACKAGE_JSON})('sherpa-onnx-node')`,
    load: () => createRequire(SHERPA_ASAR_PACKAGE_JSON)('sherpa-onnx-node'),
  });

  // 4) 额外逃生口（非冻结要求，排在 1/2/3 之后，仅便于测试/迁移）
  const override = typeof process !== 'undefined' && process.env ? process.env.DSH_SHERPA_PACKAGE_JSON : '';
  if (override) {
    list.push({
      id: 'env-DSH_SHERPA_PACKAGE_JSON',
      detail: `createRequire(${override})('sherpa-onnx-node')`,
      load: () => createRequire(override)('sherpa-onnx-node'),
    });
  }

  return list;
}

/**
 * 按 1→2→3（→4）顺序尝试加载 sherpa-onnx-node。
 * @returns {{ok:boolean, sherpa:object|null, candidate:string|null, detail:string|null, attempts:Array}}
 */
export function resolveSherpa({ logger, refresh = false } = {}) {
  if (!refresh && cachedResolution && cachedResolution.ok) return cachedResolution;

  const log = normalizeLogger(logger);
  const attempts = [];

  for (const cand of sherpaCandidates()) {
    try {
      const mod = cand.load();
      if (!mod || typeof mod.SpeakerEmbeddingExtractor !== 'function') {
        throw new Error('模块加载成功但没有导出 SpeakerEmbeddingExtractor');
      }
      const result = { ok: true, sherpa: mod, candidate: cand.id, detail: cand.detail, attempts };
      cachedResolution = result;
      log.debug(`[voiceprint] sherpa-onnx-node 通过 ${cand.id} 解析成功`);
      return result;
    } catch (err) {
      attempts.push({
        candidate: cand.id,
        detail: cand.detail,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  const failed = { ok: false, sherpa: null, candidate: null, detail: null, attempts };
  cachedResolution = failed;
  return failed;
}

/** 加载 sherpa-onnx-node，失败抛带全部尝试记录的清晰错误。 */
export function loadSherpa({ logger } = {}) {
  const res = resolveSherpa({ logger });
  if (!res.ok) {
    const lines = res.attempts.map((a) => `  - ${a.candidate}: ${a.error}`).join('\n');
    throw new Error(
      `[voiceprint] 无法加载 sherpa-onnx-node（已尝试 ${res.attempts.length} 条路径，全部失败）:\n${lines}\n` +
        '提示：该原生模块只在 Electron 运行时可见（插件被安装在 ~/.dsh/profiles 时本地 require 必然失败）。',
    );
  }
  return res.sherpa;
}

/* -------------------------------------------------------------------------- */
/* WAV 解析                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 校验 canonical 16kHz / mono / PCM16 WAV 并转成 Float32Array。
 * 头必须正好 44 字节（fmt 在 12，data 在 36），与冻结的解析公式一致。
 */
export function parseWavToSamples(wavBuffer) {
  let buf = wavBuffer;
  if (!Buffer.isBuffer(buf)) {
    if (buf instanceof Uint8Array) {
      buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    } else {
      throw new TypeError('[voiceprint] wavBuffer 必须是 Buffer 或 Uint8Array');
    }
  }
  if (buf.length < WAV_HEADER_BYTES) {
    throw new Error(`[voiceprint] WAV 数据太短（${buf.length} 字节），至少需要 44 字节标准头`);
  }
  if (buf.toString('latin1', 0, 4) !== 'RIFF') throw new Error('[voiceprint] 非法 WAV：缺少 RIFF 标识');
  if (buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('[voiceprint] 非法 WAV：缺少 WAVE 标识');
  if (buf.toString('latin1', 12, 16) !== 'fmt ') throw new Error('[voiceprint] 非法 WAV：偏移 12 处不是 fmt 块');
  const fmtSize = buf.readUInt32LE(16);
  if (fmtSize < 16) throw new Error(`[voiceprint] 非法 WAV：fmt 块长度 ${fmtSize} < 16`);
  if (buf.toString('latin1', 36, 40) !== 'data') {
    throw new Error('[voiceprint] 非法 WAV：偏移 36 处不是 data 块（仅支持 44 字节标准头，不支持扩展块）');
  }

  const audioFormat = buf.readUInt16LE(20);
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);

  if (audioFormat !== 1) throw new Error(`[voiceprint] 非法 WAV：音频格式 ${audioFormat} 不是 PCM(1)`);
  if (channels !== 1) throw new Error(`[voiceprint] 非法 WAV：声道数 ${channels}，必须是单声道(1)`);
  if (sampleRate !== SAMPLE_RATE) {
    throw new Error(`[voiceprint] 非法 WAV：采样率 ${sampleRate}Hz，必须是 ${SAMPLE_RATE}Hz`);
  }
  if (bitsPerSample !== 16) throw new Error(`[voiceprint] 非法 WAV：位深 ${bitsPerSample}，必须是 16bit`);

  const declared = buf.readUInt32LE(40);
  const available = buf.byteLength - WAV_HEADER_BYTES;
  const dataBytes = Math.min(declared, available);
  if (dataBytes < 2) throw new Error('[voiceprint] 非法 WAV：data 块没有采样数据');

  const frameCount = Math.floor(dataBytes / 2);
  const view = new DataView(buf.buffer, buf.byteOffset + WAV_HEADER_BYTES, frameCount * 2);
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }

  if (samples.length < MIN_SAMPLES) {
    const secs = (samples.length / SAMPLE_RATE).toFixed(2);
    throw new Error(
      `[voiceprint] 音频太短：${secs}s < ${MIN_DURATION_SECONDS}s 下限（${MIN_SAMPLES} 采样点），拒绝送入原生提取器`,
    );
  }
  return samples;
}

/* -------------------------------------------------------------------------- */
/* 向量工具                                                                    */
/* -------------------------------------------------------------------------- */

/** L2 归一化（返回新数组）。零向量原样返回。 */
export function l2normalize(vec) {
  const out = Float32Array.from(vec);
  let sum = 0;
  for (let i = 0; i < out.length; i += 1) sum += out[i] * out[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < out.length; i += 1) out[i] /= norm;
  }
  return out;
}

/** 余弦相似度。维度不一致时抛错（调用方应先过滤）。 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`[voiceprint] 向量维度不一致：${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  const score = dot / denom;
  // 浮点误差可能给出 1.0000000000000002
  return score > 1 ? 1 : score < -1 ? -1 : score;
}

/* -------------------------------------------------------------------------- */
/* VoiceprintStore                                                             */
/* -------------------------------------------------------------------------- */

export class VoiceprintStore {
  #dir;
  #file;
  #modelPath;
  #threshold;
  #log;
  #extractorFactory;
  #extractor = null;
  #extractorError = null;
  #speakers = [];
  #loadWarning = null;

  /**
   * @param {object}  opts
   * @param {string}  opts.dir           声纹数据目录（会自动创建）
   * @param {string}  opts.modelPath     campplus.onnx 绝对路径
   * @param {number}  [opts.threshold]   判定阈值，默认 0.62
   * @param {object}  [opts.logger]      {debug,info,warn,error} 或函数
   * @param {Function}[opts.extractorFactory] 仅自测用：() => {createStream, compute}
   */
  constructor({ dir, modelPath, threshold = DEFAULT_THRESHOLD, logger, extractorFactory } = {}) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new TypeError('[voiceprint] new VoiceprintStore({ dir }) 需要一个非空字符串目录');
    }
    this.#dir = dir;
    this.#file = path.join(dir, VOICEPRINTS_FILE);
    this.#modelPath = typeof modelPath === 'string' && modelPath !== '' ? modelPath : null;
    this.#log = normalizeLogger(logger);
    this.#extractorFactory = typeof extractorFactory === 'function' ? extractorFactory : null;

    const persistedThreshold = this.#loadFromDisk();
    // 调用方显式传了非默认阈值就以调用方为准；否则沿用文件里的阈值。
    this.#threshold = threshold === DEFAULT_THRESHOLD && typeof persistedThreshold === 'number'
      ? persistedThreshold
      : threshold;

    this.#initExtractor();
  }

  /** 模型是否可用。 */
  get ready() {
    return this.#extractor !== null;
  }

  /** 当前阈值。 */
  get threshold() {
    return this.#threshold;
  }

  /** 模型不可用时的原因（ready 为 true 时是 null）。 */
  get unavailableReason() {
    return this.#extractor ? null : (this.#extractorError && this.#extractorError.message) || '未知原因';
  }

  /** 读取 voiceprints.json 失败时的告警（正常为 null）。 */
  get loadWarning() {
    return this.#loadWarning;
  }

  /** @returns {Array<{name:string,dim:number,createdAt:string,samples:number}>} 按注册顺序。 */
  list() {
    return this.#speakers.map((s) => ({
      name: s.name,
      dim: s.dim,
      createdAt: s.createdAt,
      samples: s.samples,
    }));
  }

  /**
   * 注册/更新说话人。同一 name 重复注册时对（L2 归一化后的）向量做增量平均，
   * `samples` 记录参与平均的样本数。
   * @returns {{name:string, dim:number, samples:number}}
   */
  enroll(name, wavBuffer) {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (clean === '') throw new TypeError('[voiceprint] enroll(name, wavBuffer): name 必须是非空字符串');
    if (clean.length > 64) throw new Error('[voiceprint] enroll: name 长度不能超过 64');

    const samples = parseWavToSamples(wavBuffer);
    const embedding = l2normalize(this.#embed(samples));
    const dim = embedding.length;

    const existing = this.#speakers.find((s) => s.name === clean);
    if (existing) {
      if (existing.dim !== dim) {
        throw new Error(`[voiceprint] enroll: 维度不一致，已有 ${existing.dim} 维，新样本 ${dim} 维`);
      }
      const prev = l2normalize(existing.embedding);
      const n = Number.isFinite(existing.samples) && existing.samples >= 1 ? existing.samples : 1;
      const merged = new Float32Array(dim);
      for (let i = 0; i < dim; i += 1) merged[i] = (prev[i] * n + embedding[i]) / (n + 1);
      const final = l2normalize(merged);
      existing.embedding = Array.from(final);
      existing.dim = dim;
      existing.samples = n + 1;
      this.#saveToDisk();
      this.#log.info(`[voiceprint] 更新说话人 ${clean}（样本数 ${existing.samples}）`);
      return { name: clean, dim, samples: existing.samples };
    }

    this.#speakers.push({
      name: clean,
      dim,
      embedding: Array.from(embedding),
      createdAt: new Date().toISOString(),
      samples: 1,
    });
    this.#saveToDisk();
    this.#log.info(`[voiceprint] 注册说话人 ${clean}（${dim} 维）`);
    return { name: clean, dim, samples: 1 };
  }

  /**
   * 校验说话人。没有任何已注册说话人时直接返回未命中（不需要模型）。
   * @returns {{matched:boolean, name:string|null, score:number, best:{name:string,score:number,dim:number}|null}}
   */
  verify(wavBuffer) {
    const samples = parseWavToSamples(wavBuffer);
    if (this.#speakers.length === 0) {
      return { matched: false, name: null, score: 0, best: null };
    }

    const embedding = this.#embed(samples);
    let best = null;
    for (const speaker of this.#speakers) {
      if (speaker.dim !== embedding.length) {
        this.#log.warn(
          `[voiceprint] 跳过 ${speaker.name}：维度 ${speaker.dim} 与本次 ${embedding.length} 不一致`,
        );
        continue;
      }
      const score = cosineSimilarity(embedding, speaker.embedding);
      if (!best || score > best.score) best = { name: speaker.name, score, dim: embedding.length };
    }

    if (!best) return { matched: false, name: null, score: 0, best: null };
    return {
      matched: best.score >= this.#threshold,
      name: best.name,
      score: best.score,
      best: { name: best.name, score: best.score, dim: best.dim },
    };
  }

  /** 删除说话人。@returns {boolean} 是否真的删掉了 */
  remove(name) {
    const clean = typeof name === 'string' ? name.trim() : '';
    const idx = this.#speakers.findIndex((s) => s.name === clean);
    if (idx === -1) return false;
    this.#speakers.splice(idx, 1);
    this.#saveToDisk();
    this.#log.info(`[voiceprint] 删除说话人 ${clean}`);
    return true;
  }

  /** 清空全部说话人并落盘。 */
  clear() {
    this.#speakers = [];
    this.#saveToDisk();
    this.#log.info('[voiceprint] 已清空全部声纹');
  }

  /* ---------------------------------------------------------------- 内部 */

  #initExtractor() {
    if (this.#extractorFactory) {
      try {
        const fake = this.#extractorFactory({ modelPath: this.#modelPath, logger: this.#log });
        if (!fake || typeof fake.createStream !== 'function' || typeof fake.compute !== 'function') {
          throw new Error('extractorFactory 返回的对象缺少 createStream/compute');
        }
        this.#extractor = fake;
      } catch (err) {
        this.#extractorError = err;
      }
      return;
    }

    if (!this.#modelPath) {
      this.#extractorError = new Error('未提供 modelPath（campplus.onnx 路径）');
      return;
    }
    if (!fs.existsSync(this.#modelPath)) {
      this.#extractorError = new Error(`声纹模型不存在：${this.#modelPath}`);
      return;
    }

    try {
      const sherpa = loadSherpa({ logger: this.#log });
      this.#extractor = new sherpa.SpeakerEmbeddingExtractor({
        model: this.#modelPath,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      });
    } catch (err) {
      this.#extractorError = err;
      this.#log.error(`[voiceprint] 声纹模型加载失败：${err && err.message ? err.message : err}`);
    }
  }

  #embed(samples) {
    if (!this.#extractor) {
      throw new Error(`[voiceprint] 声纹提取器不可用：${this.unavailableReason}`);
    }
    const stream = this.#extractor.createStream();
    try {
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      const embedding = this.#compute(stream);
      if (!embedding || typeof embedding.length !== 'number' || embedding.length === 0) {
        throw new Error('[voiceprint] 提取器返回了空向量');
      }
      // 从原生内存拷贝出来，避免持有 native 视图
      return Float32Array.from(embedding);
    } finally {
      try {
        if (typeof stream.free === 'function') stream.free();
      } catch {
        /* 释放失败不影响结果 */
      }
    }
  }

  /**
   * 调 native compute，并规避 Electron 的 external buffer 限制。
   *
   * sherpa-onnx-node 的 `compute(stream, enableExternalBuffer = true)` 默认走
   * 零拷贝外部缓冲；Electron 的 V8 配置禁止外部缓冲，会抛
   * "External buffers are not allowed"。因此优先显式传 false 拿普通堆缓冲。
   * 若提取器只接受单参数（自测注入的假提取器），回退到无第二参调用；
   * 真出错时错误照常抛出，不会掩盖。
   */
  #compute(stream) {
    const compute = this.#extractor.compute.bind(this.#extractor);
    try {
      return compute(stream, false);
    } catch (err) {
      if (/external buffer/i.test(err && err.message ? err.message : '')) throw err;
      return compute(stream);
    }
  }

  #saveToDisk() {
    fs.mkdirSync(this.#dir, { recursive: true });
    const payload = {
      version: STORE_VERSION,
      threshold: this.#threshold,
      speakers: this.#speakers,
    };
    const json = JSON.stringify(payload, null, 2);
    const tmp = `${this.#file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, json, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.#file);
  }

  /** @returns {number|null} 文件里的阈值（没有则 null） */
  #loadFromDisk() {
    this.#speakers = [];
    this.#loadWarning = null;

    try {
      fs.mkdirSync(this.#dir, { recursive: true });
    } catch (err) {
      this.#loadWarning = `创建目录失败：${err && err.message ? err.message : err}`;
      this.#log.warn(`[voiceprint] ${this.#loadWarning}`);
      return null;
    }

    if (!fs.existsSync(this.#file)) return null;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch (err) {
      this.#loadWarning = `读取 ${this.#file} 失败：${err && err.message ? err.message : err}`;
      this.#log.error(`[voiceprint] ${this.#loadWarning}；以空库启动（不会覆盖原文件，直到下次写入）`);
      return null;
    }

    const raw = Array.isArray(data && data.speakers) ? data.speakers : [];
    let dropped = 0;
    for (const item of raw) {
      const normalized = normalizeSpeakerRecord(item);
      if (normalized) this.#speakers.push(normalized);
      else dropped += 1;
    }
    if (dropped > 0) {
      this.#loadWarning = `忽略了 ${dropped} 条损坏的声纹记录`;
      this.#log.warn(`[voiceprint] ${this.#loadWarning}`);
    }

    const t = data && data.threshold;
    return typeof t === 'number' && Number.isFinite(t) ? t : null;
  }
}

function normalizeSpeakerRecord(item) {
  if (!item || typeof item !== 'object') return null;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (name === '') return null;
  if (!Array.isArray(item.embedding) || item.embedding.length === 0) return null;
  const embedding = new Float32Array(item.embedding.length);
  for (let i = 0; i < item.embedding.length; i += 1) {
    const v = item.embedding[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    embedding[i] = v;
  }
  const samples = Number.isFinite(item.samples) && item.samples >= 1 ? Math.floor(item.samples) : 1;
  const createdAt =
    typeof item.createdAt === 'string' && item.createdAt !== '' ? item.createdAt : new Date().toISOString();
  return { name, dim: embedding.length, embedding: Array.from(embedding), createdAt, samples };
}
