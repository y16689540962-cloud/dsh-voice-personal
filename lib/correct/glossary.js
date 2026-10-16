/**
 * Personal glossary — the user's own vocabulary, and the mis-hearings it fixes.
 *
 * Every entry is backed by a string that actually appears in the user's session history
 * (`~/.dsh/sessions/*\/session.jsonl.zstd`). `evidence` quotes it, so an entry traces to
 * observed behaviour rather than to a guess.
 *
 * ## Why there are no Chinese homophone pairs
 *
 * An earlier revision rewrote Chinese by toneless pinyin, so `差件` -> `插件` and
 * `工作太` -> `工作台`. That mechanism was removed because it is unsound, not because it
 * was mistuned. A 2-syllable pinyin key matches *every* word with that reading, and
 * Chinese is full of legitimate homophones:
 *
 *   人物 / 任务  (rènwù)      一部 / 异步  (yībù)
 *   信条 / 心跳  (xìntiáo)    便衣 / 编译  (biànyī)
 *   接点 / 接口  (jiēdiǎn)    配制 / 配置  (pèizhì)
 *
 * So `人物关系很复杂` became `任务关系很复杂`, and `这是一部好电影` became `这是异步好电影`.
 * Across the 12 two-syllable pairs that shipped, 160,454 distinct 2-character strings were
 * rewritten — the blast radius was the whole language. No threshold fixes this: choosing
 * `人物` over `任务` needs context, which pinyin does not carry.
 *
 * What replaced it:
 *   - `TERMS` covers the user's real vocabulary, which is overwhelmingly Latin-script
 *     (FlClash, GitHub, WorkBuddy, DSH). Matching is exact, so nothing else is touched.
 *   - Cross-script entries fix a Chinese mis-hearing of a Latin term (`哈里斯` -> Harness)
 *     and require 3+ syllables, a complete pinyin reading, and an exact key match.
 *
 * `PAIRS` remains for a user who wants explicit rewrites, but ships empty. Adding to it
 * opts into the same over-reach; the README says so.
 */

/**
 * Canonical spellings. Variants in `heard` are matched **exactly** after case folding.
 *
 * Keep `heard` to genuine mis-spellings of the product name. Do not list a form that is
 * itself an ordinary word: an earlier revision had `grade` under Gradle and `harris`
 * under Harness, which rewrote `my grade is A` and `harris county`. Entries that are real
 * words are excluded by design, and the fuzzy pass is restricted to non-dictionary tokens.
 */
