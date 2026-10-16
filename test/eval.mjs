#!/usr/bin/env node
/**
 * Frozen-corpus evaluation for the correction layer — the A/B harness.
 *
 * Why this exists
 * ---------------
 * `audit.mjs` answers "does the layer damage text it was never asked to touch?" over
 * synthetic and dictionary corpora. It says nothing about whether the layer actually
 * *fixes* the mis-hearings it was built for. Those are two different questions and they
 * pull in opposite directions: every step that makes the layer safer also makes it miss
 * more. Measuring only one of them lets you tune blind.
 *
 * So this harness scores four things per case, and the fourth is the one that matters:
 *
 *   fixed          the case asked for a change and got exactly the expected text
 *   missed         the case asked for a change and got the input back unchanged  (FN)
 *   wrong          the case asked for a change and got *something else*        (FN, worse)
 *   damaged        a keep:true case was altered — already-correct text changed  (FP)
 *
 * `damaged` and non-idempotence are safety failures: the harness exits 1 on them even
 * under `--allow-gaps`. Everything else is an accuracy gap.
 *
 * The corpus is frozen
 * --------------------
 * `test/corpus/regression.json` is a checked-in literal, not a snapshot of current
 * output. `expect` was written from what *should* happen; a mismatch is therefore a
 * finding, not a stale expectation. Never regenerate it from the implementation — that
 * would turn the suite into a change-detector and destroy its only use.
 *
 * Every run records the SHA-256 of the corpus file. `--compare` refuses to diff two runs
 * whose corpora differ, because a delta across different sample sets means nothing. This
 * is the same discipline as keeping an eval set fixed across prompt revisions.
 *
 * Usage
 * -----
 *   node scripts/eval.mjs                          # run, label "current"
 *   node scripts/eval.mjs --label before-fix       # run under a name
 *   node scripts/eval.mjs --compare before-fix current
 *   node scripts/eval.mjs --report-only --label before-fix
 *   node scripts/eval.mjs --show fix-misspelling   # print case text for one stratum
 *   node scripts/eval.mjs --allow-gaps             # exit 0 on FN, still 1 on FP
 *
 * Text is personal. Results live in `.eval/` (git-ignored) and the terminal prints counts
 * and case *ids* only, never transcript text, unless `--show` asks for a stratum.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DEFAULT_CORPUS = path.join(ROOT, 'test', 'corpus', 'regression.json');
const DEFAULT_OUT = path.join(ROOT, '.eval');
const DEFAULT_MODULE = path.join(ROOT, 'lib', 'correct', 'index.js');

// ── arguments ───────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const label = flag('label', 'current');
const corpusPath = flag('corpus', DEFAULT_CORPUS);
const outDir = flag('out', DEFAULT_OUT);
const modulePath = flag('module', DEFAULT_MODULE);
const showStratum = flag('show', null);
const allowGaps = has('allow-gaps');
const reportOnly = has('report-only');
const compareIdx = argv.indexOf('--compare');
const comparePair = compareIdx === -1 ? null : [argv[compareIdx + 1], argv[compareIdx + 2]];

// ── loading ─────────────────────────────────────────────────────────────────────────

function readCorpus(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  const fingerprint = crypto.createHash('sha256').update(raw).digest('hex');
  const ids = new Set();
  for (const c of data.cases) {
    if (!c.id) throw new Error(`corpus case without id: ${JSON.stringify(c).slice(0, 80)}`);
    if (ids.has(c.id)) throw new Error(`duplicate corpus case id: ${c.id}`);
    ids.add(c.id);
    if (c.keep === true && 'expect' in c) {
      throw new Error(`${c.id}: keep:true and expect are mutually exclusive`);
    }
    if (c.keep !== true && typeof c.expect !== 'string') {
      throw new Error(`${c.id}: needs either keep:true or a string expect`);
    }
  }
  return { data, fingerprint, file };
}

async function loadCorrector() {
  const mod = await import(pathToFileURL(modulePath).href);
  if (typeof mod.createCorrector !== 'function') {
    throw new Error(`${modulePath} exports no createCorrector()`);
  }
  return { corrector: mod.createCorrector(), version: mod.CORRECT_VERSION ?? null };
}

const run = (corrector, input) => {
  const r = corrector.correct(input);
  return typeof r === 'string' ? r : r?.text ?? '';
};

// ── scoring ─────────────────────────────────────────────────────────────────────────

const CLASSES = ['fixed', 'missed', 'wrong', 'damaged', 'nonIdempotent'];

function score({ data }, corrector) {
  const byStratum = new Map();
  const failures = [];
  const idempotenceViolations = [];

  const bump = (stratum, cls) => {
    if (!byStratum.has(stratum)) {
      byStratum.set(stratum, Object.fromEntries(CLASSES.map((c) => [c, 0])));
    }
    byStratum.get(stratum)[cls]++;
  };

  for (const c of data.cases) {
    const input = c.input;
    const out = run(corrector, input);
    const stratum = c.stratum ?? 'unstratified';

    // Idempotence is a global property, checked on every input regardless of its stratum.
    const twice = run(corrector, out);
    const thrice = run(corrector, twice);
    if (twice !== out || thrice !== out) {
      bump('idempotence', 'nonIdempotent');
      idempotenceViolations.push(c.id);
    }

    if (c.keep === true) {
      if (out === input) bump(stratum, 'fixed');
      else {
        bump(stratum, 'damaged');
        failures.push({ id: c.id, stratum, cls: 'damaged', input, expected: input, got: out });
      }
      continue;
    }

    if (out === c.expect) {
      bump(stratum, 'fixed');
    } else if (out === input) {
      bump(stratum, 'missed');
      failures.push({ id: c.id, stratum, cls: 'missed', input, expected: c.expect, got: out });
    } else {
      bump(stratum, 'wrong');
      failures.push({ id: c.id, stratum, cls: 'wrong', input, expected: c.expect, got: out });
    }
  }

  return { byStratum, failures, idempotenceViolations };
}

// ── reporting ───────────────────────────────────────────────────────────────────────

function table(byStratum) {
  const names = [...byStratum.keys()];
  const totals = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  let cases = 0;
  for (const n of names) {
    for (const c of CLASSES) totals[c] += byStratum.get(n)[c];
    cases += CLASSES.reduce((s, c) => s + byStratum.get(n)[c], 0) - byStratum.get(n).nonIdempotent;
  }
  const rows = names.map((n) => {
    const v = byStratum.get(n);
    return [n, v.fixed, v.missed, v.wrong, v.damaged, v.nonIdempotent];
  });
  rows.push(['TOTAL', totals.fixed, totals.missed, totals.wrong, totals.damaged, totals.nonIdempotent]);
  const widths = [0, 1, 2, 3, 4, 5].map((i) =>
    Math.max(...rows.map((r) => String(r[i]).length), ['stratum', 'fixed', 'missed', 'wrong', 'damaged', 'idem✗'][i].length));
  const line = (r) => r.map((cell, i) => String(cell).padEnd(widths[i])).join('  ');
  console.log('');
  console.log(line(['stratum', 'fixed', 'missed', 'wrong', 'damaged', 'idem✗']));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log(`\ncases: ${cases}`);
  return totals;
}

function printFailures(failures, showStratum) {
  if (!failures.length) return;
  const order = { damaged: 0, wrong: 1, missed: 2 };
  const sorted = [...failures].sort((a, b) => order[a.cls] - order[b.cls]);
  const visible = showStratum ? sorted.filter((f) => f.stratum === showStratum) : sorted;

  console.log('\nfailures:');
  for (const f of visible) {
    console.log(`  [${f.cls}] ${f.id}`);
    if (showStratum) {
      console.log(`      input    ${JSON.stringify(f.input)}`);
      console.log(`      expected ${JSON.stringify(f.expected)}`);
      console.log(`      got      ${JSON.stringify(f.got)}`);
    }
  }
  if (showStratum && visible.length !== sorted.length) {
    console.log(`  (${sorted.length - visible.length} failure(s) in other strata hidden)`);
  }
  if (!showStratum) {
    const strata = [...new Set(sorted.map((f) => f.stratum))];
    console.log(`  run with --show <stratum> to print the text. strata with failures: ${strata.join(', ')}`);
  }
}

// ── compare ─────────────────────────────────────────────────────────────────────────

function loadResult(name) {
  const file = path.join(outDir, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`no result named "${name}" in ${outDir}. Run with --label ${name} first.`);
  }
  return { ...JSON.parse(fs.readFileSync(file, 'utf8')), file };
}

function compare(a, b) {
  if (a.corpusSha256 !== b.corpusSha256) {
    console.error('refusing to compare: the two runs used different corpora.');
    console.error(`  ${a.label}: ${a.corpusSha256.slice(0, 12)}  (${a.corpusCases} cases)`);
    console.error(`  ${b.label}: ${b.corpusSha256.slice(0, 12)}  (${b.corpusCases} cases)`);
    console.error('A delta across different sample sets is not a measurement. Freeze the corpus first.');
    process.exit(2);
  }
  const names = [...new Set([...Object.keys(a.byStratum), ...Object.keys(b.byStratum)])];
  const rows = names.map((n) => {
    const av = a.byStratum[n] ?? Object.fromEntries(CLASSES.map((c) => [c, 0]));
    const bv = b.byStratum[n] ?? Object.fromEntries(CLASSES.map((c) => [c, 0]));
    return [n, ...CLASSES.map((c) => bv[c] - av[c])];
  });
  const totals = CLASSES.map((c) =>
    Object.values(a.byStratum).reduce((s, v) => s + v[c], 0) - 0
    , 0);
  const totA = CLASSES.map((c) => Object.values(a.byStratum).reduce((s, v) => s + v[c], 0));
  const totB = CLASSES.map((c) => Object.values(b.byStratum).reduce((s, v) => s + v[c], 0));
  rows.push(['TOTAL', ...CLASSES.map((_, i) => totB[i] - totA[i])]);

  const header = ['stratum', ...CLASSES];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((cell, i) => String(cell).padEnd(widths[i])).join('  ');
  console.log(`\n${a.label}  ->  ${b.label}   (corpus ${a.corpusSha256.slice(0, 12)})\n`);
  console.log(line(header));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log('\nfixed up / missed down is progress. damaged or idem✗ going up is a regression.');

  const damaged = (b.byStratum.idempotence?.nonIdempotent ?? 0)
    + Object.values(b.byStratum).reduce((s, v) => s + v.damaged, 0);
  void totals;
  return damaged;
}

// ── main ────────────────────────────────────────────────────────────────────────────

const corpus = readCorpus(corpusPath);

if (reportOnly) {
  const r = loadResult(label);
  console.log(`label   : ${r.label}`);
  console.log(`corpus  : ${r.corpusSha256.slice(0, 12)}  (${r.corpusCases} cases)`);
  console.log(`created : ${r.createdAt}`);
  table(new Map(Object.entries(r.byStratum)));
  printFailures(r.failures ?? [], showStratum);
  process.exit(0);
}

if (comparePair && comparePair[0] && comparePair[1]) {
  process.exit(compare(loadResult(comparePair[0]), loadResult(comparePair[1])) ? 1 : 0);
}

const { corrector, version } = await loadCorrector();
const { byStratum, failures, idempotenceViolations } = score(corpus, corrector);

console.log(`label   : ${label}`);
console.log(`module  : ${modulePath}`);
console.log(`corpus  : ${corpusPath}`);
console.log(`sha256  : ${corpus.fingerprint}`);
console.log(`cases   : ${corpus.data.cases.length}   corrector version: ${version ?? 'n/a'}`);

const totals = table(byStratum);
printFailures(failures, showStratum);

fs.mkdirSync(outDir, { recursive: true });
const resultFile = path.join(outDir, `${label}.json`);
fs.writeFileSync(resultFile, `${JSON.stringify({
  label,
  createdAt: new Date().toISOString(),
  corpusPath,
  corpusSha256: corpus.fingerprint,
  corpusCases: corpus.data.cases.length,
  modulePath,
  correctorVersion: version,
  node: process.version,
  byStratum: Object.fromEntries(byStratum),
  failures,
  idempotenceViolations,
}, null, 2)}\n`);
console.log(`\nresult  : ${resultFile}`);

const safety = totals.damaged + totals.nonIdempotent;
const accuracy = totals.missed + totals.wrong;
console.log('');
if (safety) {
  console.log(`FAIL — ${safety} safety defect(s): ${totals.damaged} damaged, ${totals.nonIdempotent} non-idempotent.`);
  console.log('These are the classes that must never regress. Fix before anything else.');
  process.exit(1);
}
if (accuracy && !allowGaps) {
  console.log(`GAPS — ${accuracy} accuracy gap(s): ${totals.missed} missed, ${totals.wrong} wrong.`);
  console.log('No safety defect. Re-run with --allow-gaps to treat these as known gaps.');
  process.exit(1);
}
console.log(accuracy ? `PASS (safety) — ${accuracy} known accuracy gap(s) tolerated.` : 'PASS — all cases clean.');
