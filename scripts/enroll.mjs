#!/usr/bin/env node
/**
 * Enrol or check a voiceprint from an audio file.
 *
 * The voiceprint feature needs the user's real voice, and dictation audio is transient by
 * design (never written to disk), so enrolment reads a file the user supplies instead.
 * Any format ffmpeg can decode is accepted; it is converted to the canonical
 * 16 kHz mono PCM16 WAV the recogniser and the embedding model both expect.
 *
 * Usage:
 *   node scripts/enroll.mjs --name me --audio me.m4a
 *   node scripts/enroll.mjs --name me --audio me.m4a --check me2.m4a
 *   node scripts/enroll.mjs --list
 *   node scripts/enroll.mjs --remove me
 *
 * Recording tips (these matter more than any threshold setting):
 *   - 10-30 seconds of continuous, natural speech in a quiet room.
 *   - One person only, no background music or overlapping voices.
 *   - Use the same microphone you dictate with.
 *   - Avoid clipping; do not whisper.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { VoiceprintStore } from '../lib/voiceprint/index.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

// `URL.pathname` stays percent-encoded, which breaks any path containing non-ASCII
// characters (this project lives under a Chinese-named directory). fileURLToPath decodes.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = flag('--model') || path.join(HERE, '..', 'models', 'campplus.onnx');
const DATA_DIR = flag('--data-dir') || path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'voice-personal');

const store = new VoiceprintStore({
  dir: DATA_DIR,
  modelPath: MODEL,
  threshold: Number(flag('--threshold') ?? 0.62),
  logger: { warn: (...a) => console.error('[warn]', ...a) },
});

/** Locate ffmpeg without assuming a PATH layout. */
function findFfmpeg() {
  const explicit = flag('--ffmpeg');
  if (explicit) return explicit;
  const candidates = [
    'ffmpeg',
    path.join(os.homedir(), '.local', 'bin', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' });
      return c;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Convert any decodable audio into canonical 16 kHz mono PCM16 WAV bytes.
 * @returns {Buffer}
 */
function toCanonicalWav(file) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    throw new Error(
      '找不到 ffmpeg，无法转换音频格式。请安装 ffmpeg（brew install ffmpeg），'
      + '或先用 --audio 直接提供一个 16kHz 单声道 PCM16 WAV 文件。',
    );
  }
  const out = path.join(os.tmpdir(), `vp-enroll-${process.pid}.wav`);
  try {
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', file,
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      // ffmpeg writes a LIST/INFO metadata chunk by default, which pushes `data` past
      // offset 36 and breaks the strict 44-byte canonical header the recogniser and the
      // embedding model both require. bitexact plus dropping metadata yields a bare header.
      '-fflags', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1',
      '-f', 'wav', out,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    return fs.readFileSync(out);
  } finally {
    try { fs.unlinkSync(out); } catch { /* best effort */ }
  }
}

/** Read a file and return canonical WAV bytes, converting when needed. */
function loadAudio(file) {
  if (!fs.existsSync(file)) throw new Error(`音频文件不存在：${file}`);
  const buf = fs.readFileSync(file);
  // Accept only a strict 44-byte canonical header. A RIFF/WAVE magic alone is not
  // enough: ffmpeg and other tools add LIST/INFO chunks that shift `data` and would be
  // rejected deeper in the parser with a less actionable message.
  const canonical = buf.length >= 44
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WAVE'
    && buf.toString('ascii', 12, 16) === 'fmt '
    && buf.readUInt32LE(16) === 16
    && buf.readUInt16LE(20) === 1
    && buf.readUInt16LE(22) === 1
    && buf.readUInt32LE(24) === 16000
    && buf.readUInt32LE(28) === 32000
    && buf.readUInt16LE(32) === 2
    && buf.readUInt16LE(34) === 16
    && buf.toString('ascii', 36, 40) === 'data';
  if (canonical) return buf;
  return toCanonicalWav(file);
}

const listOnly = args.includes('--list');
const removeName = flag('--remove');

if (listOnly) {
  const speakers = store.list();
  console.log(`声纹目录：${DATA_DIR}`);
  console.log(`模型：${MODEL}`);
  console.log(`模型可用：${store.ready}`);
  console.log(`已注册 ${speakers.length} 个说话人：`);
  for (const s of speakers) {
    console.log(`  - ${s.name}  (dim=${s.dim}, 样本=${s.samples}, 注册于 ${s.createdAt})`);
  }
  process.exit(0);
}

if (removeName) {
  const ok = store.remove(removeName);
  console.log(ok ? `已删除声纹：${removeName}` : `没有找到声纹：${removeName}`);
  process.exit(ok ? 0 : 1);
}

const name = flag('--name');
const audio = flag('--audio');
const checkAudio = flag('--check');

if (!name || !audio) {
  console.error('用法：');
  console.error('  node scripts/enroll.mjs --name <名字> --audio <音频文件> [--check <另一段音频>]');
  console.error('  node scripts/enroll.mjs --list');
  console.error('  node scripts/enroll.mjs --remove <名字>');
  process.exit(2);
}

if (!store.ready) {
  console.error(`声纹模型不可用：${MODEL}`);
  console.error('请在 DeepSeek Harness 的 Electron 运行时下执行本脚本，例如：');
  console.error(`  ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" scripts/enroll.mjs --name ... --audio ...`);
  process.exit(1);
}

console.log(`转换并读取：${audio}`);
const wav = loadAudio(audio);
console.log(`音频：${(wav.length - 44) / 32000} 秒`);

const result = store.enroll(name, wav);
console.log(`已注册声纹：${result.name}（dim=${result.dim}, 样本=${result.samples}）`);
console.log(`写入：${path.join(DATA_DIR, 'voiceprints.json')}`);

if (checkAudio) {
  console.log(`\n用另一段音频校验：${checkAudio}`);
  const wav2 = loadAudio(checkAudio);
  const v = store.verify(wav2);
  console.log(`  最佳匹配：${v.name ?? '无'}  相似度：${v.score?.toFixed?.(4) ?? 'n/a'}  阈值：${store.threshold ?? 0.62}`);
  console.log(`  判定：${v.matched ? '命中（同一个人）' : '未命中（不是同一个人）'}`);
  console.log('\n提示：不同录音设备/环境会让分数下降。若同一个人被判未命中，');
  console.log('      用同设备录更长、更安静的样本重新注册，或适当下调阈值。');
}

console.log('\n下一步：在 cordis.patch.yml 里把 requireEnrolledSpeaker 设为 true，重启 Harness。');
