#!/usr/bin/env node
/**
 * Run the project's safety audit against **your** glossary.
 *
 * `asr-text-correction-safety` ships `audit.mjs`, which answers the only question that
 * matters for a layer like this: *does it damage text it was never asked to touch?* It
 * takes a module path and calls `correct(text)` on it.
 *
 * This shim is that module. Point the audit at it with your glossary:
 *
 *   node audit.mjs dict /path/to/examples/audit-shim.mjs
 *
 * The glossary file is JSON, either the array form or the whole config:
 *
 *   ["DSH", "GitHub", { "say": "FlClash", "heard": ["flcash"] }]
 *   { "terms": [ ... ], "options": { "fuzzyTerms": false } }
 *
 * Set `PERSONAL_DICTIONARY=/path/to/glossary.json` to override the default location, which
 * is `glossary.json` next to this file.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createDictionary } from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.PERSONAL_DICTIONARY || path.join(HERE, 'glossary.json');

if (!fs.existsSync(file)) {
  console.error(`audit-shim: no glossary at ${file}.`);
  console.error('Create one, or set PERSONAL_DICTIONARY to point at yours.');
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const config = Array.isArray(raw) ? { terms: raw } : raw;
const dictionary = createDictionary(config);

// `audit.mjs` prefers a `createCorrector` export and falls back to plain `correct`. We
// export the plain form on purpose: the audit should exercise the same entry point your
// application calls, not a lower-level one that skips validation.
export function correct(text) {
  return dictionary.correct(text);
}
