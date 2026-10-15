## Description:

Design and audit rules for any layer that rewrites text after recognition — dictation
cleanup, OCR correction, autocorrect, transliteration, terminology normalization, filler
removal — so it cannot silently change what the user actually said.

Most of the content is the negative result: **why phonetic and pinyin matching of terms is
unsound**, with the arithmetic. Twelve two-syllable pinyin pairs matched 160,454 distinct
two-character Chinese strings, rewriting `人物关系很复杂` into `任务关系很复杂` and
`这是一部好电影` into `这是异步好电影`. No threshold repairs that, because the missing
information is sentence context and a phonetic key has already discarded it.

Seven rules follow, each one a defect found by an adversarial audit of a shipping
dictation-correction layer: exact matching over phonetic matching, masking protected spans
once before every pass, idempotence as a correctness property, whitespace as content, filler
deletion gated by a corpus-derived whitelist plus per-occurrence context, guards enforced in
the index builder rather than documented in data, and fail-open at the boundary.

Includes a 14-line review checklist and a runnable audit script implementing the three checks
that found the defects (dictionary false-positive scan over 210,604 words, 4,000-case
idempotence fuzz, and collision enumeration). The script is validated both ways: it reports
clean against the fixed implementation and reproduces every defect class against the
pre-fix revision.

This skill is ready for commercial/non-commercial use.

## Publisher:

[y16689540962-cloud](https://clawhub.ai/user/y16689540962-cloud)

### License/Terms of Use:

MIT

## Use Case:

Developers and agents use this skill when building or reviewing a text post-processing step
that sits between recognition and the user. It applies to speech-to-text cleanup, OCR output
correction, autocorrect and autocomplete, transliteration, terminology normalization,
punctuation restoration, and filler-word removal.

Typical triggers: a phonetic, pinyin, fuzzy or edit-distance matcher is proposed for
correcting recognized text; a correction layer is reported to be "changing what I said"; a
glossary of terms needs to be reviewed for over-reach; or an audit of an existing cleanup
pipeline is being planned.

The skill's central claim is that correction failures are asymmetric — a missed correction
costs an edit, a false correction silently changes meaning — so the primary invariant is
"never corrupt already-correct text" and accuracy is secondary. Every rule and the checklist
derive from that ordering.

### Deployment Geography for Use:

Global
