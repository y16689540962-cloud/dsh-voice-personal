/**
 * Personal speech recognition — Host half.
 *
 * Wraps the built-in local SenseVoice provider so the user's own glossary, voiceprint
 * and writing style are applied to every dictation, without replacing the recogniser
 * itself. Wrapping rather than reimplementing matters: the shipped provider already
 * owns model preparation, the native worker, VAD segmentation, queueing and timeouts,
 * and duplicating any of that would drift from the harness on upgrade.
 *
 * How the wrap works:
 *   - `apply()` registers a new provider that delegates to the shipped one.
 *   - Delegation goes through the public service API: `resolve()` picks the base
 *     provider and `transcribe()` runs it. That path performs the service's own
 *     registration-identity check, so a withdrawn base provider fails loudly instead
 *     of silently producing uncorrected text.
 *   - The base provider keeps its id and stays selectable, so switching back in
 *     Settings is a one-click fallback if anything here misbehaves.
 *
 * The pipeline is deliberately fail-open: if correction throws, the raw transcript is
 * returned unchanged. A dictation must never be lost to a correction bug.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCorrector, DEFAULTS as CORRECT_DEFAULTS } from './lib/correct/index.js';
import { applyStyle, learnStyle, STYLE_VERSION } from './lib/style/index.js';
import { VoiceprintStore } from './lib/voiceprint/index.js';

/** Plugin identity, exported for the loader. */
export const name = 'voice-personal';

/** Services this plugin needs. Without them it stays inactive instead of throwing. */
export const inject = ['speechToText'];

/** Languages forwarded to the wrapped recogniser. */
const LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'];

/**
 * Live plugin internals, populated by `apply`, for tests and diagnostics.
 * Deliberately module-scoped rather than attached to `ctx`: Cordis refuses assignment
 * of an undeclared property on the context, and a service registration would make this
 * plugin a dependency of anything that wants to read it.
 * @type {object|null}
 */
export let internals = null;

/** The shipped provider id, used as the last-resort delegation target. */
const BUILTIN_PROVIDER = 'sensevoice-local';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Built-in defaults. Kept in code because the bundle declares no dependencies. */
const DEFAULTS = {
  providerId: 'personal-local',
  providerName: '个人语音（本地增强）',
  baseProviderId: '',
  dataDir: '',
  speakerModelPath: '',
  voiceprintThreshold: 0.62,
  requireEnrolledSpeaker: false,
  crossScript: true,
  fuzzyTerms: false,
  canonicalTerms: true,
  spacing: 'space',
  applyStyleProfile: true,
  audit: false,
};

/**
 * Read one config value, tolerating both plain objects and accessor-backed config.
 * The loader may hand back either shape; assuming one would silently drop settings.
 */
function readConfig(config, key, fallback) {
  if (!config) return fallback;
  const raw = config[key];
  const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  return value === undefined || value === null || value === '' ? fallback : value;
}

