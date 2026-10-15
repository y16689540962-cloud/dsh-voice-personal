# Skills

Reusable agent skills derived from this project. Kept in this repository so each claim in a
skill links to the evidence that produced it.

## asr-text-correction-safety

Design and audit rules for any layer that rewrites text after recognition.

Published on [ClawHub](https://clawhub.ai/skills/asr-text-correction-safety) and mirrored to
[SkillHub](https://skillhub.cn).

The skill is a distillation of [docs/DESIGN.md](../docs/DESIGN.md) and
[docs/ADVERSARIAL.md](../docs/ADVERSARIAL.md): why phonetic matching of terms is unsound, and
the seven rules that replaced it in this implementation.

`scripts/audit.mjs` implements the three checks that found the nine defect classes. It is
validated in both directions — clean against the fixed implementation, and it reproduces
every defect class against the pre-fix revision:

```bash
node skills/asr-text-correction-safety/scripts/audit.mjs all
node skills/asr-text-correction-safety/scripts/audit.mjs all <path-to-any-corrector.js>
```

Install from ClawHub:

```bash
clawhub install asr-text-correction-safety
```
