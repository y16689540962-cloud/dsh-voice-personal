/**
 * Pinyin lookup for Chinese homophone correction.
 *
 * The table is a packed string: `字pinyin字pinyin...`, where each CJK character is
 * followed by its ASCII pinyin (tone stripped, `ü` written as `v`). This keeps the
 * whole 26k-character table around 160 KB instead of a multi-megabyte JSON object.
 *
 * Tone information is deliberately discarded: speech recognition homophone errors
 * (`工作台` -> `工作太`) preserve the syllable but may shift the tone, so comparing
 * toneless pinyin catches more real errors than comparing toned pinyin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = path.join(HERE, '..', 'data', 'pinyin-table.txt');

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

let table = null;

/** Load and memoise the packed pinyin table. @returns {Map<string, string>} */
export function loadTable() {
  if (table) return table;
  const raw = fs.readFileSync(TABLE_PATH, 'utf8');
  const map = new Map();
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (!CJK.test(ch)) { i++; continue; }
    i++;
    let py = '';
    while (i < raw.length && !CJK.test(raw[i])) { py += raw[i]; i++; }
    if (py) map.set(ch, py);
  }
  table = map;
  return map;
}

/** Pinyin of one character, or null when it has none. @returns {string|null} */
export function pinyinOf(ch) {
  return loadTable().get(ch) ?? null;
}

/**
 * Toneless pinyin of the CJK characters in `text`, concatenated.
 * Non-CJK characters are skipped so callers can align by CJK length.
 * @returns {string}
 */
export function toPinyin(text) {
  const map = loadTable();
  let out = '';
  for (const ch of text) {
    const py = map.get(ch);
    if (py) out += py;
  }
  return out;
}

/**
 * Pinyin of the CJK characters in `text` as a per-character array.
 * @returns {string[]}
 */
export function toPinyinArray(text) {
  const map = loadTable();
  const out = [];
  for (const ch of text) {
    const py = map.get(ch);
    if (py) out.push(py);
  }
  return out;
}

/** True when `ch` is a CJK ideograph covered by the table. */
export function isCjk(ch) {
  return CJK.test(ch);
}

/** Count of CJK characters in `text`. */
export function cjkLength(text) {
  let n = 0;
  for (const ch of text) if (CJK.test(ch)) n++;
  return n;
}

/** Table size, for diagnostics. */
export function tableSize() {
  return loadTable().size;
}
