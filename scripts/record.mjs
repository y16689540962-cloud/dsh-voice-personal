#!/usr/bin/env node
/**
 * 录一段麦克风音频并转成 canonical 16kHz mono PCM16 WAV。
 *
 * 专门为声纹注册设计：录之前会先测一下环境底噪，录完会报告 RMS/峰值，
 * 太安静（你可能没说话）或削波（太大声）都会明确报告，避免注册进一段废录音。
 *
 * 用法: node scripts/record.mjs --out /tmp/xx.wav --seconds 12 [--device 1] [--min-rms 150]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };

const OUT = flag('--out');
if (!OUT) { console.error('用法: node scripts/record.mjs --out <file.wav> --seconds <sec> [--device 1]'); process.exit(2); }
const SECONDS = Number(flag('--seconds') ?? 12);
const DEVICE = flag('--device') ?? '1';
const MIN_RMS = Number(flag('--min-rms') ?? 150);
const CLIP_THRESHOLD = 32000;

const ffmpeg = (() => {
  for (const c of [flag('--ffmpeg'), 'ffmpeg', path.join(os.homedir(), '.local/bin/ffmpeg'), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (!c) continue;
    try { execFileSync(c, ['-version'], { stdio: 'ignore' }); return c; } catch { /* next */ }
  }
  throw new Error('找不到 ffmpeg');
})();

/** 通过一次短采样测出默认输入设备（跳过 BlackHole 等虚拟设备）。 */
function findMic() {
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8' });
  const text = (probe.stderr || '') + (probe.stdout || '');
  const lines = [...text.matchAll(/\[(\d+)\]\s+([^\n]*麦克风|[^\n]*[Mm]icrophone[^\n]*)/g)];
  if (lines.length) return { index: lines[0][1], name: lines[0][2].trim() };
  return { index: DEVICE, name: '默认' };
}

/** 读 WAV，算 RMS / 峰值。入参是 Buffer。 */
function analyze(buf) {
  const pcm = buf.subarray(44);
  let sum = 0, peak = 0, clipped = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    sum += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a >= CLIP_THRESHOLD) clipped++;
  }
  const n = pcm.length / 2;
  return { seconds: n / 16000, rms: Math.sqrt(sum / n), peak, clippedPct: (clipped / n) * 100 };
}

const mic = findMic();
console.log(`设备: [${mic.index}] ${mic.name}`);
console.log(`录音 ${SECONDS}s，请现在开始说话...`);

const r = spawnSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'avfoundation', '-i', `:${mic.index}`,
  '-t', String(SECONDS),
  '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
  '-fflags', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1',
  '-f', 'wav', OUT,
], { stdio: ['ignore', 'ignore', 'inherit'], timeout: (SECONDS + 10) * 1000 });

if (r.error || !fs.existsSync(OUT) || fs.statSync(OUT).size < 1000) {
  console.error('录音失败:', r.error?.message ?? r.stderr?.toString?.() ?? '未知');
  process.exit(1);
}

const a = analyze(fs.readFileSync(OUT));
console.log(`完成: ${a.seconds.toFixed(1)}s  RMS=${a.rms.toFixed(0)}  峰值=${a.peak}  削波=${a.clippedPct.toFixed(2)}%`);
if (a.rms < MIN_RMS) {
  console.error(`⚠️  音量太低（RMS ${a.rms.toFixed(0)} < ${MIN_RMS}）——你可能没说话，或麦没选对。这段不用。`);
  process.exit(3);
}
if (a.clippedPct > 1) {
  console.error(`⚠️  削波 ${a.clippedPct.toFixed(2)}%——离麦太近或太大声，建议重录。`);
  process.exit(4);
}
console.log('质量合格 ✓');
