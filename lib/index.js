// dsh-newapi-video — call a new-api (one-api style) relay station's video model
// from the conversation, using @-referenced image/video materials plus a prompt.
//
// Registered tools:
//   - newapi_generate_video : text-to-video / image-to-video through the relay.
//   - newapi_task_status    : recover / inspect async tasks after a timeout.
//
// Settings (WebUI Settings -> NewAPI Video, namespace `newapi-video`):
//   baseURL, apiKey, model, mode, outputDir, poll interval/attempts,
//   and (for `generic-rest`) configurable submit/status paths.
//
// Modes:
//   - openai-videos   : OpenAI-compatible POST {base}{submitPath} + GET status.
//   - modelverse-tasks: POST {base}/tasks/submit + GET /tasks/status.
//   - generic-rest    : configurable paths + JSON field extraction.

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash } from "node:crypto";
import { stat, mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { readFileSync, createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, relative } from "node:path";
import {
  addSessionFile,
  parseConfirmBody,
  readSessionLedger,
  recordGeneration,
  removeSessionFile,
  sessionShotsConfirm,
  sessionShotsGet,
} from "./session-ledger.js";
import { joinRelayPath, trimBase } from "./relay-url.js";

export const name = "newapi-video";
export const inject = ["tools", "systemPrompt", "settings", "credentials", "skills"];

const SETTINGS_NS = "newapi-video";
const SKILL_NAME = "ecommerce-visual-suite";

// --- 模型配置回退 -----------------------------------------------------------
// 当本插件自己的 baseURL / apiKey 为空时,默认读取 DSH 的「模型配置」(LLM 提供商
// `llm-deepseek` 命名空间,含 baseURL 与 apiKeyEnv 凭据引用)。这样视频/图片走同一个
// 中转站,不用再单独填一遍。只作回退:插件字段非空优先。
const MODEL_PROVIDER_NS = "llm-deepseek";
let pluginCtx = null;

function dshHomeCandidates() {
  const out = [];
  if (process.env.DSH_HOME) out.push(process.env.DSH_HOME);
  out.push(join(homedir(), ".qurwork-desktop-dsh", ".dsh"));
  out.push(join(homedir(), ".dsh"));
  return [...new Set(out)];
}
function yamlNsField(ns, field) {
  const nsRe = String(ns).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fieldRe = String(field).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const home of dshHomeCandidates()) {
    try {
      const raw = readFileSync(join(home, "settings.yaml"), "utf8").replace(/^\uFEFF/, "");
      const start = raw.search(new RegExp(`(?:^|\\n)\\s*${nsRe}\\s*:`));
      if (start < 0) continue;
      const rest = raw.slice(start);
      const nextTop = rest.slice(1).search(/\n[^\s]/);
      const block = nextTop >= 0 ? rest.slice(0, nextTop + 1) : rest;
      const m =
        block.match(new RegExp(`${fieldRe}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)) ||
        block.match(new RegExp(`${fieldRe}\\s*:\\s*'((?:\\\\.|[^'\\\\])*)'`)) ||
        block.match(new RegExp(`"${fieldRe}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)) ||
        block.match(new RegExp(`${fieldRe}\\s*:\\s*([^\\s,#}"']+)`));
      const val = m ? String(m[1]).replace(/\\"/g, '"').trim() : "";
      if (val !== "") return val;
    } catch {
      // try next home
    }
  }
  return "";
}
function readModelConfig() {
  let baseURL = "";
  let apiKeyRef = "";
  try {
    const ns = pluginCtx?.settings?.get?.(MODEL_PROVIDER_NS);
    if (ns && typeof ns === "object") {
      baseURL = String(ns.baseURL ?? "").trim();
      apiKeyRef = String(ns.apiKeyEnv ?? "").trim();
    }
  } catch {
    // model config unavailable
  }
  if (baseURL === "") baseURL = yamlNsField(MODEL_PROVIDER_NS, "baseURL");
  if (apiKeyRef === "") apiKeyRef = yamlNsField(MODEL_PROVIDER_NS, "apiKeyEnv");
  if (apiKeyRef === "") apiKeyRef = "DEEPSEEK_API_KEY";
  return { baseURL, apiKeyRef };
}
// CredentialRef resolve() returns { value, source }. Record hits may use `key`.
function credentialSecret(hit) {
  if (!hit || typeof hit !== "object") return "";
  if (typeof hit.value === "string" && hit.value.trim() !== "") return hit.value.trim();
  if (typeof hit.key === "string" && hit.key.trim() !== "") return hit.key.trim();
  return "";
}
async function resolveCredentialRef(ref) {
  const name = String(ref ?? "").trim();
  if (name === "") return "";
  try {
    const credentials = pluginCtx?.get?.("credentials");
    if (credentials?.resolve) {
      const key = credentialSecret(await credentials.resolve(name));
      if (key !== "") return key;
    }
  } catch {
    // fall through to process env
  }
  const ambient = typeof process.env[name] === "string" ? process.env[name].trim() : "";
  return ambient;
}
// scope.get() / settings UI snapshots may strip role("secret") fields, so a
// stored plugin key looks empty even though settings.yaml still has it.
function readPluginStoredApiKey() {
  return yamlNsField(SETTINGS_NS, "apiKey");
}
function ownApiKey(settings) {
  const fromScope = typeof settings?.apiKey === "string" ? settings.apiKey.trim() : "";
  if (fromScope !== "") return fromScope;
  try {
    const ns = pluginCtx?.settings?.get?.(SETTINGS_NS);
    const fromGet = typeof ns?.apiKey === "string" ? ns.apiKey.trim() : "";
    if (fromGet !== "") return fromGet;
  } catch {
    // fall through to yaml
  }
  return readPluginStoredApiKey();
}
function maskApiKey(key) {
  const s = String(key || "");
  if (s.length === 0) return "";
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 3)}••••${s.slice(-4)}`;
}
function effectiveBaseURL(settings) {
  const own = String(settings.baseURL ?? "").trim();
  if (own !== "") return trimBase(own);
  return trimBase(readModelConfig().baseURL);
}
function baseURLSourceOf(settings) {
  const own = String(settings.baseURL ?? "").trim();
  if (own !== "") return "plugin";
  return readModelConfig().baseURL !== "" ? "model-config" : "none";
}
async function apiKeySourceOf(settings) {
  const own = ownApiKey(settings);
  if (own !== "") return "plugin";
  const key = await resolveCredentialRef(readModelConfig().apiKeyRef);
  return key !== "" ? "model-config" : "none";
}
async function resolveApiKey(settings) {
  const own = ownApiKey(settings);
  if (own !== "") return own;
  const key = await resolveCredentialRef(readModelConfig().apiKeyRef);
  if (key !== "") return key;
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(effectiveBaseURL(settings))) {
    throw new Error(
      "No API key configured for 视频工坊. Fill Base URL / API Key in WebUI Settings → 视频工坊, or set the API key in DSH 模型配置.",
    );
  }
  return "";
}

// ---------------------------------------------------------------------------
// 官方视频 provider(BYOK):与 dsh-video-gen 一致的协议,视频生成多一个通道。
// 仅影响视频;图片生成始终走 new-api 中转站。
// ---------------------------------------------------------------------------
const PROVIDER_ENV = {
  ofox: ["OFOX_API_KEY", "OFOXAI_API_KEY"],
  seedance: ["ARK_API_KEY"],
  wan: ["DASHSCOPE_API_KEY", "ALIYUN_DASHSCOPE_API_KEY"],
  siliconflow: ["SILICONFLOW_API_KEY"],
  zhipu: ["ZHIPU_API_KEY"],
};
const PROVIDER_PROFILE = {
  ofox: { env: PROVIDER_ENV.ofox, baseURL: "https://api.ofox.ai", model: "bytedance/seedance-2.0" },
  seedance: { env: PROVIDER_ENV.seedance, baseURL: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seedance-2-0-260128" },
  wan: { env: PROVIDER_ENV.wan, baseURL: "https://dashscope.aliyuncs.com", model: "wan2.7-t2v-2026-06-12", i2v: "wan2.7-i2v-2026-04-25" },
  siliconflow: { env: PROVIDER_ENV.siliconflow, baseURL: "https://api.siliconflow.cn", model: "Wan-AI/Wan2.2-T2V-A14B", i2v: "Wan-AI/Wan2.2-I2V-A14B" },
  zhipu: { env: PROVIDER_ENV.zhipu, baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "cogvideox-flash" },
};

function providerFirstString(value) {
  if (Array.isArray(value)) {
    for (const item of value) if (typeof item === "string" && item.length > 0) return item;
    return void 0;
  }
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function providerAspectToPixel(ratio, large = false) {
  const base = {
    "16:9": large ? "1920x1080" : "1280x720",
    "9:16": large ? "1080x1920" : "720x1280",
    "1:1": large ? "1440x1440" : "960x960",
    "4:3": large ? "1280x960" : "960x720",
    "3:4": large ? "960x1280" : "720x960",
    "21:9": large ? "1920x824" : "1280x544",
  };
  return base[ratio] ?? (large ? "1920x1080" : "1280x720");
}
function providerNormalize(status, videoUrl, error, succeededValue) {
  const terminal = status === succeededValue || ["failed", "Failed", "FAIL", "FAILED", "cancelled", "canceled", "expired", "CANCELED", "UNKNOWN"].includes(status);
  const succeeded = status === succeededValue && typeof videoUrl === "string" && videoUrl.length > 0;
  return { status, terminal, succeeded, videoUrl, error };
}
async function providerJson(response, label) {
  const text = await response.text();
  if (text.length === 0) return void 0;
  try { return JSON.parse(text); } catch { throw new Error(`${label} returned invalid JSON (${response.status}): ${text.slice(0, 1024)}`); }
}

// Resolve the BYOK api key for an official provider. Try the provider env/credential
// refs first, then fall back to the relay key (settings.apiKey / model config).
async function resolveProviderApiKey(active, settings) {
  for (const env of active.env) {
    const key = await resolveCredentialRef(env);
    if (key !== "") return key;
  }
  return resolveApiKey(settings);
}
function resolveProviderProfile(settings, provider) {
  const base = PROVIDER_PROFILE[provider];
  if (!base) throw new Error(`unknown video provider: ${provider}`);
  const pf = String(provider);
  const profile = {
    provider: pf,
    env: base.env,
    baseURL: cleanStr(settings[`${pf}BaseURL`]) || base.baseURL,
    model: cleanStr(settings[`${pf}Model`]) || base.model,
  };
  if (base.i2v) profile.i2vModel = cleanStr(settings[`${pf}I2vModel`]) || base.i2v;
  return profile;
}

// 官方 provider 提交/查询(协议与 dsh-video-gen 一致)。
async function providerSubmit(active, opts, apiKey) {
  const { prompt, options, media, signal } = opts;
  const imageUrl = media?.firstFrame ?? media?.references?.[0];
  const hasImage = typeof imageUrl === "string" && imageUrl.length > 0;
  switch (active.provider) {
    case "ofox": {
      const body = { model: active.model, prompt };
      if (options.aspectRatio) body.aspect_ratio = options.aspectRatio;
      if (options.duration) body.duration = options.duration;
      if (options.resolution) body.resolution = options.resolution;
      body.generate_audio = true;
      if (hasImage) body.frame_images = [{ type: "image_url", image_url: { url: imageUrl }, frame_type: "first_frame" }];
      const response = await fetch(`${active.baseURL}/v1/videos`, { method: "POST", redirect: "error", signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await providerJson(response, "OfoxAI");
      if (!response.ok) throw new Error(`OfoxAI video submission failed (${response.status}): ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      const id = payload?.id;
      if (typeof id !== "string" || id.length === 0) throw new Error(`OfoxAI video submission returned no task id: ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      return { id, pollingUrl: typeof payload.polling_url === "string" ? payload.polling_url : `${active.baseURL}/v1/videos/${id}` };
    }
    case "seedance": {
      const content = [{ type: "text", text: prompt }];
      if (hasImage) content.push({ type: "image_url", image_url: { url: imageUrl }, role: "first_frame" });
      const body = { model: active.model, content };
      if (options.aspectRatio) body.ratio = options.aspectRatio;
      if (options.duration) body.duration = options.duration;
      if (options.resolution) body.resolution = options.resolution;
      body.watermark = false;
      body.generate_audio = true;
      const response = await fetch(`${active.baseURL}/contents/generations/tasks`, { method: "POST", redirect: "error", signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await providerJson(response, "Seedance");
      if (!response.ok) throw new Error(`Seedance video submission failed (${response.status}): ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      const id = payload?.id;
      if (typeof id !== "string" || id.length === 0) throw new Error(`Seedance video submission returned no task id: ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      return { id, pollingUrl: `${active.baseURL}/contents/generations/tasks/${id}` };
    }
    case "wan": {
      const input = hasImage ? { prompt, media: [{ type: "first_frame", url: imageUrl }] } : { prompt };
      const parameters = {};
      if (options.aspectRatio) parameters.ratio = options.aspectRatio;
      if (options.resolution) parameters.resolution = options.resolution.toUpperCase();
      if (options.duration) parameters.duration = options.duration;
      parameters.watermark = false;
      const body = { model: hasImage ? active.i2vModel : active.model, input, parameters };
      const response = await fetch(`${active.baseURL}/api/v1/services/aigc/video-generation/video-synthesis`, { method: "POST", redirect: "error", signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "x-dashscope-async": "enable" }, body: JSON.stringify(body) });
      const payload = await providerJson(response, "Wan");
      if (!response.ok) throw new Error(`Wan video submission failed (${response.status}): ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      const taskId = payload?.output?.task_id;
      if (typeof taskId !== "string" || taskId.length === 0) throw new Error(`Wan video submission returned no task_id: ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      return { id: taskId, pollingUrl: `${active.baseURL}/api/v1/tasks/${taskId}` };
    }
    case "siliconflow": {
      const body = { model: hasImage ? active.i2vModel : active.model, prompt };
      if (options.aspectRatio) body.image_size = providerAspectToPixel(options.aspectRatio);
      if (hasImage) body.image = imageUrl;
      const response = await fetch(`${active.baseURL}/v1/video/submit`, { method: "POST", redirect: "error", signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await providerJson(response, "SiliconFlow");
      if (!response.ok) throw new Error(`SiliconFlow video submission failed (${response.status}): ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      const requestId = payload?.requestId;
      if (typeof requestId !== "string" || requestId.length === 0) throw new Error(`SiliconFlow video submission returned no requestId: ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      return { id: requestId, pollingUrl: `${active.baseURL}/v1/video/status` };
    }
    case "zhipu": {
      const body = { model: active.model, prompt };
      if (hasImage) body.image_url = imageUrl;
      if (options.aspectRatio) body.size = providerAspectToPixel(options.aspectRatio, options.resolution === "1080p");
      if (options.duration) body.duration = options.duration;
      body.with_audio = true;
      body.watermark_enabled = false;
      const response = await fetch(`${active.baseURL}/videos/generations`, { method: "POST", redirect: "error", signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await providerJson(response, "Zhipu");
      if (!response.ok) throw new Error(`Zhipu video submission failed (${response.status}): ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      const id = payload?.id;
      if (typeof id !== "string" || id.length === 0) throw new Error(`Zhipu video submission returned no id: ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      return { id, pollingUrl: `${active.baseURL}/async-result/${id}` };
    }
    default:
      throw new Error(`unknown provider ${active.provider}`);
  }
}

async function providerQuery(active, task, apiKey) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  switch (active.provider) {
    case "ofox": {
      const response = await fetch(task.pollingUrl, { method: "GET", redirect: "error", headers });
      const payload = await providerJson(response, "OfoxAI");
      if (!response.ok) throw new Error(`OfoxAI video query failed (${response.status}): ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      return providerNormalize(payload?.status, providerFirstString(payload?.mirror_urls) ?? providerFirstString(payload?.unsigned_urls), payload?.error, "completed");
    }
    case "seedance": {
      const response = await fetch(task.pollingUrl, { method: "GET", redirect: "error", headers });
      const payload = await providerJson(response, "Seedance");
      if (!response.ok) throw new Error(`Seedance video query failed (${response.status}): ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      return providerNormalize(payload?.status, payload?.content?.video_url, payload?.error, "succeeded");
    }
    case "wan": {
      const response = await fetch(task.pollingUrl, { method: "GET", redirect: "error", headers });
      const payload = await providerJson(response, "Wan");
      if (!response.ok) throw new Error(`Wan video query failed (${response.status}): ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      return providerNormalize(payload?.output?.task_status, payload?.output?.video_url, payload?.error, "SUCCEEDED");
    }
    case "siliconflow": {
      const response = await fetch(task.pollingUrl, { method: "POST", redirect: "error", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ requestId: task.id }) });
      const payload = await providerJson(response, "SiliconFlow");
      if (!response.ok) throw new Error(`SiliconFlow video query failed (${response.status}): ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      return providerNormalize(payload?.status, payload?.results?.videos?.[0]?.url, payload?.reason, "Succeed");
    }
    case "zhipu": {
      const response = await fetch(task.pollingUrl, { method: "GET", redirect: "error", headers });
      const payload = await providerJson(response, "Zhipu");
      if (!response.ok) throw new Error(`Zhipu video query failed (${response.status}): ${JSON.stringify(payload ?? {}).slice(0, 400)}`);
      return providerNormalize(payload?.task_status, payload?.video_result?.[0]?.url, payload?.error, "SUCCESS");
    }
    default:
      throw new Error(`unknown provider ${active.provider}`);
  }
}

async function providerPoll(query, task, opts) {
  const started = Date.now();
  for (;;) {
    if (opts.signal?.aborted) throw new Error("Task polling cancelled");
    const state = await query(task);
    if (state.terminal) return state;
    if (Date.now() - started > opts.maxWaitMs) {
      throw new Error(`Video generation timed out after ${Math.round(opts.maxWaitMs / 1000)}s; task still running (id: ${task.id})`);
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

// 官方 provider 视频生成的统一入口:BVOK 解析 → 提交 → 轮询 → 返回 { urls }。
async function providerVideo(settings, exec, provider, { prompt, options, media, cwd, onProgress }) {
  const active = resolveProviderProfile(settings, provider);
  const apiKey = await resolveProviderApiKey(active, settings);
  const signal = signalOf(exec, settings.timeoutMs || 120000);
  const opts = { prompt, options, media, signal };
  const task = await providerSubmit(active, opts, apiKey);
  const intervalMs = settings.pollIntervalMs || 5000;
  const maxAttempts = settings.maxPollAttempts || 360;
  const state = await providerPoll((t) => providerQuery(active, t, apiKey), task, {
    intervalMs,
    maxWaitMs: intervalMs * maxAttempts,
    signal,
  });
  if (!state.succeeded) {
    throw new Error(`Video generation failed (${provider}): ${state.error || state.status || "unknown"}`);
  }
  onProgress?.(task.id, state.status, void 0);
  return { taskId: task.id, status: state.status, urls: [state.videoUrl] };
}


// 本次会话生成/上传的媒体文件,持久化到工作区根目录的台账(.dsh-newapi-session.json),
// 供资产库「本会话」过滤。用磁盘文件而非内存 Set:工具执行与 Web 服务可能运行在
// 不同的模块/进程实例,内存集合不共享;磁盘台账两者可见且跨重启保留。
const MODES = ["v1-videos", "openai-videos", "modelverse-tasks", "generic-rest"];

export const Config = z.object({
  enabled: z.boolean().default(true).description("Register the 视频工坊 video tools."),
  mode: z.union(MODES).default("v1-videos").description("Protocol used to reach the relay. v1-videos fits the new-api /v1/videos task interface used by Seedance 2.0 & Happyhorse; auto-detects the payload shape from the model name."),
  baseURL: z.string().default("").description("Relay base URL, with or without trailing /v1. Empty defaults to the DSH model configuration."),
  apiKey: z.string().role("secret").default("").description("API key for the relay. Empty falls back to the DSH model configuration key."),
  model: z.string().default("doubao-seedance-2-0-mini-260615").description("Video model id (e.g. doubao-seedance-2-0-mini-260615, happyhorse-1.1-i2v)."),
  outputDir: z.string().default("newapi_output").description("Directory under the session working directory for downloaded videos and the task ledger."),
  timeoutMs: z.number().step(1).min(1000).max(3600000).default(120000).description("HTTP timeout for one provider request (ms)."),
  pollIntervalMs: z.number().step(1).min(500).max(60000).default(5000).description("Async task polling interval (ms)."),
  maxPollAttempts: z.number().step(1).min(1).max(2000).default(360).description("Maximum async task polling attempts."),
  aspectRatio: z.string().default("auto").description("Default aspect ratio (auto = provider default, or 16:9, 9:16, 1:1, ...)."),
  durationSeconds: z.number().step(1).min(1).max(60).default(5).description("Default duration in seconds."),
  resolution: z.string().default("1080p").description("Output tier for v1-videos as lowercase 480p/720p/1080p/4k (or 2K/1080p for modelverse-tasks)."),
  submitPath: z.string().default("/videos/generations").description("POST path for creating a task (openai-videos / generic-rest)."),
  statusPathTemplate: z.string().default("/videos/{task_id}").description("GET status path template; {task_id} is substituted (openai-videos / generic-rest)."),
  taskIdField: z.string().default("").description("Optional dot-path for the task id in the submit response (generic-rest), e.g. output.task_id."),
  statusField: z.string().default("").description("Optional dot-path for the status string (generic-rest), e.g. output.task_status."),
  urlsField: z.string().default("").description("Optional dot-path for the result URL list (generic-rest), e.g. output.urls."),
  imageModel: z.string().default("gpt-image-2").description("Image model id (e.g. gpt-image-2, qwen-image-2.0, Doubao-Seedream-5.0)."),
  imageSize: z.string().default("1024x1024").description("Default image size, e.g. 1024x1024 (or qwen width*height like 2048*2048)."),
  imageQuality: z.string().default("").description("Default image quality, e.g. auto/standard/hd/high/medium/low (empty = provider default)."),
  imageOutputDir: z.string().default("newapi_image").description('Sub-directory under the session working directory for generated images (e.g. "newapi_image", or "." for the workspace root).'),
  storageDir: z.string().default("").description('All-session shared media store (absolute path). Uploads and generated images/videos save here and the asset library scans it; empty keeps the per-workspace newapi_image/newapi_output behavior.'),
  provider: z.union(["newapi", "ofox", "seedance", "wan", "siliconflow", "zhipu"]).default("newapi").description("视频生成通道。newapi = 走中转站(/v1/videos);ofox/seedance/wan/siliconflow/zhipu = 官方 provider(BYOK,各自填 baseURL/model/key)。"),
  ofoxBaseURL: z.string().default("https://api.ofox.ai").description("OfoxAI 网关 base"),
  ofoxModel: z.string().default("bytedance/seedance-2.0"),
  seedanceBaseURL: z.string().default("https://ark.cn-beijing.volces.com/api/v3"),
  seedanceModel: z.string().default("doubao-seedance-2-0-260128"),
  wanBaseURL: z.string().default("https://dashscope.aliyuncs.com"),
  wanModel: z.string().default("wan2.7-t2v-2026-06-12"),
  wanI2vModel: z.string().default("wan2.7-i2v-2026-04-25"),
  siliconflowBaseURL: z.string().default("https://api.siliconflow.cn"),
  siliconflowModel: z.string().default("Wan-AI/Wan2.2-T2V-A14B"),
  siliconflowI2vModel: z.string().default("Wan-AI/Wan2.2-I2V-A14B"),
  zhipuBaseURL: z.string().default("https://open.bigmodel.cn/api/paas/v4"),
  zhipuModel: z.string().default("cogvideox-flash"),
});

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

const SUCCESS_STATES = new Set(["success", "succeeded", "completed", "complete", "finished", "done", "succeed"]);
const FAILURE_STATES = new Set(["failed", "failure", "error", "cancelled", "canceled", "fail"]);

// Friendly, human-facing status label (排队中 / 渲染中 / 已完成 / 失败), used in
// the live-task ledger and the tool result so both the card and task_status are
// consistent regardless of the raw provider status string.
function stateLabelOf(state) {
  const s = String(state ?? "").toLowerCase();
  if (SUCCESS_STATES.has(s) || /succee|complet|finish|done|ok$/i.test(s)) return "已完成";
  if (FAILURE_STATES.has(s) || /fail|cancel|error|abort|reject|timed? ?out/i.test(s)) return "失败";
  if (/queu|pend|wait|submit|created|init|accept|receiv|deploy/i.test(s)) return "排队中";
  if (/process|render|generat|synthesiz|working|progress|run|runn|tasking/i.test(s)) return "渲染中";
  const trimmed = String(state ?? "").trim();
  return trimmed === "" ? "处理中" : trimmed;
}

const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}
function isDataUrl(value) {
  return /^data:/i.test(value);
}
function mimeForPath(path) {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}
function cleanStr(value) {
  return typeof value === "string" ? value.trim() : "";
}
// Strip a leading `@` (from a @-mention) and any wrapping quotes the model may
// have copied from the `@"path with spaces"` grammar.
function cleanPath(value) {
  let s = cleanStr(value);
  s = s.replace(/^@/, "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s;
}
const IMG_EXT_SET = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".svg"]);
const VID_EXT_SET = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"]);
// Recursively find a media file by its exact basename under `root` (bounded
// depth). Handles @-mentions that reference a bare file name which actually
// lives in a sub-directory such as newapi_image/ or newapi_output/.
async function findMediaByName(root, baseName, depth = 6) {
  if (typeof baseName !== "string" || baseName === "") return void 0;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return void 0;
  }
  for (const ent of entries) {
    const full = resolve(root, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.startsWith(".") || depth <= 0) continue;
      const found = await findMediaByName(full, baseName, depth - 1);
      if (found) return found;
    } else if (ent.isFile()) {
      if (basename(full) === baseName) {
        const ext = extname(full).toLowerCase();
        if (IMG_EXT_SET.has(ext) || VID_EXT_SET.has(ext)) return full;
      }
    }
  }
  return void 0;
}
// Detect a media file's extension from magic bytes when available, else from the
// given filename. Used by /newapi/upload to classify pasted/uploaded bytes.
function detectMediaExt(name, buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return ".gif";
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return ".webp";
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return ".mp4";
  const e = extname(name).toLowerCase();
  if (IMG_EXT_SET.has(e) || VID_EXT_SET.has(e)) return e;
  return void 0;
}
function slugify(value, max = 40) {
  const s = String(value ?? "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
  return s === "" ? "video" : s;
}
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.trim() !== "" ? cwd : process.cwd();
}
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
// Combine the tool-call cancellation signal with a per-request HTTP timeout.
function signalOf(exec, timeoutMs) {
  const base = exec?.signal ?? new AbortController().signal;
  return AbortSignal.any([base, AbortSignal.timeout(timeoutMs)]);
}
function aborted(exec) {
  return exec?.signal?.aborted === true;
}
// Resolve a @-referenced / local / URL / data-URL media source into a value the
// provider can consume: local files become base64 data URLs, URLs pass through.
async function mediaToSource(source, cwd, maxBytes) {
  const value = cleanPath(source);
  if (value === "") throw new Error("empty media source");
  if (isDataUrl(value) || isHttpUrl(value)) return value;
  const abs = resolve(cwd, value);
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new Error(`File not found: ${value} (resolved ${abs})`);
  }
  if (info.size > maxBytes) {
    throw new Error(`File too large to inline (${Math.round(info.size / 1024 / 1024)}MB > ${Math.round(maxBytes / 1024 / 1024)}MB): ${value}`);
  }
  const data = await readFile(abs);
  return `data:${mimeForPath(abs)};base64,${data.toString("base64")}`;
}
async function readJsonResponse(response, context) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${context} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
}
function getPath(obj, path) {
  if (path === "" || obj === null || typeof obj !== "object") return void 0;
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return void 0;
    cur = cur[key];
  }
  return cur;
}
function pickFirst(obj, paths) {
  for (const path of paths) {
    const v = getPath(obj, path);
    if (v !== void 0) return v;
  }
  return void 0;
}
function asStringArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.length > 0);
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}
// Collect result URLs from the many provider status response shapes.
function collectUrls(body, hintPath) {
  const urls = [];
  if (hintPath !== "" && hintPath !== void 0) {
    const hinted = getPath(body, hintPath);
    for (const url of asStringArray(hinted)) urls.push(url);
  }
  const candidates = [
    body?.metadata?.urls,
    body?.metadata?.url,
    body?.metadata?.video_url,
    body?.data?.metadata?.urls,
    body?.data?.metadata?.url,
    body?.output?.urls,
    body?.output?.url,
    body?.output?.videos,
    body?.output?.task_result?.videos,
    body?.data?.task_result?.videos,
    body?.urls,
    body?.url,
    body?.data?.urls,
    body?.data?.url,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === "string") urls.push(item);
        else if (item && typeof item === "object" && typeof item.url === "string") urls.push(item.url);
        else if (item && typeof item === "object" && typeof item.video_url === "string") urls.push(item.video_url);
      }
    } else if (typeof candidate === "string" && candidate.length > 0) {
      urls.push(candidate);
    }
  }
  return [...new Set(urls)].filter((url) => /^https?:\/\//i.test(url) || /^data:/i.test(url));
}
async function downloadToFile(url, outputDir, cwd, prefix, ext) {
  const dir = resolve(cwd, outputDir);
  await mkdir(dir, { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  // 清短、可预期的文件名:前 20 字符的提示词 slug + 紧凑时间戳(无需 agent 再自行改名)。
  const ts = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const stem = `${slugify(prefix, 20)}-${ts}${ext}`;
  const path = join(dir, stem);
  await writeFile(path, bytes);
  return path;
}

// ---------------------------------------------------------------------------
// Task ledger (persisted under outputDir for async recovery)
// ---------------------------------------------------------------------------

class TaskLedger {
  constructor(path) {
    this.path = path;
  }
  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      if (parsed && Array.isArray(parsed.tasks)) return parsed;
      return { tasks: [] };
    } catch {
      return { tasks: [] };
    }
  }
  async save(doc) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(doc, null, 2));
  }
  async append(record) {
    const doc = await this.load();
    doc.tasks.push(record);
    if (doc.tasks.length > 500) doc.tasks = doc.tasks.slice(-500);
    await this.save(doc);
  }
  // Merge by taskId: update an existing record in place (live progress) or add.
  async upsert(record) {
    const doc = await this.load();
    const index = doc.tasks.findIndex((task) => task.taskId === record.taskId);
    if (index >= 0) doc.tasks[index] = { ...doc.tasks[index], ...record };
    else doc.tasks.push(record);
    if (doc.tasks.length > 500) doc.tasks = doc.tasks.slice(-500);
    await this.save(doc);
  }
  async get(taskId) {
    const doc = await this.load();
    return doc.tasks.find((task) => task.taskId === taskId);
  }
  async list(limit) {
    const doc = await this.load();
    return doc.tasks.slice(-limit);
  }
}

// ---------------------------------------------------------------------------
// Provider modes
// ---------------------------------------------------------------------------

// OpenAI-compatible (new-api) video endpoint.
async function openaiVideo(settings, exec, { prompt, options, media, cwd, onProgress }) {
  const base = effectiveBaseURL(settings);
  const apiKey = await resolveApiKey(settings);
  const model = options.model;
  const payload = { model, prompt };
  if (options.duration > 0) {
    const allowed = [4, 8, 12];
    const nearest = allowed.reduce((best, candidate) => (Math.abs(candidate - options.duration) < Math.abs(best - options.duration) ? candidate : best), 8);
    payload.seconds = String(nearest);
  }
  if (options.size !== "") payload.size = options.size;
  if (media.firstFrame !== void 0) payload.input_reference = { image_url: media.firstFrame };
  if (media.video !== void 0) {
    throw new Error("openai-videos mode does not accept a source video reference. Use an image (first_frame) instead, or switch to modelverse-tasks / generic-rest.");
  }
  const signal = signalOf(exec, settings.timeoutMs);
  const createResponse = await fetch(joinRelayPath(base, settings.submitPath), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const create = await readJsonResponse(createResponse, `video creation (${settings.submitPath})`);
  if (!createResponse.ok) {
    throw new Error(`Video creation failed (HTTP ${createResponse.status}): ${JSON.stringify(create.error ?? create).slice(0, 400)}`);
  }
  const taskId = pickFirst(create, ["id", "output.task_id", "data.task_id", "task_id"]);
  if (typeof taskId !== "string" || taskId === "") {
    throw new Error(`Video response did not contain a task id: ${JSON.stringify(create).slice(0, 400)}`);
  }
  return pollOpenAIVideo(settings, exec, { base, apiKey, taskId, onProgress });
}

async function pollOpenAIVideo(settings, exec, { base, apiKey, taskId, onProgress }) {
  for (let attempt = 0; attempt < settings.maxPollAttempts; attempt += 1) {
    if (aborted(exec)) throw new Error("Video polling cancelled");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, settings.pollIntervalMs));
    const signal = signalOf(exec, settings.timeoutMs);
    const response = await fetch(joinRelayPath(base, settings.statusPathTemplate.replace("{task_id}", encodeURIComponent(taskId))), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const body = await readJsonResponse(response, "video status");
    if (!response.ok) {
      throw new Error(`Video status request failed (HTTP ${response.status}): ${JSON.stringify(body).slice(0, 400)}`);
    }
    const rawStatus = pickFirst(body, [settings.statusField, "output.status", "status", "data.status", "output.task_status"]);
    const status = String(rawStatus ?? "").toLowerCase();
    onProgress?.(taskId, rawStatus);
    if (SUCCESS_STATES.has(status)) {
      const urls = collectUrls(body, settings.urlsField);
      if (urls.length === 0) throw new Error(`video task ${taskId} completed but returned no URLs`);
      return { taskId, status: String(rawStatus), urls };
    }
    if (FAILURE_STATES.has(status)) {
      throw new Error(`video task ${taskId} failed: ${JSON.stringify(body).slice(0, 400)}`);
    }
  }
  throw new Error(`video task ${taskId} did not finish within ${settings.maxPollAttempts * settings.pollIntervalMs}ms`);
}

// ModelVerse / generic "tasks" relay protocol.
async function modelverseVideo(settings, exec, { prompt, options, media, cwd, onProgress }) {
  const base = effectiveBaseURL(settings);
  const apiKey = await resolveApiKey(settings);
  const model = options.model;
  const content = [{ type: "text", text: prompt }];
  if (media.firstFrame !== void 0) content.push({ type: "image_url", image_url: { url: media.firstFrame }, role: "first_frame" });
  if (media.lastFrame !== void 0) content.push({ type: "image_url", image_url: { url: media.lastFrame }, role: "last_frame" });
  if (media.firstFrame === void 0 && media.lastFrame === void 0) {
    for (const ref of media.references) content.push({ type: "image_url", image_url: { url: ref }, role: "reference" });
  }
  if (media.video !== void 0) content.push({ type: "video_url", video_url: { url: media.video }, role: "reference" });
  const hasFrameLocks = media.firstFrame !== void 0 || media.lastFrame !== void 0;
  const parameters = {
    duration: options.duration,
    ratio: hasFrameLocks ? "adaptive" : options.aspectRatio,
    resolution: options.resolution,
    aigc_watermark: false,
  };
  const signal = signalOf(exec, settings.timeoutMs);
  const createResponse = await fetch(joinRelayPath(base, "/tasks/submit"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: { content }, parameters }),
    signal,
  });
  const create = await readJsonResponse(createResponse, "tasks/submit");
  const taskId = pickFirst(create, ["output.task_id", "task_id", "id", "data.task_id"]);
  if (!createResponse.ok || typeof taskId !== "string" || taskId === "") {
    throw new Error(`tasks/submit (${model}) failed: ${createResponse.status} ${JSON.stringify(create.error ?? create).slice(0, 400)}`);
  }
  return pollModelverseTask(settings, exec, { base, apiKey, taskId, onProgress });
}

async function pollModelverseTask(settings, exec, { base, apiKey, taskId, onProgress }) {
  for (let attempt = 0; attempt < settings.maxPollAttempts; attempt += 1) {
    if (aborted(exec)) throw new Error("Task polling cancelled");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, settings.pollIntervalMs));
    const signal = signalOf(exec, settings.timeoutMs);
    const response = await fetch(`${joinRelayPath(base, "/tasks/status")}?task_id=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const body = await readJsonResponse(response, "tasks/status");
    const rawStatus = pickFirst(body, [settings.statusField, "output.task_status", "output.status", "status"]);
    const status = String(rawStatus ?? "").toLowerCase();
    onProgress?.(taskId, rawStatus);
    if (SUCCESS_STATES.has(status)) {
      const urls = collectUrls(body, settings.urlsField);
      if (urls.length === 0) throw new Error(`task ${taskId} succeeded but returned no result URLs`);
      return { taskId, status: String(rawStatus), urls };
    }
    if (FAILURE_STATES.has(status)) {
      throw new Error(`task ${taskId} failed: ${body?.output?.error_message ?? rawStatus ?? "unknown error"}`);
    }
  }
  throw new Error(`task ${taskId} did not finish within ${settings.maxPollAttempts * settings.pollIntervalMs}ms`);
}

// Fully configurable REST mode (escape hatch for arbitrary new-api deployments).
async function genericVideo(settings, exec, { prompt, options, media, cwd, onProgress }) {
  const base = effectiveBaseURL(settings);
  const apiKey = await resolveApiKey(settings);
  const payload = { model: options.model, prompt };
  if (options.duration > 0) payload.duration = options.duration;
  if (options.aspectRatio !== "") payload.aspect_ratio = options.aspectRatio;
  if (options.resolution !== "") payload.resolution = options.resolution;
  if (media.firstFrame !== void 0) payload.input_reference = { image_url: media.firstFrame };
  if (media.lastFrame !== void 0) payload.last_frame = media.lastFrame;
  if (media.video !== void 0) payload.video = media.video;
  if (media.references.length > 0) payload.reference_images = media.references;
  const signal = signalOf(exec, settings.timeoutMs);
  const createResponse = await fetch(joinRelayPath(base, settings.submitPath), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const create = await readJsonResponse(createResponse, `create (${settings.submitPath})`);
  if (!createResponse.ok) {
    throw new Error(`Create failed (HTTP ${createResponse.status}): ${JSON.stringify(create.error ?? create).slice(0, 400)}`);
  }
  const taskId = pickFirst(create, [settings.taskIdField, "output.task_id", "id", "task_id", "data.task_id"]);
  if (typeof taskId !== "string" || taskId === "") {
    throw new Error(`Create response did not contain a task id: ${JSON.stringify(create).slice(0, 400)}`);
  }
  for (let attempt = 0; attempt < settings.maxPollAttempts; attempt += 1) {
    if (aborted(exec)) throw new Error("Task polling cancelled");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, settings.pollIntervalMs));
    const statusSignal = signalOf(exec, settings.timeoutMs);
    const statusResponse = await fetch(joinRelayPath(base, settings.statusPathTemplate.replace("{task_id}", encodeURIComponent(taskId))), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: statusSignal,
    });
    const statusBody = await readJsonResponse(statusResponse, "status");
    if (!statusResponse.ok) {
      throw new Error(`Status request failed (HTTP ${statusResponse.status}): ${JSON.stringify(statusBody).slice(0, 400)}`);
    }
    const rawStatus = pickFirst(statusBody, [settings.statusField, "output.task_status", "output.status", "status", "data.task_status"]);
    const status = String(rawStatus ?? "").toLowerCase();
    onProgress?.(taskId, rawStatus);
    if (SUCCESS_STATES.has(status)) {
      const urls = collectUrls(statusBody, settings.urlsField);
      if (urls.length === 0) throw new Error(`task ${taskId} succeeded but returned no URLs`);
      return { taskId, status: String(rawStatus), urls };
    }
    if (FAILURE_STATES.has(status)) {
      throw new Error(`task ${taskId} failed: ${JSON.stringify(statusBody).slice(0, 400)}`);
    }
  }
  throw new Error(`task ${taskId} did not finish within ${settings.maxPollAttempts * settings.pollIntervalMs}ms`);
}

// ---------------------------------------------------------------------------
// Unified new-api /v1/videos task interface.
//
// Both Seedance 2.0 and Happyhorse are reachable through this single downstream
// endpoint (`POST {base}/v1/videos` + `GET {base}/v1/videos/{task_id}`), but the
// request body shape differs by provider, so we pick one from the model name:
//   - happyhorse-*   : top-level `size` (720p/1080p) + top-level `images` (1).
//   - doubao-seedance: `metadata.resolution`/`metadata.ratio` + `metadata.content`
//                      with first_frame/last_frame/reference_image/reference_video.
// The response is identical: `{ id/task_id, status, progress, metadata.url }`.
// ---------------------------------------------------------------------------

// Seedance 2.0 single-video task interface.
function normalizeResolution(res) {
  const s = String(res ?? "").trim().toLowerCase();
  if (s === "") return "";
  if (/4k|2160/.test(s)) return "4k";
  if (/1080p|1080|2k|1440|1920|hd/.test(s)) return "1080p";
  if (/720p|720|1280|sd/.test(s)) return "720p";
  if (/480p|480/.test(s)) return "480p";
  return s;
}
function normalizeRatio(ratio) {
  const s = String(ratio ?? "").trim().toLowerCase();
  if (s === "" || s === "auto" || s === "自动") return "auto";
  return ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"].includes(s) ? s : "16:9";
}
function modelKind(model) {
  const m = String(model ?? "");
  if (/happyhorse/i.test(m)) return "happyhorse";
  if (/doubao|seedance|volc/i.test(m)) return "seedance";
  return "generic";
}
function clampModelDuration(model, duration) {
  const kind = modelKind(model);
  const min = kind === "seedance" ? 4 : 1;
  const max = kind === "seedance" ? 15 : 60;
  const n = Math.round(Number(duration));
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : 5;
}
function buildV1Payload(model, prompt, options, media) {
  const kind = modelKind(model);
  const duration = clampModelDuration(model, options.duration);
  const payload = { model, prompt, seconds: String(duration) };
  if (kind === "happyhorse") {
    const size = normalizeResolution(options.resolution || options.size) || "720p";
    payload.size = size === "4k" ? "1080p" : size; // happyhorse only 720p/1080p
    const image = media.firstFrame || media.references[0];
    if (image !== void 0) payload.images = [image];
  } else {
    const metadata = {
      resolution: normalizeResolution(options.resolution || options.size) || "720p",
      generate_audio: true,
      watermark: false,
    };
    const ratio = normalizeRatio(options.aspectRatio);
    if (ratio !== "auto") metadata.ratio = ratio;
    const content = [];
    if (media.firstFrame !== void 0) content.push({ type: "image_url", image_url: { url: media.firstFrame }, role: "first_frame" });
    if (media.lastFrame !== void 0) content.push({ type: "image_url", image_url: { url: media.lastFrame }, role: "last_frame" });
    for (const ref of media.references) content.push({ type: "image_url", image_url: { url: ref }, role: "reference_image" });
    if (media.video !== void 0) content.push({ type: "video_url", video_url: { url: media.video }, role: "reference_video" });
    if (content.length > 0) metadata.content = content;
    payload.metadata = metadata;
  }
  return payload;
}

async function v1Video(settings, exec, { prompt, options, media, cwd, onProgress }) {
  const base = effectiveBaseURL(settings);
  const apiKey = await resolveApiKey(settings);
  const payload = buildV1Payload(options.model, prompt, options, media);
  const signal = signalOf(exec, settings.timeoutMs);
  const createResponse = await fetch(joinRelayPath(base, "/v1/videos"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const create = await readJsonResponse(createResponse, "POST /v1/videos");
  const taskId = pickFirst(create, ["id", "task_id", "output.task_id", "data.task_id"]);
  if (!createResponse.ok || typeof taskId !== "string" || taskId === "") {
    throw new Error(`POST /v1/videos (${options.model}) failed: ${createResponse.status} ${JSON.stringify(create.error ?? create).slice(0, 400)}`);
  }
  return pollV1Video(settings, exec, { base, apiKey, taskId, onProgress });
}

async function pollV1Video(settings, exec, { base, apiKey, taskId, onProgress }) {
  for (let attempt = 0; attempt < settings.maxPollAttempts; attempt += 1) {
    if (aborted(exec)) throw new Error("Task polling cancelled");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, settings.pollIntervalMs));
    const signal = signalOf(exec, settings.timeoutMs);
    const response = await fetch(joinRelayPath(base, `/v1/videos/${encodeURIComponent(taskId)}`), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const body = await readJsonResponse(response, "GET /v1/videos/{task_id}");
    const rawStatus = pickFirst(body, [settings.statusField, "status", "data.status"]);
    const status = String(rawStatus ?? "").toLowerCase();
    const progress = pickFirst(body, ["progress"]);
    onProgress?.(taskId, rawStatus, progress);
    if (SUCCESS_STATES.has(status)) {
      const urls = collectUrls(body, settings.urlsField);
      if (urls.length === 0) throw new Error(`task ${taskId} completed but returned no URLs`);
      return { taskId, status: String(rawStatus), progress, urls };
    }
    if (FAILURE_STATES.has(status)) {
      const reason = body?.error?.message ?? body?.error_message ?? body?.message;
      throw new Error(`task ${taskId} failed: ${reason ?? JSON.stringify(body).slice(0, 400)}`);
    }
  }
  throw new Error(`task ${taskId} did not finish within ${settings.maxPollAttempts * settings.pollIntervalMs}ms`);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible image generation (POST {base}/v1/images/generations).
// Unlike video it is synchronous: the relay returns the finished image(s)
// directly as `data[].url` or `data[].b64_json`.
// ---------------------------------------------------------------------------
function imageModelKind(model) {
  const m = String(model ?? "");
  if (/qwen-image|tongyi|wanx|wanxiang/i.test(m)) return "qwen";
  if (/doubao|seedream|volc/i.test(m)) return "seedream";
  return "generic";
}
function detectImageExt(bytes) {
  if (bytes && bytes.length >= 12) {
    if (bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.slice(8, 12).toString("ascii") === "WEBP") return ".webp";
  }
  if (bytes && bytes.length >= 4) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ".png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return ".jpg";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return ".gif";
  }
  return ".png";
}
function extFromImageUrl(url) {
  const m = /\.[a-z0-9]{2,5}($|\?|#)/i.exec(url ?? "");
  if (!m) return "";
  let ext = m[0].toLowerCase().replace(/[?#].*$/, "");
  if (ext === ".jpeg" || ext === ".jpg") return ".jpg";
  if (ext === ".png") return ".png";
  if (ext === ".webp") return ".webp";
  if (ext === ".gif") return ".gif";
  return "";
}
async function saveImageFromUrl(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image download failed (HTTP ${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, bytes);
  return filePath;
}
// 图改图参考图来源:本地路径 / http(s) URL => 读取字节;data URL => 解码。
async function collectEditImages(args, cwd) {
  const raw = [];
  if (cleanPath(args.image) !== "") raw.push(args.image);
  if (Array.isArray(args.images)) {
    for (const s of args.images) if (cleanPath(String(s)) !== "") raw.push(String(s));
  }
  const out = [];
  for (const src of raw.slice(0, 3)) {
    const value = cleanPath(src);
    let buffer;
    let name = "image.png";
    if (isDataUrl(value)) {
      const m = /^data:([^;]*);base64,(.*)$/is.exec(value);
      buffer = Buffer.from(m?.[2] ?? value.split(",")[1] ?? "", "base64");
    } else if (isHttpUrl(value)) {
      const response = await fetch(value);
      if (!response.ok) throw new Error(`Failed to fetch edit image (HTTP ${response.status}): ${value}`);
      buffer = Buffer.from(await response.arrayBuffer());
      name = basename(new URL(value).pathname) || "image.png";
    } else {
      const abs = resolve(cwd, value);
      buffer = await readFile(abs);
      name = basename(abs) || "image.png";
    }
    out.push({ name, buffer });
  }
  return out;
}
// 图改图:multipart 上传参考图到 /v1/images/edits。
async function postImageEdits(settings, exec, { model, prompt, n, size, quality, outputFormat, files }) {
  const base = effectiveBaseURL(settings);
  const apiKey = await resolveApiKey(settings);
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("n", String(n));
  if (quality !== "") form.append("quality", quality);
  if (outputFormat !== "") form.append("output_format", outputFormat);
  for (let i = 0; i < files.length; i += 1) {
    const key = i === 0 ? "image" : "image[]";
    form.append(key, new Blob([files[i].buffer], { type: "image/png" }), files[i].name);
  }
  const signal = signalOf(exec, settings.timeoutMs);
  const response = await fetch(joinRelayPath(base, "/v1/images/edits"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  });
  const body = await readJsonResponse(response, "POST /v1/images/edits");
  if (!response.ok) {
    const msg = body?.error?.message ?? body?.message ?? JSON.stringify(body).slice(0, 400);
    throw new Error(`POST /v1/images/edits (${model}) failed: ${response.status} ${msg}`);
  }
  return body;
}

async function generateImages(settings, exec, args, cwd) {
  const base = effectiveBaseURL(settings);
  const apiKey = await resolveApiKey(settings);
  const prompt = cleanStr(args.prompt);
  if (prompt === "") throw new Error("newapi_generate_image requires a non-empty prompt");
  if (settings?.enabled === false) throw new Error("视频工坊已关闭(「视频创作」开关关闭),请先在输入栏重新开启再生成。");
  const model = cleanStr(args.model) || settings.imageModel || "gpt-image-2";
  const size = cleanStr(args.size) || settings.imageSize || "1024x1024";
  const n = 1; // 固定每次生成 1 张;需要多张时由 agent 多次调用本工具。
  const quality = cleanStr(args.quality) || settings.imageQuality || "";
  const outputFormat = cleanStr(args.output_format);
  const negative = cleanStr(args.negative_prompt);
  const seed = args.seed;

  const editFiles = await collectEditImages(args, cwd);
  let body;
  if (editFiles.length > 0) {
    // 图改图:multipart 上传参考图 → /v1/images/edits
    body = await postImageEdits(settings, exec, { model, prompt, n, size, quality, outputFormat, files: editFiles });
  } else {
    // 文生图:JSON → /v1/images/generations
    const payload = { model, prompt, n, size, response_format: "url" };
    if (quality !== "") payload.quality = quality;
    if (outputFormat !== "") payload.output_format = outputFormat;
    if (negative !== "") payload.negative_prompt = negative;
    if (seed !== void 0 && seed !== null && seed !== "") payload.seed = Number(seed);

    const kind = imageModelKind(model);
    if (kind === "qwen") {
      // 通义原生结构透传:尺寸用 宽*高
      const params = { n, watermark: false, prompt_extend: true };
      params.size = size.includes("x") ? size.replace("x", "*") : size;
      if (negative !== "") params.negative_prompt = negative;
      if (seed !== void 0 && seed !== null && seed !== "") params.seed = Number(seed);
      payload.parameters = params;
    }

    const signal = signalOf(exec, settings.timeoutMs);
    const response = await fetch(joinRelayPath(base, "/v1/images/generations"), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    body = await readJsonResponse(response, "POST /v1/images/generations");
    if (!response.ok) {
      const msg = body?.error?.message ?? body?.message ?? JSON.stringify(body).slice(0, 400);
      throw new Error(`POST /v1/images/generations (${model}) failed: ${response.status} ${msg}`);
    }
  }
  const data = Array.isArray(body?.data) ? body.data : [];
  if (data.length === 0) {
    throw new Error(`image generation returned no images: ${JSON.stringify(body).slice(0, 400)}`);
  }
  const mediaBase = mediaRoot(settings, cwd);
  const dir = resolve(mediaBase, settings.imageOutputDir || ".");
  await mkdir(dir, { recursive: true });
  const relOf = (p) => relative(mediaBase, p);
  const served = (p) => `/newapi/assets/file?project=${encodeURIComponent(mediaBase)}&rel=${encodeURIComponent(relOf(p))}`;
  const stem = `${slugify(prompt, 30)}-${Date.now().toString(36)}`;
  const files = [];
  const urls = [];
  for (let i = 0; i < data.length; i += 1) {
    const item = data[i] ?? {};
    const url = typeof item.url === "string" && item.url !== "" ? item.url : typeof item.image_url === "string" ? item.image_url : (item.image?.url ?? "");
    const b64 = typeof item.b64_json === "string" && item.b64_json !== "" ? item.b64_json : "";
    const suffix = `${stem}-${i + 1}`;
    if (url !== "") {
      urls.push(url);
      try {
        const ext = extFromImageUrl(url) || ".png";
        const path = join(dir, `${suffix}${ext}`);
        await saveImageFromUrl(url, path);
        await addSessionFile(cwd, path);
        files.push({ path, url: served(path), remoteUrl: url, mimeType: mimeForPath(path) });
      } catch {
        files.push({ url });
      }
    } else if (b64 !== "") {
      const bytes = Buffer.from(b64, "base64");
      const ext = detectImageExt(bytes);
      const path = join(dir, `${suffix}${ext}`);
      await writeFile(path, bytes);
      await addSessionFile(cwd, path);
      urls.push(served(path));
      files.push({ path, url: served(path), mimeType: mimeForPath(path) });
    }
  }
  if (files.length === 0 && urls.length === 0) {
    throw new Error(`image generation returned no usable image: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return { model, prompt, count: files.length, urls, files };
}

// ---------------------------------------------------------------------------
// Shared generation orchestration
// ---------------------------------------------------------------------------

async function generateVideo(settings, exec, args, cwd, onProgress) {
  const prompt = cleanStr(args.prompt);
  if (prompt === "") throw new Error("newapi_generate_video requires a non-empty prompt");
  if (settings?.enabled === false) throw new Error("视频工坊已关闭(「视频创作」开关关闭),请先在输入栏重新开启再生成。");
  const videoProvider = cleanStr(settings.provider) || "newapi";
  const model = cleanStr(args.model) || cleanStr(settings.model);
  if (model === "" && videoProvider === "newapi" && settings.mode !== "generic-rest") {
    throw new Error("No video model configured. Set model in WebUI Settings → 视频工坊, or pass a model override.");
  }
  const options = {
    model,
    duration: clampInt(args.duration ?? args.seconds ?? settings.durationSeconds, 1, 60, settings.durationSeconds),
    aspectRatio: cleanStr(args.aspect_ratio) || cleanStr(settings.aspectRatio),
    size: cleanStr(args.size),
    resolution: cleanStr(args.resolution) || cleanStr(settings.resolution),
  };
  const media = {};
  // Seedance 等 v1-videos 模型:first/last frame 与 reference_images 互斥(400)。
  // 为防呆,当提供多参考图时自动忽略首/尾帧(优先多参考图锁定外观一致性)。
  const hasRefs = Array.isArray(args.reference_images) && args.reference_images.some((ref) => cleanPath(String(ref)) !== "");
  if (!hasRefs) {
    if (cleanPath(args.first_frame) !== "") media.firstFrame = await mediaToSource(args.first_frame, cwd, IMAGE_MAX_BYTES);
    if (cleanPath(args.last_frame) !== "") media.lastFrame = await mediaToSource(args.last_frame, cwd, IMAGE_MAX_BYTES);
  }
  if (cleanPath(args.video) !== "") media.video = await mediaToSource(args.video, cwd, VIDEO_MAX_BYTES);
  media.references = [];
  if (hasRefs) {
    for (const ref of args.reference_images) {
      if (cleanPath(String(ref)) !== "") media.references.push(await mediaToSource(String(ref), cwd, IMAGE_MAX_BYTES));
    }
  }

  // 硬边界:快乐马 happyhorse-* 只收 1 张图,不收 last_frame/video/aspect_ratio。
  // 传了直接报错拒收(而不是静默丢弃),让 agent 学会别传。
  if (/happyhorse/i.test(model)) {
    const unsupported = [];
    if (media.lastFrame !== void 0) unsupported.push("last_frame");
    if (media.video !== void 0) unsupported.push("video");
    if (cleanStr(args.aspect_ratio) !== "") unsupported.push("aspect_ratio");
    if (unsupported.length > 0) {
      throw new Error(
        `快乐马(happyhorse-*) 不支持: ${unsupported.join(", ")}。它只接受 first_frame(单图)/reference_images(首张)/duration/resolution。`,
      );
    }
  }

  let finished;
  if (videoProvider !== "newapi") {
    finished = await providerVideo(settings, exec, videoProvider, { prompt, options, media, cwd, onProgress });
  } else if (settings.mode === "v1-videos") {
    finished = await v1Video(settings, exec, { prompt, options, media, cwd, onProgress });
  } else if (settings.mode === "modelverse-tasks") {
    finished = await modelverseVideo(settings, exec, { prompt, options, media, cwd, onProgress });
  } else if (settings.mode === "generic-rest") {
    finished = await genericVideo(settings, exec, { prompt, options, media, cwd, onProgress });
  } else {
    finished = await openaiVideo(settings, exec, { prompt, options, media, cwd, onProgress });
  }

  const files = [];
  for (const url of finished.urls) {
    files.push({ url });
    if (files.length === 1 && /^https?:\/\//i.test(url)) {
      try {
        const path = await downloadToFile(url, settings.outputDir, mediaRoot(settings, cwd), prompt, ".mp4");
        await addSessionFile(cwd, path);
        files[0] = { path, url, mimeType: "video/mp4" };
      } catch {
        // keep the URL-only entry if the download fails
      }
    }
  }
  const result = {
    model: options.model,
    prompt,
    taskId: finished.taskId,
    status: finished.status,
    statusLabel: stateLabelOf(finished.status),
    mode: settings.mode,
    progress: finished.progress,
    urls: finished.urls,
    files,
  };
  return result;
}

// ---------------------------------------------------------------------------
// Tool presentation helpers
// ---------------------------------------------------------------------------

function objectOutput() {
  return {
    schema: { type: "object", properties: {}, additionalProperties: true },
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function presentGenerateCall(args) {
  return { card: "generic", title: cleanStr(args.prompt) || "Generate video", kind: "video" };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function registerTools(ctx, settings) {
  const disposers = [];
  const current = settings();
  const generateTimeout = Math.max(current.timeoutMs, current.pollIntervalMs * current.maxPollAttempts + 60000);

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "newapi_generate_video",
        description:
          "Generate a video through the NewAPI relay station's video model. Use it when the user asks for a video, or references materials with @ (images/videos) plus a prompt. Pass @-referenced file paths as first_frame (image-to-video first frame), last_frame (first+last frame), video (source video), or reference_images (appearance consistency). IMPORTANT constraints: first_frame/last_frame are mutually exclusive with reference_images (passing both fails); Happyhorse models (happyhorse-*) accept only ONE reference image and reject last_frame/video/aspect_ratio; always pass @-referenced absolute paths, never relative paths.",
        parameters: {
          prompt: { type: "string", required: true, description: "Video prompt: concrete motion, subject, environment, style, lighting, lens. Describe what happens in the shot." },
          first_frame: { type: "string", description: "Optional @-referenced image path for image-to-video (the starting first frame). Mutually exclusive with reference_images." },
          last_frame: { type: "string", description: "Optional @-referenced image path for the ending last frame (first+last-frame video). Mutually exclusive with reference_images. Not supported by Happyhorse." },
          video: { type: "string", description: "Optional @-referenced source video path for video-to-video. Not supported by Happyhorse." },
          reference_images: { type: "array", items: { type: "string" }, description: "Optional @-referenced image paths for character/appearance consistency. Mutually exclusive with first_frame/last_frame. Happyhorse accepts only one image." },
          aspect_ratio: { type: "string", description: "Aspect ratio: 16:9, 9:16, 1:1, 4:3, 3:4, 21:9. Not supported by Happyhorse." },
          duration: { type: "number", description: "Target duration in seconds, e.g. 5." },
          size: { type: "string", description: "Optional output size in pixels, e.g. 1280x720 (openai-videos mode only)." },
          resolution: { type: "string", enum: ["480p", "720p", "1080p", "2K", "4k"], description: "Output tier: v1-videos uses lowercase 480p/720p/1080p/4k; modelverse-tasks uses 2K. Seedance does not support 2K." },
          model: { type: "string", description: "Optional model id overriding the configured model for this call." },
          role: { type: "string", description: "Optional pipeline role: turntable | shot | edit. Omit for ordinary generation (no shot ledger, no confirm bar)." },
          shot_id: { type: "string", description: "Optional shot id such as Video_01. Required to record shot/edit. Turntable is always stored as _turntable." },
        },
        output: objectOutput(),
        timeoutMs: generateTimeout,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const cwd = sessionCwd(exec);
          const current = settings();
          const prompt = cleanStr(args.prompt);
          const ledger = new TaskLedger(resolve(cwd, current.outputDir, ".tasks.json"));
          const markProgress = (taskId, state, progress) => ledger.upsert({
            taskId,
            project: cwd,
            mode: current.mode,
            prompt,
            state: String(state ?? "running") || "running",
            stateLabel: stateLabelOf(state),
            progress: typeof progress === "number" ? Math.round(progress) : void 0,
            at: Date.now(),
          }).catch(() => {});
          const result = await generateVideo(current, exec, args, cwd, markProgress);
          await ledger.upsert({
            taskId: result.taskId,
            project: cwd,
            model: result.model,
            mode: result.mode,
            prompt: result.prompt,
            state: result.status,
            stateLabel: result.statusLabel,
            progress: typeof result.progress === "number" ? Math.round(result.progress) : void 0,
            at: Date.now(),
            urls: result.urls,
            files: result.files,
          }).catch(() => {});
          const extra = await recordGeneration(cwd, args, result);
          return extra.role ? { ...result, ...extra } : result;
        },
        presentCall: presentGenerateCall,
        presentResult: (args, result) => {
          if (result.isError) return void 0;
          const files = Array.isArray(result.value?.files) ? result.value.files : [];
          const first = files[0];
          return {
            card: "generic",
            kind: "video",
            title: cleanStr(args.prompt) || "Generated video",
            rawInput: first?.path ?? first?.url ?? "",
          };
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "newapi_generate_image",
        description:
          "Generate or edit a single image through the NewAPI relay station's image model. Without a reference image it POSTs an OpenAI-compatible /v1/images/generations; with @-referenced image(s) it POSTs a multipart /v1/images/edits to apply the prompt as edits. Generates exactly one image per call — call it multiple times when the user needs several images. Saves the image into the workspace image output directory, which also appears in the asset library.",
        parameters: {
          prompt: { type: "string", required: true, description: "Image prompt: subject, scene, style, lighting, composition, quality. For edits, this is the edit instruction (e.g. 'change the background to blue')." },
          image: { type: "string", description: "Optional single @-referenced image path/URL to edit (image-to-image). Passing it switches to the edits endpoint." },
          images: { type: "array", items: { type: "string" }, description: "Optional 1-3 @-referenced source images for multi-image editing (use instead of image when editing several images together)." },
          size: { type: "string", description: "Image size: 1024x1024 for OpenAI-style models, or 宽*高 (e.g. 2048*2048) for qwen-image." },
          quality: { type: "string", description: "Quality tier, model-dependent: auto/standard/hd/high/medium/low. Omit to use the provider default." },
          negative_prompt: { type: "string", description: "Optional negative prompt describing what to avoid." },
          seed: { type: "number", description: "Optional random seed for reproducible results." },
          output_format: { type: "string", enum: ["png", "jpeg", "webp"], description: "Output image format." },
          model: { type: "string", description: "Optional image model id overriding the configured imageModel." },
          role: { type: "string", description: "Optional pipeline role: turntable | shot | edit. Omit for ordinary generation (no shot ledger, no confirm bar)." },
          shot_id: { type: "string", description: "Optional shot id such as Hero_01. Required to record shot/edit. Turntable is always stored as _turntable." },
        },
        output: objectOutput(),
        timeoutMs: generateTimeout,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const cwd = sessionCwd(exec);
          const result = await generateImages(settings(), exec, args, cwd);
          const extra = await recordGeneration(cwd, args, result);
          return extra.role ? { ...result, ...extra } : result;
        },
        presentCall: (args) => ({ card: "generic", title: cleanStr(args.prompt) || "Generate image", kind: "image" }),
        presentResult: (args, result) => {
          if (result.isError) return void 0;
          const files = Array.isArray(result.value?.files) ? result.value.files : [];
          const first = files[0];
          return {
            card: "generic",
            kind: "image",
            title: cleanStr(args.prompt) || "Generated image",
            rawInput: first?.path ?? first?.url ?? "",
          };
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "newapi_task_status",
        description:
          "Inspect NewAPI video tasks persisted in the local task ledger. Without task_id, returns the most recent tasks; with task_id, returns that task's latest record. Use it to recover tasks whose original generation call timed out or whose session was interrupted.",
        parameters: {
          task_id: { type: "string", description: "Optional provider task id; omit to list recent tasks." },
          limit: { type: "number", description: "Max tasks to list when task_id is omitted (default 10, max 50)." },
        },
        output: objectOutput(),
        timeoutMs: 15000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const cwd = sessionCwd(exec);
          const current = settings();
          const ledgerNow = new TaskLedger(resolve(cwd, current.outputDir, ".tasks.json"));
          const taskId = cleanStr(args.task_id);
          if (taskId !== "") {
            const record = await ledgerNow.get(taskId);
            return record === void 0 ? { task_id: taskId, found: false } : { task_id: taskId, found: true, task: record };
          }
          const limit = clampInt(args.limit ?? 10, 1, 50, 10);
          const tasks = await ledgerNow.list(limit);
          return { tasks, count: tasks.length };
        },
      }),
    ),
  );

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: "newapi_assets",
        description:
          "List media assets (video / image / audio) currently in the workspace. Returns a structured list with clickable preview URLs. Use it to inspect what has been generated or downloaded.",
        parameters: {
          kind: { type: "string", enum: ["video", "image", "audio"], description: "Optional filter by media type. Omit to list everything." },
        },
        output: objectOutput(),
        timeoutMs: 20000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const cwd = sessionCwd(exec);
          const filter = cleanStr(args.kind).toLowerCase();
          const all = await listAssets(cwd);
          const assets = filter === "" ? all : all.filter((a) => a.kind === filter);
          return { project: cwd, count: assets.length, assets };
        },
      }),
    ),
  );

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // ignore teardown errors
      }
    }
  };
}

function registerGuidance(ctx, settings) {
  const toolLine =
    settings.mode === "v1-videos"
      ? `The relay exposes the new-api /v1/videos task interface at ${effectiveBaseURL(settings)}.`
      : settings.mode === "modelverse-tasks"
        ? `The relay uses the "tasks" protocol (${effectiveBaseURL(settings)}).`
        : `The relay exposes an OpenAI-compatible video endpoint at ${effectiveBaseURL(settings)}${settings.submitPath}.`;
  return ctx.systemPrompt.section({
    name: "tool:newapi-video",
    order: 3000,
    text: [
      "## 视频工坊 video & image generation",
      "",
      "## 方向门控 (生成前必选方向 —— 必须遵守)",
      "- 调用 newapi_generate_video / newapi_generate_image 之前,必须先确定「方向(skill)」,并与用户确认;缺少方向时不得调用生成工具。",
      "- 默认方向:电商视觉套件 ecommerce-visual-suite(电商主图/详情图/宣传视频)。用户明确指定其它 skill/方向时,按该 skill 的流程执行。",
      "- 未锁定「方向 + 规格(模型/画幅/时长/张数)」之前,一律不得调用生成工具。",
      "- 方向不明确时先问用户(如「用哪个方向?电商视觉套件 / 宣传视频 / 其它」),不要替用户猜。",
      `When the user asks for a video, or references materials with @ (images/videos) plus a prompt, use the newapi_generate_video tool. ${toolLine}`,
      "The configured video model is " + (settings.model === "" ? "unset (set it in Settings → 视频工坊, or pass a model override)" : settings.model) + ".",
      "When the user asks for an image / picture / photo / illustration, use the newapi_generate_image tool; it POSTs an OpenAI-compatible /v1/images/generations request and saves the resulting image file(s) to the workspace image directory.",
      "To EDIT an existing image, pass @-referenced source image(s) as `image` (single) or `images` (1-3) plus the edit instruction as `prompt`; the tool uploads them as multipart to /v1/images/edits automatically.",
      "The configured image model is " + (settings.imageModel === "" ? "unset (set it in Settings → 视频工坊, or pass a model override)" : settings.imageModel) + ".",
      "- Pass @-referenced image files as `first_frame` (image-to-video) or `reference_images`; a source video as `video` (mode-dependent).",
      "- v1-videos auto-detects the payload: Happyhorse (happyhorse-*) uses one reference `image`; Seedance (doubao-seedance-*) uses first_frame/last_frame/reference_image/reference_video. Seconds are sent as a string; resolution is lowercase (720p/1080p).",
      "- Confirm a @-referenced path exists (use the read tool) before passing it; do not claim a file exists without checking.",
      "- After a timeout or interruption, recover with newapi_task_status instead of blindly re-submitting.",
      "- Report the returned video/image path/URL and task id when done.",
      "",
      "## 使用边界 (Boundaries —— 必须遵守)",
      "- 仅在用户明确要求 视频/图片/改图 时才调用对应工具;不主动生成、不额外多做。",
      "- 生成前若不确定(模型/画幅/时长/张数),先向用户确认,不擅自决定。默认:视频 5s/720p,图片每次 1 张。",
      "- 使用配置的默认模型;仅当用户显式指定 model 时才覆盖,不自行换模型。",
      "- @ 引用文件必须先 read 确认存在,否则不要传;不得声称文件存在而未检查。",
      "- 勿传不支持的参数:快乐马 happyhorse-* 不接受 last_frame/video/aspect_ratio(传了会报错拒收);first_frame/last_frame 与 reference_images 互斥。",
      "- 失败或超时用 newapi_task_status 查询,不要重复提交同一任务。",
      "- ⛔ 禁止私自复制/重命名/移动/删除 生成的媒体文件。工具返回的路径 = 最终文件。想换文件名先问用户;不得用「复制后改名」的方式(会产生内容重复的副本,让用户误以为生成了多个视频/图片)。",
      "- 每次调用后回报:文件路径/URL 与 task id。",
    ].join("\n"),
  });
}

// ---------------------------------------------------------------------------
// Live-progress HTTP route: the client card polls this while a generation runs.
// Scoped by **project** (workspace root) so concurrent generations in different
// workspaces never read each other's task ledger. The client sends the project
// via the `x-newapi-project` header and the `project` (or `cwd`) query param.
// ---------------------------------------------------------------------------

function projectFromRequest(request) {
  const header = request.headers?.["x-newapi-project"];
  if (typeof header === "string" && header.trim() !== "") return header.trim();
  const url = request.url ?? "";
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return void 0;
  const value = new URLSearchParams(url.slice(queryStart + 1)).get("project");
  return value !== null && value.trim() !== "" ? value.trim() : void 0;
}
function resolveRequestProject(ctx, request) {
  const requested = projectFromRequest(request);
  if (requested !== void 0 && requested !== "") return resolve(requested);
  // legacy fallback: raw cwd query param
  try {
    const cwd = new URL(request.url, "http://localhost").searchParams.get("cwd");
    if (typeof cwd === "string" && cwd.trim() !== "") return resolve(cwd);
  } catch {
    // ignore
  }
  return process.cwd();
}
// Known workspace roots (from the DSH workspace registry, falling back to the
// persisted workspace.json under DSH_HOME). Returns absolute, normalized paths.
function listWorkspaceRoots(ctx) {
  const roots = [];
  const registry = ctx?.get?.("workspaceRegistry") ?? ctx?.get?.("workspace");
  try {
    const live = typeof registry?.list === "function" ? registry.list() : void 0;
    const items = Array.isArray(live) ? live : void 0;
    if (items) {
      for (const item of items) {
        const p = typeof item === "string" ? item : item?.path;
        if (typeof p === "string" && p.trim() !== "") roots.push(resolve(p));
      }
    }
  } catch {
    // registry unavailable or erroring -> fall through to disk
  }
  if (roots.length === 0) {
    try {
      const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
      const parsed = JSON.parse(readFileSync(join(home, "storages", "workspace.json"), "utf8"));
      const table = parsed?.tables?.workspaces ?? {};
      for (const record of Object.values(table)) {
        if (typeof record?.path === "string" && record.path !== "") roots.push(resolve(record.path));
      }
    } catch {
      // cannot read the workspace list -> we will be lenient (allow)
    }
  }
  return roots;
}
// 跨平台路径归一化:用 node:path 解析(自动用当前 OS 分隔符);匹配时仅在 Windows
// 大小写不敏感,其它系统大小写敏感,符合各自文件系统语义。
const normPath = (p) => {
  const s = resolve(p).replace(/[\\/]+$/g, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};
// 全局媒体存储根:设置了 storageDir 就用它,否则回退到 fallback(通常为会话工作区)。
const mediaRoot = (settings, fallback) => {
  const s = String(settings?.storageDir ?? "").trim();
  return s !== "" ? resolve(s) : fallback;
};
// 允许读写/预览的路径:所有已知工作区 + 可选全局存储目录。
// 保持宽松——否则从任意已注册工作区上传/预览会被 403。
function allowedPaths(ctx, settings) {
  const roots = listWorkspaceRoots(ctx);
  const s = String(settings?.storageDir ?? "").trim();
  if (s !== "") roots.unshift(resolve(s));
  return roots;
}
// 全局资产库的唯一来源目录:配置了 storageDir 就用它;否则默认当前会话工作区。
function mediaStoreRoots(ctx, settings) {
  const s = String(settings?.storageDir ?? "").trim();
  return s !== "" ? [resolve(s)] : [currentWorkspacePath(ctx)];
}
// Lenient validation: if we cannot determine a known-workspace list, allow;
// otherwise the project must resolve to one of the known workspace roots (or the
// configured global storage dir). Passing `settings` lets it also accept the
// shared media store root; without settings it checks the workspace roots only.
function isKnownProject(ctx, project, settings) {
  const target = typeof project === "string" ? project.trim() : "";
  if (target === "") return true;
  const allowed = allowedPaths(ctx, settings);
  if (allowed.length === 0) return true;
  const normTarget = normPath(target);
  return allowed.some((p) => normPath(p) === normTarget);
}
// Pick the workspace a live session (the conversation currently being viewed) is
// rooted at. The asset-library tab must show the CURRENT conversation's media,
// so we must NOT blindly fall back to the first registered root (which may be a
// different workspace — the cause of "有图没视频").
function currentWorkspacePath(ctx) {
  try {
    const roots = listWorkspaceRoots(ctx);
    if (roots.length === 0) return process.cwd();
    const normalized = roots.map((p) => normPath(p));
    const sessions = ctx?.get?.("sessions");
    let best = "";
    let bestRank = -1;
    if (sessions && typeof sessions.list === "function") {
      const live = Array.isArray(sessions.list()) ? sessions.list() : [];
      const rankOf = (session) => {
        const d = Date.parse(session?.header?.updatedAt ?? session?.header?.createdAt ?? "");
        return Number.isFinite(d) ? d : -1;
      };
      for (const session of live) {
        const cwd = session?.header?.cwd ?? session?.cwd;
        if (typeof cwd === "string" && cwd.trim() !== "") {
          const hit = normalized.indexOf(normPath(cwd));
          if (hit >= 0) {
            const r = rankOf(session);
            if (r > bestRank) {
              bestRank = r;
              best = roots[hit];
            }
          }
        }
      }
    }
    return best !== "" ? best : roots[0];
  } catch {
    return process.cwd();
  }
}

// ---------------------------------------------------------------------------
// Asset library: list + serve media files (video / image / audio) in the
// project workspace. The client calls `/newapi/assets` to enumerate and
// `/newapi/assets/file?rel=...` to stream a specific file for preview.
// ---------------------------------------------------------------------------

const MEDIA_EXT = {
  video: [".mp4", ".mov", ".mkv", ".webm", ".avi", ".flv", ".m4v"],
  image: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp"],
  audio: [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"],
};
const MIME_MAP = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".m4v": "video/x-m4v",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
};
function mediaKind(ext) {
  const e = String(ext).toLowerCase();
  for (const kind of Object.keys(MEDIA_EXT)) {
    if (MEDIA_EXT[kind].includes(e)) return kind;
  }
  return void 0;
}
function mimeOf(ext) {
  return MIME_MAP[String(ext).toLowerCase()] ?? "application/octet-stream";
}
async function walkMedia(dir, depth, root, out, sessionSet) {
  if (depth > 8) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.startsWith(".")) continue;
      await walkMedia(full, depth + 1, root, out, sessionSet);
    } else if (ent.isFile()) {
      const kind = mediaKind(extname(ent.name));
      if (kind === void 0) continue;
      const rel = relative(root, full).replace(/\\/g, "/");
      if (sessionSet && !sessionSet.has(rel)) continue;
      try {
        const info = await stat(full);
        out.push({
          rel,
          name: ent.name,
          kind,
          mimeType: mimeOf(extname(ent.name)),
          size: info.size,
          mtime: info.mtimeMs,
          url: `/newapi/assets/file?project=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}`,
        });
      } catch {
        // ignore unreadable entry
      }
    }
  }
}
async function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}
// 内容去重:同 SHA256 的副本只保留一个。优先级:台账里的真实生成文件 > 更新 mtime > 更短路径。
// 这样 agent 手动复制改名的副本不会在资产库重复出现,避免「看起来生成了两个」。
async function dedupeAssets(root, assets, ledgerSet) {
  const bySize = new Map();
  for (const a of assets) {
    const k = String(a.size);
    if (!bySize.has(k)) bySize.set(k, []);
    bySize.get(k).push(a);
  }
  const kept = [];
  for (const group of bySize.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const bestByHash = new Map();
    for (const a of group) {
      let hash;
      try {
        hash = await sha256File(resolve(root, a.rel));
      } catch {
        hash = "unreadable:" + a.rel;
      }
      const prev = bestByHash.get(hash);
      if (prev === void 0) {
        bestByHash.set(hash, a);
        continue;
      }
      // 保留优先级更高的替代项
      const rank = (x) => {
        const led = ledgerSet && ledgerSet.has(x.rel) ? 0 : 1;
        const mtime = x.mtime ?? 0;
        const len = (x.rel ?? "").length;
        return { led, mtime, len };
      };
      const cmp = rank(a);
      const old = rank(prev);
      if (cmp.led < old.led || (cmp.led === old.led && cmp.mtime > old.mtime) || (cmp.led === old.led && cmp.mtime === old.mtime && cmp.len < old.len)) {
        bestByHash.set(hash, a);
      }
    }
    kept.push(...bestByHash.values());
  }
  kept.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  return kept;
}
async function listAssets(project, sessionOnly) {
  const root = resolve(project);
  let sessionSet;
  if (sessionOnly) sessionSet = await readSessionLedger(project);
  const found = [];
  await walkMedia(root, 0, root, found, sessionSet);
  found.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  const ledger = await readSessionLedger(project);
  return dedupeAssets(root, found, ledger);
}
// 全局资产库:汇总所有已知工作区(+ 可选的全局存储目录)的媒体,不去按会话/工作区分开。
// 每个条目带上 `project`(所属工作区),跨工作区按绝对路径去重。
async function listAssetsGlobal(ctx, sessionOnly, settings) {
  const roots = mediaStoreRoots(ctx, settings);
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    let items = [];
    try {
      items = await listAssets(root, sessionOnly);
    } catch {
      items = [];
    }
    for (const a of items) {
      const key = normPath(resolve(root, a.rel));
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ...a, project: root });
    }
  }
  found.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  return found;
}
function registerAssetsRoute(ctx, settings, setEnabled) {
  const webServer = ctx?.get?.("webServer");
  if (webServer === void 0 || typeof webServer.register !== "function") return () => {};
  let disposed = false;
  // Mirrors /newapi/tasks scoping: resolve the project and reject unknown ones.
  const resolveProjectChecked = (request, response) => {
    let project;
    try {
      project = resolveRequestProject(ctx, request);
    } catch {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("unknown project");
      return void 0;
    }
    if (!isKnownProject(ctx, project, settings())) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("unknown project");
      return void 0;
    }
    return project;
  };
  const disposers = [];
  // Discovery: return the known workspace roots so the client can auto-fill the
  // project path without the user typing it. `project` is the first root, or
  // process.cwd() when no workspace registry is available.
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/newapi/workspace",
      handler: (request, response) => {
        let roots = [];
        try {
          roots = listWorkspaceRoots(ctx);
        } catch {
          roots = [];
        }
        // 资产库属于「当前查看的会话」的工作区,不是第一个注册根。
        const picked = currentWorkspacePath(ctx);
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ project: picked, workspaces: roots }));
      },
    }),
  );
  // 视频创作模式开关(服务端读取/写入)。
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/newapi/mode",
      handler: async (request, response) => {
        if (request.method === "POST") {
          const chunks = [];
          try {
            for await (const chunk of request) chunks.push(chunk);
          } catch {
            response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            response.end("bad body");
            return;
          }
          let payload;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            response.end("invalid json");
            return;
          }
          const enabled = payload?.enabled !== false;
          if (typeof setEnabled === "function") setEnabled(enabled);
          response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify({ enabled }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ enabled: settings().enabled !== false }));
      },
    }),
  );
  // Remote model list: fetch the relay's /v1/models so the settings UI can offer
  // the actual available model ids for the model pickers.
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/newapi/models",
      handler: async (request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
          response.end("method not allowed");
          return;
        }
        const current = settings();
        let models = [];
        try {
          const base = effectiveBaseURL(current);
          const apiKey = await resolveApiKey(current);
          const r = await fetch(joinRelayPath(base, "/v1/models"), {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15000),
          });
          if (r.ok) {
            const j = await r.json();
            models = Array.isArray(j?.data) ? j.data.map((m) => m?.id).filter((id) => typeof id === "string" && id !== "") : [];
          }
        } catch {
          models = [];
        }
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ baseURL: effectiveBaseURL(current), count: models.length, models }));
      },
    }),
  );
  // Settings UI: which Base URL / API Key is actually in use (plugin vs 模型配置).
  // Does not return the raw key — only a mask so the password box is not blank.
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/newapi/settings-status",
      handler: async (request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
          response.end("method not allowed");
          return;
        }
        const current = settings();
        const modelCfg = readModelConfig();
        const ownKey = ownApiKey(current);
        const apiKeySource = await apiKeySourceOf(current);
        const baseURLSource = baseURLSourceOf(current);
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({
          baseURL: effectiveBaseURL(current),
          baseURLSource,
          pluginBaseURL: String(current.baseURL ?? "").trim(),
          modelConfigBaseURL: modelCfg.baseURL,
          apiKeySource,
          apiKeySet: ownKey !== "",
          apiKeyMasked: ownKey !== "" ? maskApiKey(ownKey) : "",
          modelConfigKeySet: apiKeySource === "model-config",
        }));
      },
    }),
  );
  // Preview a @-referenced media file by raw path (the `@path` mention typed in
  // the composer). Streams the bytes for `<img>` and Range-capable `<video>` so
  // the browser can grab the first frame as a poster without downloading the
  // whole file. Paths are resolved against the request project (or an absolute
  // path) and confined to a known workspace root.
  function parseRangeHeader(header, size) {
    if (typeof header !== "string" || header === "") return null;
    const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
    if (!m) return null;
    if (m[1] === "" && m[2] === "") return null;
    let start;
    let end;
    if (m[1] === "") {
      const suffix = parseInt(m[2], 10);
      if (!Number.isFinite(suffix) || suffix <= 0) return null;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] === "" ? size - 1 : parseInt(m[2], 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      end = Math.min(end, size - 1);
    }
    if (start < 0 || start >= size || end < start) return null;
    return { start, end };
  }
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/newapi/preview",
      handler: async (request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
          response.end("method not allowed");
          return;
        }
        let rawPath = "";
        let projectParam = "";
        try {
          const url = new URL(request.url, "http://localhost");
          rawPath = url.searchParams.get("path") ?? "";
          projectParam = url.searchParams.get("project") ?? "";
        } catch {
          rawPath = "";
        }
        if (rawPath === "") {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("missing path");
          return;
        }
        let project;
        try {
          project = projectParam !== "" ? resolve(projectParam) : resolveRequestProject(ctx, request);
        } catch {
          project = process.cwd();
        }
        let full = resolve(project, rawPath);
        let info;
        try {
          info = await stat(full);
        } catch {
          // @ 引用可能只写了文件名、实际在子目录(如 newapi_image/)。按文件名兜底搜索。
          full = await findMediaByName(project, basename(rawPath));
          if (full === void 0) {
            response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            response.end("not found");
            return;
          }
          try {
            info = await stat(full);
          } catch {
            response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            response.end("not found");
            return;
          }
        }
        if (!info.isFile()) {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("not found");
          return;
        }
        const ext = extname(full).toLowerCase();
        const isImage = IMG_EXT_SET.has(ext);
        const isVideo = VID_EXT_SET.has(ext);
        if (!isImage && !isVideo) {
          response.writeHead(415, { "content-type": "text/plain; charset=utf-8" });
          response.end("unsupported media type");
          return;
        }
        const roots = allowedPaths(ctx, settings());
        const allowed = roots.length === 0 || roots.some((r) => full === r || full.startsWith(r + "\\") || full.startsWith(r + "/"));
        if (!allowed) {
          response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          response.end("forbidden");
          return;
        }
        const contentType = mimeOf(ext);
        if (request.method === "HEAD") {
          response.writeHead(200, { "content-type": contentType, "content-length": info.size, "accept-ranges": "bytes", "cache-control": "no-store" });
          response.end();
          return;
        }
        const range = parseRangeHeader(request.headers.range, info.size);
        if (range === null) {
          response.writeHead(200, { "content-type": contentType, "content-length": info.size, "accept-ranges": "bytes", "cache-control": "no-store" });
          const stream = createReadStream(full);
          stream.on("error", () => response.destroy());
          stream.pipe(response);
          return;
        }
        response.writeHead(206, {
          "content-type": contentType,
          "content-range": `bytes ${range.start}-${range.end}/${info.size}`,
          "content-length": range.end - range.start + 1,
          "accept-ranges": "bytes",
          "cache-control": "no-store",
        });
        const stream = createReadStream(full, { start: range.start, end: range.end });
        stream.on("error", () => response.destroy());
        stream.pipe(response);
      },
    }),
  );
  // Upload media (image/video) into the workspace asset library. The client POSTs
  // the raw file bytes as the body plus `name`/`project` query params; the host
  // classifies the bytes, saves them under the image output dir, and returns the
  // new file so the asset library can list it and the user can @ it.
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/newapi/upload",
      handler: async (request, response) => {
        if (request.method !== "POST") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
          response.end("method not allowed");
          return;
        }
        let name = "upload";
        let projectParam = "";
        try {
          const url = new URL(request.url, "http://localhost");
          name = url.searchParams.get("name") ?? "upload";
          projectParam = url.searchParams.get("project") ?? "";
        } catch {
          name = "upload";
        }
        let project;
        try {
          project = projectParam !== "" ? resolve(projectParam) : resolveRequestProject(ctx, request);
        } catch {
          project = process.cwd();
        }
        if (!isKnownProject(ctx, project, settings())) {
          response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          response.end("forbidden");
          return;
        }
        const chunks = [];
        try {
          for await (const chunk of request) chunks.push(chunk);
        } catch {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("bad body");
          return;
        }
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("empty body");
          return;
        }
        const ext = detectMediaExt(name, buf);
        if (ext === void 0) {
          response.writeHead(415, { "content-type": "text/plain; charset=utf-8" });
          response.end("unsupported media type");
          return;
        }
        const current = settings();
        const outDir = resolve(mediaRoot(current, project), (current.imageOutputDir || "newapi_image").replace(/^[\\/]+/, ""));
        try {
          await mkdir(outDir, { recursive: true });
        } catch {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          response.end("mkdir failed");
          return;
        }
        const rawBase = basename(name, extname(name)).replace(/[^\w\-.\u4e00-\u9fa5]+/g, "_").slice(0, 120);
        const safeBase = rawBase === "" ? "upload" : rawBase;
        let dest = resolve(outDir, safeBase + ext);
        let counter = 1;
        while (true) {
          try {
            await stat(dest);
            dest = resolve(outDir, `${safeBase}-${counter}${ext}`);
            counter += 1;
          } catch {
            break;
          }
        }
        try {
          await writeFile(dest, buf);
          await addSessionFile(project, dest);
        } catch {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          response.end("write failed");
          return;
        }
        const rel = relative(project, dest).replace(/\\/g, "/");
        const kind = VID_EXT_SET.has(ext) ? "video" : "image";
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({
          file: {
            name: basename(dest),
            path: dest,
            rel,
            kind,
            mimeType: mimeOf(ext),
            size: buf.length,
            url: `/newapi/preview?path=${encodeURIComponent(rel)}&project=${encodeURIComponent(project)}`,
          },
        }));
      },
    }),
  );
  // 智能创作·批量生成:按策划清单逐个生成图片/视频,复用现有生成逻辑。
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/newapi/smart-generate",
      handler: async (request, response) => {
        if (request.method !== "POST") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
          response.end("method not allowed");
          return;
        }
        const chunks = [];
        try {
          for await (const chunk of request) chunks.push(chunk);
        } catch {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("bad body");
          return;
        }
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("invalid json");
          return;
        }
        const project = typeof payload.project === "string" ? resolve(payload.project) : "";
        if (project === "" || !isKnownProject(ctx, project, settings())) {
          response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          response.end("forbidden");
          return;
        }
        const exec = { agent: { session: { header: { cwd: project } } } };
        const current = settings();
        const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
        const results = [];
        for (const t of tasks) {
          const name = typeof t.name === "string" && t.name !== "" ? t.name : (t.kind === "video" ? "视频" : "图片");
          try {
            if (t.kind === "video") {
              const args = {
                prompt: cleanStr(t.prompt),
                model: cleanStr(t.model),
                duration: t.duration,
                aspect_ratio: cleanStr(t.aspect_ratio),
                resolution: cleanStr(t.resolution),
              };
              if (cleanStr(t.first_frame) !== "") args.first_frame = t.first_frame;
              if (Array.isArray(t.reference_images) && t.reference_images.length) args.reference_images = t.reference_images;
              const r = await generateVideo(current, exec, args, project, () => {});
              results.push({ kind: "video", name, ok: true, taskId: r.taskId, urls: r.urls, files: r.files, status: r.statusLabel });
            } else {
              const args = {
                prompt: cleanStr(t.prompt),
                model: cleanStr(t.model),
                size: cleanStr(t.size),
                n: 1,
              };
              const refs = Array.isArray(t.reference) ? t.reference.filter((s) => cleanStr(String(s)) !== "") : [];
              if (refs.length > 0) args.images = refs;
              const r = await generateImages(current, exec, args, project);
              results.push({ kind: "image", name, ok: true, urls: r.urls, files: r.files });
            }
          } catch (err) {
            results.push({ kind: t.kind === "video" ? "video" : "image", name, ok: false, error: String(err?.message ?? err) });
          }
        }
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ results }));
      },
    }),
  );
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/newapi/assets",
      handler: async (request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
          response.end("method not allowed");
          return;
        }
        let scope = "";
        try {
          scope = new URL(request.url, "http://localhost").searchParams.get("scope") ?? "";
        } catch {
          scope = "";
        }
        if (scope === "global") {
          // 全局模式:无需 project,汇总所有已知工作区媒体(不按会话/工作区分开)。
          let assets = [];
          try {
            assets = await listAssetsGlobal(ctx, false, settings());
          } catch {
            assets = [];
          }
          response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify({ project: "", scope: "global", count: assets.length, assets }));
          return;
        }
        const project = resolveProjectChecked(request, response);
        if (project === void 0) return;
        const sessionOnly = scope === "session";
        let assets = [];
        try {
          assets = await listAssets(project, sessionOnly);
        } catch {
          assets = [];
        }
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ project, scope: sessionOnly ? "session" : "all", count: assets.length, assets }));
      },
    }),
  );
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/newapi/assets/file",
      handler: async (request, response) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
          response.end("method not allowed");
          return;
        }
        const project = resolveProjectChecked(request, response);
        if (project === void 0) return;
        let rel = "";
        try {
          rel = new URL(request.url, "http://localhost").searchParams.get("rel") ?? "";
        } catch {
          rel = "";
        }
        if (rel === "") {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("missing rel");
          return;
        }
        const root = resolve(project);
        const full = resolve(root, rel);
        if (full !== root && !full.startsWith(root + "\\") && !full.startsWith(root + "/")) {
          response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          response.end("forbidden");
          return;
        }
        let info;
        try {
          info = await stat(full);
        } catch {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("not found");
          return;
        }
        if (!info.isFile()) {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("not found");
          return;
        }
        response.writeHead(200, { "content-type": mimeOf(extname(full)), "content-length": info.size, "cache-control": "no-store" });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        const stream = createReadStream(full);
        stream.on("error", () => {
          response.destroy();
        });
        stream.pipe(response);
      },
    }),
  );
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/newapi/assets/thumb",
      handler: async (request, response) => {
        if (request.method !== "GET") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
          response.end("method not allowed");
          return;
        }
        const project = resolveProjectChecked(request, response);
        if (project === void 0) return;
        let rel = "";
        let w = 200;
        try {
          const url = new URL(request.url, "http://localhost");
          rel = url.searchParams.get("rel") ?? "";
          const p = parseInt(url.searchParams.get("w") ?? "200", 10);
          if (!Number.isNaN(p) && p > 0) w = Math.min(p, 512);
        } catch {
          rel = "";
        }
        if (rel === "") {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("missing rel");
          return;
        }
        const root = resolve(project);
        const full = resolve(root, rel);
        if (full !== root && !full.startsWith(root + "\\") && !full.startsWith(root + "/")) {
          response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          response.end("forbidden");
          return;
        }
        const ext = extname(full).toLowerCase();
        const isImage = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp"].includes(ext);
        if (!isImage) {
          response.writeHead(415, { "content-type": "text/plain; charset=utf-8" });
          response.end("not an image");
          return;
        }
        let sharp = null;
        try {
          const mod = await import("sharp");
          sharp = mod?.default ?? mod;
        } catch {
          sharp = null;
        }
        const contentType = mimeOf(ext);
        if (sharp === null || typeof sharp !== "function") {
          // fallback: stream the original file so previews still work
          let info;
          try {
            info = await stat(full);
          } catch {
            response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            response.end("not found");
            return;
          }
          response.writeHead(200, { "content-type": contentType, "content-length": info.size, "cache-control": "no-store" });
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          createReadStream(full).pipe(response);
          return;
        }
        try {
          const buf = await sharp(full).resize(w, null).jpeg({ quality: 70 }).toBuffer();
          response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
          response.end(buf);
        } catch {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          response.end("thumb error");
        }
      },
    }),
  );
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/newapi/assets/delete",
      handler: async (request, response) => {
        if (request.method !== "POST") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
          response.end("method not allowed");
          return;
        }
        const project = resolveProjectChecked(request, response);
        if (project === void 0) return;
        const chunks = [];
        try {
          for await (const chunk of request) chunks.push(chunk);
        } catch {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("bad body");
          return;
        }
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("invalid json");
          return;
        }
        const rel = String(payload?.rel ?? "").trim();
        if (rel === "") {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("missing rel");
          return;
        }
        const root = resolve(project);
        const full = resolve(root, rel);
        if (full !== root && !full.startsWith(root + "\\") && !full.startsWith(root + "/")) {
          response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          response.end("forbidden");
          return;
        }
        try {
          await unlink(full);
        } catch {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("not found");
          return;
        }
        await removeSessionFile(project, rel);
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true }));
      },
    }),
  );
  disposers.push(
    webServer.register({
      kind: "exact",
      path: "/newapi/session-shots",
      handler: async (request, response) => {
        const project = resolveProjectChecked(request, response);
        if (project === void 0) return;
        if (request.method === "GET" || request.method === "HEAD") {
          let body;
          try {
            body = await sessionShotsGet(project);
          } catch {
            body = { project, roundId: "", turntableConfirmed: false, shots: [] };
          }
          response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(request.method === "HEAD" ? "" : JSON.stringify(body));
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
          response.end("method not allowed");
          return;
        }
        const chunks = [];
        try {
          for await (const chunk of request) chunks.push(chunk);
        } catch {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("bad body");
          return;
        }
        const parsed = parseConfirmBody(Buffer.concat(chunks).toString("utf8"));
        if (!parsed.ok) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("bad body");
          return;
        }
        const result = await sessionShotsConfirm(project);
        if (!result.ok) {
          response.writeHead(result.status, { "content-type": "text/plain; charset=utf-8" });
          response.end("no turntable");
          return;
        }
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(result.body));
      },
    }),
  );
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        // ignore teardown errors
      }
    }
  };
}

function registerTasksRoute(ctx, settings) {
  const webServer = ctx?.get?.("webServer");
  if (webServer === void 0 || typeof webServer.register !== "function") return () => {};
  let disposed = false;
  const returned = webServer.register({
    kind: "exact",
    path: "/newapi/tasks",
    handler: async (request, response) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        response.end("method not allowed");
        return;
      }
      let project;
      try {
        project = resolveRequestProject(ctx, request);
      } catch {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("unknown project");
        return;
      }
      if (!isKnownProject(ctx, project)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("unknown project");
        return;
      }
      const current = settings();
      const ledger = new TaskLedger(resolve(project, current.outputDir, ".tasks.json"));
      let tasks = [];
      try {
        tasks = await ledger.list(50);
      } catch {
        tasks = [];
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ project, tasks }));
    },
  });
  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof returned === "function") {
      try {
        returned();
      } catch {
        // ignore teardown errors
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  pluginCtx = ctx;
  let scope;
  if (ctx.settings && typeof ctx.settings.register === "function") {
    scope = ctx.settings.register(SETTINGS_NS, Config, { base: config ?? {} });
  }
  // settings() resolves fresh, deep-frozen settings (or the entry config when
  // the settings service is unavailable).
  const settings = () => (scope !== void 0 ? scope.get() : { ...(config ?? {}) });

  let disposeTools;
  let disposePrompt;
  let disposeSkill;

  // 「视频创作」关闭时把配套技能(ecommerce-visual-suite)从 agent 可见目录里隐藏,
  // 防止它带着电商引导扰乱对话。运行期注册一个同名 runtime 技能(rank 250)覆盖
  // 文件系统同名(user-dsh rank 400)技能,并把 modelInvocable/userInvocable 都置 false,
  // 使它从 agent 技能目录(.filter(isModelInvocable))、skill 工具、用户注入中全部消失。
  const setSkillHidden = (hidden) => {
    try {
      disposeSkill?.();
    } catch {
      // ignore
    }
    disposeSkill = undefined;
    if (!hidden) {
      if (ctx.skills && typeof ctx.skills.invalidateCache === "function") ctx.skills.invalidateCache();
      return;
    }
    if (ctx.skills && typeof ctx.skills.register === "function") {
      try {
        disposeSkill = ctx.skills.register({
          name: SKILL_NAME,
          description: "(不可用:视频工坊已关闭)",
          invocation: { modelInvocable: false, userInvocable: false },
        });
      } catch (err) {
        // 同名 runtime 技能已存在(幂等);忽略
        disposeSkill = undefined;
      }
      if (ctx.skills && typeof ctx.skills.invalidateCache === "function") ctx.skills.invalidateCache();
    }
  };

  const sync = (current) => {
    try {
      disposeTools?.();
    } catch {
      // ignore
    }
    try {
      disposePrompt?.();
    } catch {
      // ignore
    }
    disposeTools = undefined;
    disposePrompt = undefined;
    if (!current || current.enabled === false) {
      setSkillHidden(true);
      return;
    }
    setSkillHidden(false);
    disposeTools = registerTools(ctx, settings);
    if (ctx.systemPrompt && typeof ctx.systemPrompt.section === "function") {
      disposePrompt = registerGuidance(ctx, current);
    }
  };

  sync(settings());
  if (scope !== void 0 && typeof scope.watch === "function") {
    ctx.effect(() => scope.watch(sync));
  }

  const disposeRoute = registerTasksRoute(ctx, settings);
  const disposeAssets = registerAssetsRoute(ctx, settings, (enabled) => void scope?.update?.({ enabled }));
  return () => {
    disposeRoute?.();
    disposeAssets?.();
  };
}