export const TERMS = [
  // --- tools and products the user actually works with ---
  { say: 'DSH', heard: ['dsh'], kind: 'product', evidence: 'dictation produced dsh (casing)' },
  { say: 'FlClash', heard: ['flcash'], kind: 'product', evidence: 'dictation produced flcash for FlClash' },
  { say: 'GitHub', heard: ['github', 'gihub', 'ghub'], kind: 'product', evidence: 'dictation produced gHub for GitHub' },
  { say: 'WorkBuddy', heard: ['workbody'], kind: 'product', evidence: 'dictation produced workbody for WorkBuddy' },
  { say: 'DeepSeek', heard: ['deepseek', 'deep seek'], kind: 'product', evidence: 'dictation produced deep seek harness' },
  { say: 'Paperclip', heard: ['paperclip'], kind: 'product', evidence: 'dictation produced paperclip (casing)' },
  { say: 'TapTap', heard: ['taptap', 'toptop'], kind: 'product', evidence: 'dictation produced taptap/toptop for TapTap' },
  { say: 'Obsidian', heard: ['obsidian'], kind: 'product', evidence: 'dictation produced obsidian (casing)' },
  { say: 'Claude', heard: ['claude'], kind: 'product', evidence: 'dictation produced claude (casing)' },
  { say: 'Codex', heard: ['codex'], kind: 'product', evidence: 'dictation produced codex (casing)' },
  // `cocos` alone is deliberately absent: it is a substring of the canonical form, so
  // listing it made `fixLatinPhrases` and `fixLatin` feed each other and the output grew
  // on every pass (`Cocos Creator` -> `Cocos Creator Creator` -> ...).
  { say: 'Cocos Creator', heard: ['cocoscreator'], kind: 'tool', evidence: 'dictation produced CocosCreator (spacing)' },
  { say: 'Gradle', heard: [], kind: 'tool', evidence: 'gradlespelling already correct; casing normalisation only' },
  { say: 'Android', heard: [], kind: 'platform', evidence: 'dictation produced android (casing)' },
  { say: 'APK', heard: [], kind: 'platform', evidence: 'dictation produced apk (casing)' },
  { say: 'VPN', heard: [], kind: 'term', evidence: 'dictation produced vpn (casing)' },
  { say: 'PlantMerge', heard: ['plantmerge'], kind: 'project', evidence: 'dictation produced plantmerge (casing)' },
  { say: 'Agent', heard: [], kind: 'term', evidence: 'dictation produced agent (casing)' },
  { say: 'token', heard: [], kind: 'term', evidence: 'dictation produced token (identity, no-op guard)' },
  { say: 'prompt', heard: [], kind: 'term', evidence: 'dictation produced prompt (identity, no-op guard)' },
  { say: 'commit', heard: [], kind: 'term', evidence: 'dictation produced commit (identity, no-op guard)' },
  { say: 'Issue', heard: [], kind: 'term', evidence: 'dictation produced issue (casing)' },

  // --- cross-script: a Chinese mis-hearing of a Latin term ---
  // Requires 3+ syllables, all of them present in the pinyin table, and an exact key
  // match over the whole span. The bare 2-syllable form is deliberately absent: `哈里`
  // (hālǐ) is also the reading of ordinary words such as 哈里发, so indexing it would
  // re-create the over-reach described in the header.
  { say: 'Harness', heard: ['哈里斯', '哈内斯'], kind: 'product', evidence: 'dictation produced 哈里斯 for Harness' },
  { say: 'DeepSeek', heard: ['迪普西克'], kind: 'product', evidence: 'cross-script transliteration of DeepSeek' },
];

/**
 * Explicit wrong -> right rewrites. Ships empty on purpose.
 *
 * This is an escape hatch for a user who knows a specific mis-hearing and accepts plain
 * string replacement. It is NOT a general homophone mechanism — see the header. Only add
 * an entry when both hold:
 *   1. the `heard` form is not a legitimate word the user might actually mean, and
 *   2. the recogniser has been observed producing it.
 */
export const PAIRS = [];

/**
 * Deliberate non-corrections, kept as executable documentation: each records a trap a
 * naive glossary would "fix". These strings must survive `correct()` unchanged, and
 * `test/correct.test.mjs` asserts exactly that for every one of them.
 */
export const GUARDS = [
  { text: '人物关系很复杂', why: '人物 与 任务 同音（rènwù）；早期版本误改成「任务关系很复杂」' },
  { text: '这是一部好电影', why: '一部 与 异步 同音（yībù）；早期版本误改成「这是异步好电影」' },
  { text: '信条很重要', why: '信条 与 心跳 同音（xìntiáo）' },
  { text: '便衣警察', why: '便衣 与 编译 同音（biànyī）' },
  { text: '接点电阻', why: '接点 与 接口 同音（jiēdiǎn）' },
  { text: '配制溶液', why: '配制 与 配置 同音（pèizhì）' },
  { text: '变异病毒', why: '变异 与 编译 同音（biànyì）' },
  { text: '一步一步来', why: '一步 与 异步 同音（yībù），且出现两次' },
  { text: '工作太累了', why: '「工作太」是「工作 + 太」，不能改成「工作台」' },
  { text: '哈里王子', why: '「哈里」是普通词，不能因为 哈里斯->Harness 而被改写' },
  { text: '就是这个问题', why: '「就是」是正常副词，不能当口水词删' },
  { text: '唉声叹气', why: '「唉」是词的一部分，不是独立叹词' },
  { text: 'my grade is A', why: 'grade 是正常英文单词，不能因 Gradle 被改写' },
  { text: 'the cloud is down', why: 'cloud 是正常英文单词，不能因 Claude 被改写' },
  { text: 'a harmless joke', why: 'harmless 与 Harness 编辑距离 2，早期模糊匹配会误改' },
  { text: 'upgrade the build', why: 'upgrade 含 grade，早期模糊匹配会误改成 Gradle' },
];