/**
 * Host plugin entry.
 * @param {object} ctx - Cordis context exposing `speechToText`.
 * @param {object} config - plugin config from the patch row.
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console;
  const opts = {};
  for (const [k, v] of Object.entries(DEFAULTS)) opts[k] = readConfig(config, k, v);

  const modelPath = opts.speakerModelPath || path.join(HERE, 'models', 'campplus.onnx');
  // dataDir fallback chain, ordered by how the desktop app actually runs:
  //   1. explicit config (patch) — always wins;
  //   2. $DSH_HOME — set when a profile was booted by the CLI;
  //   3. ~/.dsh — the desktop app's own store. The Electron process does NOT carry
  //      $DSH_HOME in its environment (verified with `ps -E`), so the previous
  //      `?? HERE` fallback resolved into the installed package directory, where no
  //      voiceprint store exists, and requireEnrolledSpeaker then failed closed on
  //      every dictation.
  const dataDir = opts.dataDir
    || (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'voice-personal') : '')
    || path.join(os.homedir(), '.dsh', 'voice-personal');

  const corrector = createCorrector({
    options: {
      ...CORRECT_DEFAULTS,
      crossScript: opts.crossScript,
      fuzzyTerms: opts.fuzzyTerms,
      canonicalTerms: opts.canonicalTerms,
      spacing: opts.spacing,
    },
    applyStyle: opts.applyStyleProfile ? applyStyle : null,
  });

  const voiceprint = new VoiceprintStore({
    dir: dataDir,
    modelPath,
    threshold: opts.voiceprintThreshold,
    logger,
  });

  /** Cached style profile; read once, then reused for every dictation. */
  let styleProfile;
  let styleRead = false;
  const loadStyle = () => {
    if (styleRead) return styleProfile;
    styleRead = true;
    const p = path.join(dataDir, 'style.json');
    try {
      styleProfile = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    } catch (error) {
      logger.warn?.(`[voice-personal] 风格画像读取失败，已忽略：${error?.message ?? error}`);
      styleProfile = null;
    }
    return styleProfile;
  };

  ctx.effect(() => {
    /** Provider ids currently registered, for diagnostics and fallback choice. */
    const availableIds = () => {
      try {
        return ctx.speechToText.listProviders().map(p => p.id);
      } catch {
        return [];
      }
    };

    /**
     * Resolve the provider to delegate to.
     * Preference order: the configured base, then the shipped built-in, then whatever
     * else is registered. Each attempt goes through `resolve()` so the service
     * validates availability and language support itself.
     *
     * This plugin's own id is excluded. Without that exclusion a missing base provider
     * makes the fallback list contain ourselves, and delegation recurses until the
     * stack overflows instead of reporting the real problem.
     */
    const resolveBase = (input) => {
      const ids = availableIds().filter(id => id !== opts.providerId);
      const preferred = opts.baseProviderId || BUILTIN_PROVIDER;
      const order = [preferred, BUILTIN_PROVIDER, ...ids].filter(Boolean);
      const tried = new Set();
      let lastError = null;
      for (const id of order) {
        if (tried.has(id) || id === opts.providerId) continue;
        tried.add(id);
        if (ids.length && !ids.includes(id)) continue;
        try {
          return ctx.speechToText.resolve({
            audio: input.audio,
            providerId: id,
            language: input.language,
          });
        } catch (error) {
          lastError = error;
        }
      }
      // Nothing named worked; let the service pick its own default, but only when that
      // default is not this plugin.
      try {
        const spec = ctx.speechToText.resolve({ audio: input.audio, language: input.language });
        if (spec?.provider?.info?.id !== opts.providerId) return spec;
        lastError = new Error('service default resolves back to this plugin');
      } catch (error) {
        lastError = error;
      }
      throw new Error(
        `个人语音：找不到可用的本地识别 provider（已尝试 ${[...tried].join(', ') || '无'}）。`
        + `请确认内置语音插件（sensevoice-local）已启用。原始错误：${lastError?.message ?? lastError}`,
      );
    };

    const unregister = ctx.speechToText.register({
      info: {
        id: opts.providerId,
        name: opts.providerName,
        location: 'host-local',
        languages: LANGUAGES,
        // No downloads: the wrapped provider owns model preparation.
        downloadSources: [],
      },
      /**
       * Correct one recording.
       * Audio is forwarded to the wrapped provider and never persisted by this plugin.
       */
      transcribe: async (input, signal) => {
        // Speaker gate. When enforcement is on it fails CLOSED: a recording that cannot
        // be attributed to an enrolled speaker is rejected rather than passed through.
        // Silently skipping the check would leave the user believing they were protected
        // while any voice was accepted, which is worse than not offering the feature.
        let speaker = null;
        if (opts.requireEnrolledSpeaker) {
          if (!voiceprint.ready) {
            throw new Error(
              '个人语音：已开启「只认我的声音」，但声纹模型不可用，无法校验说话人。'
              + `请检查声纹模型路径（当前：${modelPath}），或关闭 requireEnrolledSpeaker。`,
            );
          }
          if (!voiceprint.list().length) {
            throw new Error(
              '个人语音：已开启「只认我的声音」，但还没有注册任何声纹。'
              + '请先用 scripts/enroll.mjs 注册你的声音，或关闭 requireEnrolledSpeaker。',
            );
          }
          speaker = voiceprint.verify(Buffer.from(input.audio));
          if (!speaker || speaker.matched !== true) {
            const who = speaker?.name ?? '无';
            const score = typeof speaker?.score === 'number' ? speaker.score.toFixed(3) : 'n/a';
            throw new Error(
              `个人语音：这段录音不是已注册的说话人（最佳匹配 ${who}，相似度 ${score}，`
              + `阈值 ${opts.voiceprintThreshold}）。已按「只认我的声音」拒绝。`,
            );
          }
        }

        const spec = resolveBase(input);
        const result = await ctx.speechToText.transcribe(spec, signal);

        const raw = typeof result === 'string' ? result : result?.text ?? '';
        const audioSeconds = typeof result === 'object' ? result?.audioSeconds ?? 0 : 0;
        const inferenceSeconds = typeof result === 'object' ? result?.inferenceSeconds ?? 0 : 0;

        try {
          const { text, changes } = corrector.correct(raw, { style: loadStyle() });
          const out = { text, audioSeconds, inferenceSeconds };
          if (opts.audit) out.changes = changes;
          if (speaker?.matched) out.speaker = { name: speaker.name, score: speaker.score };
          return out;
        } catch (error) {
          // Fail open: an unmodified transcript beats a lost one.
          logger.warn?.(`[voice-personal] 纠错已跳过，返回原始识别结果：${error?.message ?? error}`);
          return { text: raw, audioSeconds, inferenceSeconds };
        }
      },
    });

    logger.info?.(
      `[voice-personal] provider "${opts.providerId}" 已注册（委托给 ${opts.baseProviderId || BUILTIN_PROVIDER}）`,
    );

    return () => {
      const removing = unregister();
      return Promise.resolve(removing).catch(() => {});
    };
  });

  // Diagnostics only. Assigned to the module-level `internals` rather than to `ctx`:
  // Cordis rejects setting an undeclared property on the context
  // ("cannot set property ... without provide"), which crashed activation.
  internals = { corrector, voiceprint, learnStyle, applyStyle, STYLE_VERSION, dataDir, modelPath };




}
