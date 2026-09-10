// dsh-newapi-video —— 浏览器半(client 插件)
//
// 1) 在 DSH 设置面板注册「NewAPI 视频」设置页(settings.section)。
// 2) 给 newapi_generate_video / newapi_task_status 注册独立可视化卡片
//    (tool.call.toolview):渲染生成的参数、素材引用、任务状态,以及生成结果
//    的视频播放器——即 DirectorX 那种「生成面板」。模型调用工具后,聊天里会
//    直接出现这块面板,而不是一段 JSON。
//
// 这是 DSH client 插件的打包产物格式:`window.__ModuleLoader__.load({ id,
// factory })`。factory 里 `require("react")` 命中平台静态模块表(seed word);
// 不使用 JSX,统一用 react.createElement,因此无需构建步骤。
window.__ModuleLoader__.load({
  id: "dsh-newapi-video",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");

    function joinAbs(cwd, path) {
      const p = String(path || "").replace(/^@/, "").trim();
      if (p === "") return "";
      if (/^https?:\/\//i.test(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/")) return p.replace(/\\/g, "/");
      const root = String(cwd || "").replace(/[\\/]+$/, "");
      if (root === "") return p.replace(/\\/g, "/");
      return (root + "/" + p).replace(/\\/g, "/");
    }
    function joinAbsList(cwd, paths) {
      return (Array.isArray(paths) ? paths : []).map((p) => joinAbs(cwd, p)).filter(Boolean);
    }
    function formatRefsPhrase(absPaths) {
      return (absPaths || []).filter(Boolean).map((p) => "@" + p).join(" ");
    }
    function buildConfirmUtterance({ turntableAbs, refsAbs }) {
      const refs = formatRefsPhrase(refsAbs);
      return `全能参考图已确认：@${turntableAbs}。产品源图：${refs}。请按已锁定规格继续生成套装。后续镜头用这组源图作 images，视频把全能图作为 reference_images。不要再生成 turntable。`;
    }
    function buildRegenUtterance({ turntableAbs, refsAbs }) {
      const refs = formatRefsPhrase(refsAbs);
      return `全能参考图需要重生：@${turntableAbs}。产品源图：${refs}。请用同一组源图重新生成一张 role=turntable 的全能参考图，不要生成套装镜头。`;
    }
    function buildRerunUtterance({ shotId, pathAbs, refsAbs, role, isVideo, turntableAbs }) {
      if (isVideo) {
        return `请按原参数重出镜头 ${shotId}：@${pathAbs}。全能参考图：@${turntableAbs}。使用 role=${role}，shot_id=${shotId}。`;
      }
      const refs = formatRefsPhrase(refsAbs);
      return `请按原参数重出镜头 ${shotId}：@${pathAbs}。产品源图：${refs}。使用 role=${role}，shot_id=${shotId}。`;
    }
    function buildRerunNoteUtterance({ shotId, pathAbs, refsAbs, role, note, isVideo, turntableAbs }) {
      if (isVideo) {
        return `请按新需求重出镜头 ${shotId}：@${pathAbs}。需求：${note}。全能参考图：@${turntableAbs}。使用 role=${role}，shot_id=${shotId}。`;
      }
      const refs = formatRefsPhrase(refsAbs);
      return `请按新需求重出镜头 ${shotId}：@${pathAbs}。需求：${note}。产品源图：${refs}。使用 role=${role}，shot_id=${shotId}。`;
    }
    function buildEditUtterance({ shotId, pathAbs, note }) {
      return `请在这张图上修改镜头 ${shotId}：@${pathAbs}。修改：${note}。使用 role=edit，shot_id=${shotId}，image=@${pathAbs}。需要锁外观时把 productRefs 一并传入 images，与当前图合计仍 ≤3。`;
    }
    function tryRequestSubmit(text, actions, clipboard) {
      if (actions && typeof actions.setDraft === "function" && typeof actions.submit === "function") {
        actions.setDraft(text);
        actions.submit();
        return { status: "submitted" };
      }
      if (actions && typeof actions.setDraft === "function") {
        actions.setDraft(text);
        return { status: "draft" };
      }
      if (clipboard && typeof clipboard.writeText === "function") {
        try {
          clipboard.writeText(text);
          return { status: "copied" };
        } catch {
          return { status: "shown" };
        }
      }
      return { status: "shown" };
    }
    function shouldShowConfirmBar({ role, settled, failed, hasCwd, fetchOk, turntableConfirmed, hasNonTurntable }) {
      if (role !== "turntable" || !settled || failed) return false;
      if (!hasCwd || !fetchOk) return true;
      if (turntableConfirmed === true) return false;
      if (hasNonTurntable) return false;
      return true;
    }
    function shouldShowRoundGallery({ shots, cardRel }) {
      const list = Array.isArray(shots) ? shots : [];
      if (list.length < 2 || !cardRel) return false;
      let latest = list[0];
      for (const item of list) {
        if ((item.updatedAt ?? 0) >= (latest.updatedAt ?? 0)) latest = item;
      }
      return latest.path === cardRel;
    }
    function isVideoPath(path) {
      return /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(String(path || ""));
    }
    function cardRelFromResult(cwd, result) {
      const files = Array.isArray(result?.files) ? result.files : [];
      const saved = files.find((f) => f && typeof f.path === "string" && f.path !== "");
      if (!saved) return "";
      const abs = String(saved.path).replace(/\\/g, "/");
      const root = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
      if (root && abs.startsWith(root + "/")) return abs.slice(root.length + 1);
      return abs.split("/").slice(-2).join("/");
    }

    let requestSubmitImpl = async (text) => ({ status: "shown", text });
    async function requestSubmit(text) {
      return requestSubmitImpl(text);
    }
    function submitHint(status) {
      if (status === "draft") return "已填入输入框，请按 Enter 发送";
      if (status === "copied") return "已复制，请粘贴发送";
      if (status === "shown") return "请手动复制发送";
      return "";
    }
    function NewapiSubmitBridge(props) {
      react.useEffect(() => {
        const actions = props.inputActions;
        requestSubmitImpl = async (text) => {
          const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
          return tryRequestSubmit(text, actions, clip);
        };
        return () => {
          requestSubmitImpl = async (text) => ({ status: "shown", text });
        };
      }, [props.inputActions]);
      return null;
    }
    const actionBtnStyle = {
      fontSize: 12,
      fontWeight: 600,
      padding: "6px 10px",
      borderRadius: 8,
      border: "1px solid var(--dsw-alias-border-l2)",
      cursor: "pointer",
      background: "var(--dsw-alias-bg-layer-3)",
      color: "var(--dsw-alias-label-primary)",
    };
    function hintLine(state) {
      if (!state) return null;
      const msg = submitHint(state.status);
      const children = [];
      if (msg) children.push(react.createElement("p", { key: "m", style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, msg));
      if (state.status === "shown" && state.text) {
        children.push(react.createElement("pre", { key: "t", style: { margin: 0, whiteSpace: "pre-wrap", fontSize: 11 } }, state.text));
      }
      return children.length ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, ...children) : null;
    }

    // host 端 ctx.settings.register 注册的 namespace 名。
    const NS = "newapi-video";

    // -----------------------------------------------------------------------
    // 设置页字段(settings.section)
    // -----------------------------------------------------------------------
    const RATIOS = [["auto","自动"],["1:1","1:1"],["3:4","3:4"],["4:5","4:5"],["9:16","9:16"],["2:3","2:3"],["1:2","1:2"],["16:9","16:9"],["4:3","4:3"],["5:4","5:4"],["3:2","3:2"],["2:1","2:1"],["21:9","21:9"]];
    const RES_VIDEO = [["480p","480p"],["720p","720p"],["1080p","1080p"],["2K","2K"],["4k","4K"]];
    const RES_IMAGE = [["1024x1024","1K"],["2048x2048","2K"],["4096x4096","4K"]];
    const FIELDS = [
      { key: "enabled", label: "启用", type: "bool", hint: "总开关;关闭后不再注册工具" },
      {
        key: "provider",
        label: "视频通道",
        type: "select",
        options: [
          ["newapi", "中转站(new-api)(默认)"],
          ["seedance", "火山方舟 Seedance"],
          ["wan", "阿里百炼 Wan"],
          ["siliconflow", "硅基流动"],
          ["zhipu", "智谱"],
          ["ofox", "OfoxAI"],
        ],
        hint: "视频生成通道。官方 provider 用各自 baseURL/model/key(见下方对应字段);图片始终走中转站。",
      },
      {
        key: "mode",
        label: "协议模式",
        type: "select",
        options: [
          ["v1-videos", "新-api /v1/videos 任务接口"],
          ["openai-videos", "OpenAI 兼容 /videos/generations"],
          ["modelverse-tasks", "ModelVerse /tasks/submit"],
          ["generic-rest", "自定义 REST(可配路径)"],
        ],
        hint: "不同中转站/模型协议不同;默认 OpenAI 兼容。",
      },
      { key: "baseURL", label: "Base URL", type: "text", hint: "中转站地址,含 /v1;留空则用「模型配置」里的 baseURL" },
      { key: "apiKey", label: "API Key", type: "password", hint: "中转站 API Key;留空则用「模型配置」里的 key" },
      { key: "model", label: "默认模型(视频)", type: "model", kind: "video", hint: "点「获取模型」后下拉选择可用模型;也可选「自定义…」手动输入" },
      { key: "outputDir", label: "输出目录", type: "text", hint: "相对会话工作区" },
      { key: "aspectRatio", label: "画面比例", type: "chip", options: RATIOS, hint: "自动=由上游决定宽高比" },
      { key: "durationSeconds", label: "默认时长(秒)", type: "number", hint: "1-60" },
      { key: "resolution", label: "视频清晰度", type: "chip", options: RES_VIDEO, hint: "视频输出档位" },
      { key: "timeoutMs", label: "请求超时(ms)", type: "number", hint: "单次请求" },
      { key: "pollIntervalMs", label: "轮询间隔(ms)", type: "number", hint: "异步任务轮询" },
      { key: "maxPollAttempts", label: "最大轮询次数", type: "number", hint: "超过则超时" },
      { key: "submitPath", label: "提交路径", type: "text", hint: "openai-videos / generic-rest 用" },
      { key: "statusPathTemplate", label: "状态路径模板", type: "text", hint: "含 {task_id}" },
      { key: "imageModel", label: "默认模型(图片)", type: "model", kind: "image", hint: "点「获取模型」后下拉选择可用模型;也可选「自定义…」手动输入" },
      { key: "imageSize", label: "图片画质/清晰度", type: "chip", options: RES_IMAGE, hint: "图片输出档位(画质与尺寸合一)" },
      { key: "imageOutputDir", label: "图片输出目录", type: "text", hint: "默认存到当前工作区的 newapi_image 子目录;可改其他子目录或 .(工作区根)" },
      { key: "storageDir", label: "全局存储目录", type: "text", hint: "所有会话共用的媒体存储目录(绝对路径)。上传与生成的图/视频都存到这里,资产库统一扫描;留空则按各工作区的 newapi_image/newapi_output" },
      // ---- 官方视频 provider(BYOK):仅当「视频通道」选中该 provider 时展示 ----
      { key: "seedanceBaseURL", label: "Seedance Base URL", type: "text", onlyFor: "seedance", hint: "火山方舟 Ark,默认 https://ark.cn-beijing.volces.com/api/v3" },
      { key: "seedanceModel", label: "Seedance 模型", type: "text", onlyFor: "seedance", hint: "默认 doubao-seedance-2-0-260128;key 用 ARK_API_KEY 环境变量或下方 API Key" },
      { key: "wanBaseURL", label: "Wan Base URL", type: "text", onlyFor: "wan", hint: "阿里百炼,默认 https://dashscope.aliyuncs.com" },
      { key: "wanModel", label: "Wan 文生视频模型", type: "text", onlyFor: "wan", hint: "默认 wan2.7-t2v-2026-06-12" },
      { key: "wanI2vModel", label: "Wan 图生视频模型", type: "text", onlyFor: "wan", hint: "默认 wan2.7-i2v-2026-04-25;key 用 DASHSCOPE_API_KEY" },
      { key: "siliconflowBaseURL", label: "硅基流动 Base URL", type: "text", onlyFor: "siliconflow", hint: "默认 https://api.siliconflow.cn" },
      { key: "siliconflowModel", label: "硅基流动 文生视频模型", type: "text", onlyFor: "siliconflow", hint: "默认 Wan-AI/Wan2.2-T2V-A14B" },
      { key: "siliconflowI2vModel", label: "硅基流动 图生视频模型", type: "text", onlyFor: "siliconflow", hint: "默认 Wan-AI/Wan2.2-I2V-A14B;key 用 SILICONFLOW_API_KEY" },
      { key: "zhipuBaseURL", label: "智谱 Base URL", type: "text", onlyFor: "zhipu", hint: "默认 https://open.bigmodel.cn/api/paas/v4" },
      { key: "zhipuModel", label: "智谱 模型", type: "text", onlyFor: "zhipu", hint: "默认 cogvideox-flash;key 用 ZHIPU_API_KEY" },
      { key: "ofoxBaseURL", label: "OfoxAI Base URL", type: "text", onlyFor: "ofox", hint: "默认 https://api.ofox.ai" },
      { key: "ofoxModel", label: "OfoxAI 模型", type: "text", onlyFor: "ofox", hint: "默认 bytedance/seedance-2.0;key 用 OFOX_API_KEY" },
    ];

    // -----------------------------------------------------------------------
    // 工具卡片读取 block 的辅助函数(与 dsh-client-ui-tool 的契约一致)
    // -----------------------------------------------------------------------
    function parseArgs(raw) {
      if (raw === void 0 || raw === "") return {};
      try {
        const parsed = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null ? parsed : {};
      } catch {
        return {};
      }
    }
    function argsOf(block) {
      return parseArgs(block.argsRaw ?? block.call?.argsRaw);
    }
    function textContentOf(block) {
      const parts = [];
      for (const item of block.content ?? []) {
        if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      }
      return parts.join("\n");
    }
    function resultOf(block) {
      const text = textContentOf(block);
      if (text === "") return null;
      try {
        const parsed = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null ? parsed : null;
      } catch {
        return null;
      }
    }
    function isHttpOrData(value) {
      return /^https?:\/\//i.test(value) || /^data:/i.test(value);
    }
    function videoSrc(file) {
      if (file && typeof file.url === "string" && isHttpOrData(file.url)) return file.url;
      return void 0;
    }
    // Friendly status labels (mirrors the host's stateLabelOf).
    const SUCCESS_RE = /succee|complet|finish|done|ok$/i;
    const FAIL_RE = /fail|cancel|error|abort|reject/i;
    const QUEUE_RE = /queu|pend|wait|submit|created|init|accept/i;
    const PROC_RE = /process|render|generat|synthesiz|working|progress|run/i;
    function friendlyState(state) {
      const s = String(state ?? "").toLowerCase();
      if (SUCCESS_RE.test(s)) return "已完成";
      if (FAIL_RE.test(s)) return "失败";
      if (QUEUE_RE.test(s)) return "排队中";
      if (PROC_RE.test(s)) return "渲染中";
      const trimmed = String(state ?? "").trim();
      return trimmed === "" ? "处理中" : trimmed;
    }

    const TOOL_META = {
      newapi_generate_video: { title: "视频工坊 · 视频生成", kind: "video" },
      newapi_generate_image: { title: "视频工坊 · 图片生成", kind: "image" },
      newapi_task_status: { title: "视频工坊 · 任务状态" },
      newapi_assets: { title: "资产库" },
    };

    // -----------------------------------------------------------------------
    // 可视化卡片(tool.call.toolview)
    // -----------------------------------------------------------------------
    // 资产库画廊:把 newapi_assets 返回的 assets 渲染成响应式媒体网格
    // 分类:图片 / 音频 / 视频(统一归「视频」,不再按体积拆「影片」)。
    const CAT_LABEL = { video: "视频", image: "图片", audio: "音频" };
    // 卡片左上角的类型标签:用颜色 + 图标区分 视频/图片/音频,一眼可辨。
    const TYPE_META = {
      video: { label: "视频", icon: "🎬", bg: "#1d4ed8" },
      image: { label: "图片", icon: "🖼", bg: "#15803d" },
      audio: { label: "音频", icon: "🎵", bg: "#b45309" },
    };
    function typeMetaOf(asset) {
      const cat = categoryOf(asset);
      return TYPE_META[cat] ?? { label: cat, icon: "", bg: "rgba(0,0,0,0.55)" };
    }
    function categoryOf(asset) {
      if (asset.kind === "image") return "image";
      if (asset.kind === "audio") return "audio";
      if (asset.kind === "video") return "video";
      return "video";
    }

    // 字节数 → 人类可读尺寸(资产卡片右下角展示)。
    function formatBytes(n) {
      const b = Number(n);
      if (!Number.isFinite(b) || b < 0) return "";
      if (b < 1024) return `${b} B`;
      const units = ["KB", "MB", "GB", "TB"];
      let v = b;
      let i = -1;
      do {
        v /= 1024;
        i += 1;
      } while (v >= 1024 && i < units.length - 1);
      return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
    }

    // 画廊 hover 态(边框高亮 / 悬浮阴影 / 删除与提示按需显现),统一注入一次。
    const GALLERY_CSS = [
      ".nva-cell{transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}",
      ".nva-cell:hover,.nva-cell:focus-visible{border-color:var(--dsw-alias-brand-primary,#3b82f6);box-shadow:0 6px 18px rgba(0,0,0,.20);transform:translateY(-1px)}",
      ".nva-del{opacity:0;transition:opacity .16s ease}",
      ".nva-cell:hover .nva-del,.nva-cell:focus-visible .nva-del{opacity:.9}",
      ".nva-cell .nva-del--busy,.nva-cell:hover .nva-del--busy{opacity:.4}",
      ".nva-hint{opacity:0;transition:opacity .16s ease}",
      ".nva-cell:hover .nva-hint{opacity:1}",
    ].join("");

    // 统一的资产库网格:分类标签页(全部/视频/图片/音频) + 响应式媒体卡片 + hover 态。
    function AssetGrid(props) {
      const assets = Array.isArray(props.assets) ? props.assets : [];
      const onDelete = typeof props.onDelete === "function" ? props.onDelete : null;
      const fallbackProject = typeof props.project === "string" ? props.project : "";
      const [kind, setKind] = react.useState("all");
      const [view, setView] = react.useState(null);
      const [deleting, setDeleting] = react.useState(false);

      react.useEffect(() => {
        if (document.getElementById("nva-gallery-css")) return;
        const el = document.createElement("style");
        el.id = "nva-gallery-css";
        el.textContent = GALLERY_CSS;
        document.head.appendChild(el);
      }, []);

      const handleDelete = async (asset) => {
        const project = asset.project ?? fallbackProject;
        const rel = asset.rel ?? "";
        if (!project || !rel || deleting) return;
        if (!window.confirm(`确定删除「${asset.name ?? rel}」？此操作不可撤销。`)) return;
        setDeleting(true);
        try {
          const r = await fetch(`/newapi/assets/delete?project=${encodeURIComponent(project)}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-newapi-project": project },
            body: JSON.stringify({ rel }),
          });
          if (!r.ok) throw new Error(String(r.status));
          onDelete?.();
        } catch (err) {
          window.alert("删除失败: " + String(err?.message ?? err));
        } finally {
          setDeleting(false);
        }
      };

      react.useEffect(() => {
        if (!view) return;
        const onKey = (e) => {
          if (e.key === "Escape") setView(null);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [view]);
      const cats = [
        ["all", "全部"],
        ["video", "视频"],
        ["image", "图片"],
        ["audio", "音频"],
      ];
      const counts = { all: assets.length, video: 0, film: 0, image: 0, audio: 0 };
      for (const a of assets) {
        const cat = categoryOf(a);
        if (cat in counts) counts[cat] += 1;
      }
      const shown = kind === "all" ? assets : assets.filter((a) => categoryOf(a) === kind);

      const gridStyle = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))", gap: 12 };
      const cellStyle = { borderRadius: 10, border: "1px solid var(--dsw-alias-border-l2)", overflow: "hidden", background: "var(--dsw-alias-bg-base)" };
      const mediaStyle = { display: "block", width: "100%", height: 150, objectFit: "cover", background: "var(--dsw-alias-bg-base)" };
      const badgeStyle = { position: "absolute", top: 6, left: 6, fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 999, color: "#fff", background: "rgba(0,0,0,0.55)", boxShadow: "0 1px 3px rgba(0,0,0,0.35)" };
      const deleteBtnStyle = { position: "absolute", top: 6, right: 6, width: 24, height: 24, borderRadius: "50%", border: "none", background: "rgba(0,0,0,0.55)", color: "#fff", fontSize: 12, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3 };
      const centerPlayStyle = { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 40, height: 40, borderRadius: "50%", background: "rgba(0,0,0,0.6)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, pointerEvents: "none", boxShadow: "0 2px 8px rgba(0,0,0,0.35)" };
      const hintStyle = { position: "absolute", left: 0, right: 0, bottom: 0, padding: "3px 6px", textAlign: "center", fontSize: 11, fontWeight: 600, color: "#fff", background: "rgba(0,0,0,0.45)", pointerEvents: "none" };
      const tabRowStyle = { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" };
      const emptyStyle = { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", fontStyle: "italic" };
      const footerStyle = { padding: "8px 10px", display: "flex", flexDirection: "column", gap: 3 };
      const nameStyle = { margin: 0, fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
      const metaRowStyle = { display: "flex", alignItems: "center", gap: 6 };
      const projectStyle = { margin: 0, flex: 1, minWidth: 0, fontSize: 10, color: "var(--dsw-alias-label-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
      const sizeStyle = { margin: 0, flexShrink: 0, fontSize: 10, color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap" };

      const tabs = cats.map(([k, label]) => {
        const active = kind === k;
        const tabStyle = {
          height: 26,
          padding: "0 12px",
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 600,
          border: "1px solid var(--dsw-alias-border-l2)",
          cursor: "pointer",
          color: active ? "#fff" : "var(--dsw-alias-label-secondary)",
          background: active ? "var(--dsw-alias-brand-primary, #3b82f6)" : "var(--dsw-alias-bg-layer-2)",
        };
        return react.createElement("button", { key: k, style: tabStyle, onClick: () => setKind(k) }, `${label} ${counts[k]}`);
      });

      const cells = shown.map((asset) => {
        const rel = asset.rel ?? asset.name ?? asset.url;
        const src = asset.url ?? "";
        const sizeStr = formatBytes(asset.size);
        const thumbSrc = src.replace("/newapi/assets/file?", "/newapi/assets/thumb?");
        let media;
        let overlay = null;
        if (asset.kind === "video") {
          // 始终只显示首帧封面 + 居中播放按钮(明确区分视频);单击/双击开灯箱
          media = react.createElement(
            "div",
            { style: { position: "relative" } },
            react.createElement("video", {
              preload: "metadata",
              muted: true,
              playsInline: true,
              src,
              style: mediaStyle,
              onLoadedMetadata: (e) => {
                try {
                  const v = e.currentTarget;
                  if (typeof v.duration === "number" && v.duration > 0) v.currentTime = 0.1;
                  v.pause();
                } catch {
                  // ignore
                }
              },
            }),
            react.createElement("div", { style: centerPlayStyle }, "▶"),
          );
          overlay = react.createElement("span", { className: "nva-hint", style: hintStyle }, "▶ 点击预览");
        } else if (asset.kind === "audio") {
          // 音频无封面:用等高的居中容器对齐其它卡片高度
          media = react.createElement(
            "div",
            { style: { height: 150, display: "flex", alignItems: "center", padding: "0 8px", boxSizing: "border-box", background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.05))" } },
            react.createElement("audio", { controls: true, preload: "metadata", src, style: { width: "100%" } }),
          );
        } else {
          // 图片用服务端低分辨率缩略图(省内存);加载失败回退原图
          media = react.createElement("img", {
            src: thumbSrc,
            loading: "lazy",
            decoding: "async",
            alt: asset.name ?? "",
            style: mediaStyle,
            onError: (e) => {
              e.currentTarget.onerror = null;
              e.currentTarget.src = src;
            },
          });
          overlay = react.createElement("span", { className: "nva-hint", style: hintStyle }, "🔍 点击预览");
        }
        return react.createElement(
          "div",
          {
            key: rel,
            className: "nva-cell",
            style: { ...cellStyle, position: "relative", cursor: "pointer" },
            onClick: () => setView(asset),
            title: asset.name ?? rel,
            role: "button",
            tabIndex: 0,
          },
          react.createElement("span", { style: { ...badgeStyle, background: typeMetaOf(asset).bg } }, `${typeMetaOf(asset).icon} ${typeMetaOf(asset).label}`),
          onDelete
            ? react.createElement(
                "button",
                {
                  type: "button",
                  className: deleting ? "nva-del nva-del--busy" : "nva-del",
                  style: deleteBtnStyle,
                  title: "删除",
                  disabled: deleting,
                  onClick: (e) => {
                    e.stopPropagation();
                    handleDelete(asset);
                  },
                },
                "🗑",
              )
            : null,
          react.createElement(
            "div",
            { style: { position: "relative" } },
            media,
            overlay,
          ),
          react.createElement(
            "div",
            { style: footerStyle },
            react.createElement("p", { style: nameStyle, title: asset.name ?? "" }, asset.name ?? ""),
            react.createElement(
              "div",
              { style: metaRowStyle },
              asset.project
                ? react.createElement("p", { style: projectStyle, title: asset.project }, pathBase(asset.project) || asset.project)
                : react.createElement("span", { style: { flex: 1 } }),
              sizeStr ? react.createElement("p", { style: sizeStyle }, sizeStr) : null,
            ),
          ),
        );
      });

      let lightbox = null;
      if (view) {
        const v = view.url ?? "";
        const modalStyle = {
          position: "fixed",
          inset: 0,
          zIndex: 99999,
          background: "rgba(0,0,0,0.78)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        };
        const cardStyle = {
          position: "relative",
          background: "#000",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          maxWidth: "min(72vw, 840px)",
          maxHeight: "min(78vh, 620px)",
        };
        const closeBtn = {
          position: "absolute",
          top: 10,
          right: 10,
          width: 34,
          height: 34,
          borderRadius: "50%",
          border: "none",
          background: "rgba(255,255,255,0.18)",
          color: "#fff",
          fontSize: 20,
          lineHeight: 1,
          cursor: "pointer",
          zIndex: 2,
        };
        const mediaSize = { maxWidth: "min(72vw, 840px)", maxHeight: "min(78vh, 620px)", display: "block", objectFit: "contain", background: "transparent" };
        let content;
        if (view.kind === "video") {
          content = react.createElement("video", { src: v, controls: true, autoPlay: true, playsInline: true, controlsList: "nofullscreen", disablePictureInPicture: true, style: mediaSize });
        } else if (view.kind === "audio") {
          content = react.createElement("audio", { src: v, controls: true, autoPlay: true, style: { width: "min(72vw, 560px)", maxWidth: 560 } });
        } else {
          content = react.createElement("img", { src: v, alt: view.name ?? "", style: mediaSize });
        }
        lightbox = react.createElement(
          "div",
          { style: modalStyle, onClick: () => setView(null) },
          react.createElement(
            "div",
            { style: cardStyle, onClick: (e) => e.stopPropagation() },
            react.createElement("button", { style: closeBtn, onClick: () => setView(null) }, "×"),
            content,
          ),
        );
      }

      return react.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8 } },
        react.createElement("div", { style: tabRowStyle }, ...tabs),
        cells.length === 0
          ? react.createElement("p", { style: emptyStyle }, "该分类暂无媒体")
          : react.createElement("div", { style: gridStyle }, ...cells),
        lightbox,
      );
    }

    function NewapiAssetsRow(props) {
      const block = props.block;
      const settled = block.kind === "tool-result";
      const result = settled ? resultOf(block) : null;
      const assets = Array.isArray(result?.assets) ? result.assets : [];
      const count = typeof result?.count === "number" ? result.count : assets.length;

      const wrapStyle = {
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 12,
        borderRadius: 12,
        background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.06))",
        border: "1px solid var(--dsw-alias-border-l2)",
      };
      const headStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
      const titleStyle = { margin: 0, fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
      const captionStyle = { margin: "2px 0 0", fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--dsw-alias-label-caption)" };
      const countChip = { fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 999, color: "#fff", background: "var(--dsw-alias-state-warn-primary, #d97706)" };
      const hintStyle = { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", fontStyle: "italic" };

      const children = [];
      children.push(
        react.createElement(
          "div",
          { style: headStyle },
          react.createElement(
            "div",
            { style: { minWidth: 0 } },
            react.createElement("p", { style: captionStyle }, "视频工坊"),
            react.createElement("h4", { style: titleStyle }, "资产库"),
          ),
          react.createElement("span", { style: countChip }, `${count} 项`),
        ),
      );

      if (!settled) {
        children.push(react.createElement("p", { style: hintStyle }, "正在扫描工作区媒体…"));
      } else if (assets.length === 0) {
        children.push(react.createElement("p", { style: hintStyle }, "工作区暂无媒体资产"));
      } else {
        children.push(react.createElement(AssetGrid, { assets }));
      }

      return react.createElement("div", { style: wrapStyle }, ...children);
    }

    // 跨平台取路径最后一段:兼容 Windows(\) 与 Unix(/),忽略尾部/根分隔符。
    const pathBase = (p) => {
      const s = String(p ?? "").trim();
      if (s === "") return "";
      const parts = s.split(/[\\/]+/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : s;
    };

    // 独立的「资产库」页面(settings.section):汇总所有工作区媒体,不按会话/工作区分开。
    function NewapiAssetsSection() {
      return function AssetsPage() {
        const [assets, setAssets] = react.useState([]);
        const [loading, setLoading] = react.useState(false);
        const [error, setError] = react.useState("");

        const load = react.useCallback(async () => {
          setLoading(true);
          setError("");
          try {
            const url = "/newapi/assets?scope=global";
            const response = await fetch(url);
            if (!response.ok) {
              setError(`加载失败 (HTTP ${response.status})`);
              setAssets([]);
              return;
            }
            const data = await response.json();
            setAssets(Array.isArray(data?.assets) ? data.assets : []);
          } catch (err) {
            setError(String(err));
            setAssets([]);
          } finally {
            setLoading(false);
          }
        }, []);

        react.useEffect(() => {
          void load();
        }, [load]);

        const pageStyle = { padding: "8px 4px", display: "flex", flexDirection: "column", gap: 12 };
        const headStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 };
        const titleStyle = { margin: 0, fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
        const countChip = { fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 999, color: "#fff", background: "var(--dsw-alias-state-warn-primary, #d97706)" };
        const barStyle = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
        const inputStyle = {
          flex: "1 1 220px",
          boxSizing: "border-box",
          height: 34,
          padding: "0 12px",
          fontSize: 13,
          color: "var(--dsw-alias-label-primary)",
          background: "var(--dsw-alias-bg-layer-3)",
          border: "1px solid var(--dsw-alias-border-l2)",
          borderRadius: 8,
        };
        const buttonStyle = {
          height: 34,
          padding: "0 16px",
          fontSize: 13,
          fontWeight: 600,
          color: "#fff",
          background: "var(--dsw-alias-brand-primary, #3b82f6)",
          border: "none",
          borderRadius: 8,
          cursor: "pointer",
        };
        const hintStyle = { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" };
        const selectStyle = {
          flex: "0 1 260px",
          boxSizing: "border-box",
          height: 34,
          padding: "0 10px",
          fontSize: 13,
          color: "var(--dsw-alias-label-primary)",
          background: "var(--dsw-alias-bg-layer-3)",
          border: "1px solid var(--dsw-alias-border-l2)",
          borderRadius: 8,
          maxWidth: "100%",
          textOverflow: "ellipsis",
        };
        const loadingStyle = { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", fontStyle: "italic" };

        const children = [];
        children.push(
          react.createElement(
            "div",
            { style: headStyle },
            react.createElement(
              "div",
              null,
              react.createElement("p", { style: { margin: 0, fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--dsw-alias-label-caption)" } }, "视频工坊"),
              react.createElement("h4", { style: titleStyle }, "资产库"),
            ),
            react.createElement("span", { style: countChip }, `汇总 ${assets.length} 项`),
          ),
        );
        children.push(
          react.createElement(
            "div",
            { style: barStyle },
            react.createElement("p", { style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, "综合扫描全局存储目录(未配置时默认当前会话工作区)"),
            react.createElement("button", { style: buttonStyle, onClick: () => void load() }, loading ? "加载中…" : "刷新"),
          ),
        );
        if (error !== "") children.push(react.createElement("p", { style: hintStyle }, error));
        if (loading && assets.length === 0) children.push(react.createElement("p", { style: loadingStyle }, "正在扫描媒体…"));
        else if (!loading && assets.length === 0) children.push(react.createElement("p", { style: hintStyle }, "暂无媒体资产"));
        else {
          children.push(react.createElement(AssetGrid, { assets, onDelete: () => void load() }));
        }

        return react.createElement("div", { style: pageStyle }, ...children);
      };
    }

    // 生成结果卡片底部自动嵌入的资产库画廊:按 project 拉取 /newapi/assets 并渲染网格。
    function ProjectAssets(props) {
      const project = typeof props.project === "string" ? props.project : "";
      const [assets, setAssets] = react.useState([]);
      const [loading, setLoading] = react.useState(false);
      const [error, setError] = react.useState("");
      const [reloadCount, setReloadCount] = react.useState(0);
      react.useEffect(() => {
        if (String(project ?? "").trim() === "") return;
        let live = true;
        setLoading(true);
        setError("");
        (async () => {
          try {
            const url = `/newapi/assets?project=${encodeURIComponent(project)}&scope=session`;
            const response = await fetch(url, { headers: { "x-newapi-project": project } });
            if (!response.ok) throw new Error(String(response.status));
            const data = await response.json();
            if (live) setAssets(Array.isArray(data?.assets) ? data.assets : []);
          } catch (err) {
            if (live) setError(String(err));
          } finally {
            if (live) setLoading(false);
          }
        })();
        return () => {
          live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [project, reloadCount]);

      const sectionStyle = { display: "flex", flexDirection: "column", gap: 8 };
      const secLabelStyle = { margin: 0, fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-tertiary)", textTransform: "uppercase", letterSpacing: 0.5 };
      const countChip = { display: "inline-block", marginLeft: 6, fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 999, color: "#fff", background: "var(--dsw-alias-state-warn-primary, #d97706)" };
      const hintStyle = { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", fontStyle: "italic" };

      let body;
      if (loading && assets.length === 0) {
        body = react.createElement("p", { style: hintStyle }, "正在扫描媒体…");
      } else if (error !== "" && assets.length === 0) {
        body = react.createElement("p", { style: hintStyle }, "媒体加载失败");
      } else if (assets.length === 0) {
        body = react.createElement("p", { style: hintStyle }, "工作区暂无媒体资产");
      } else {
        body = react.createElement(AssetGrid, { assets, project, onDelete: () => setReloadCount((c) => c + 1) });
      }

      return react.createElement(
        "div",
        { style: sectionStyle },
        react.createElement("p", { style: secLabelStyle }, "资产库", react.createElement("span", { style: countChip }, `${assets.length} 项`)),
        body,
      );
    }

    // 生成结果卡片里的「成品」画廊:只渲染本次生成(generateImages/generateVideo 返回的 files),
    // 即当前对话生成的作品,而不是工作区全部素材。
    function NewapiFilesGallery(props) {
      const files = Array.isArray(props.files) ? props.files : [];
      const assets = files
        .filter((f) => f && (f.url || f.path))
        .map((f, i) => {
          const url = f.url || "";
          const path = f.path || f.url || "";
          const name = String(path).split(/[\\/]/).pop() || "素材 " + (i + 1);
          const mime = f.mimeType || "";
          const kind = /video/i.test(mime) ? "video" : /audio/i.test(mime) ? "audio" : "image";
          return { rel: name + "-" + i, name, kind, url, mimeType: mime };
        });
      if (assets.length === 0) return null;
      return react.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8 } },
        react.createElement(
          "div",
          { style: { margin: 0, fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-tertiary)", textTransform: "uppercase", letterSpacing: 0.5 } },
          "成品",
          react.createElement("span", { style: { display: "inline-block", marginLeft: 6, fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 999, color: "#fff", background: "var(--dsw-alias-state-warn-primary, #d97706)" } }, `${assets.length} 项`),
        ),
        react.createElement(AssetGrid, { assets }),
      );
    }

    function NewapiRoundGallery(props) {
      const cwd = typeof props.cwd === "string" ? props.cwd : "";
      const cardRel = typeof props.cardRel === "string" ? props.cardRel : "";
      const [data, setData] = react.useState(null);
      const [noteShot, setNoteShot] = react.useState("");
      const [noteMode, setNoteMode] = react.useState("");
      const [note, setNote] = react.useState("");
      const [submitState, setSubmitState] = react.useState(null);
      react.useEffect(() => {
        if (!cwd) return;
        let live = true;
        fetch("/newapi/session-shots?project=" + encodeURIComponent(cwd))
          .then((r) => (r.ok ? r.json() : Promise.reject()))
          .then((body) => { if (live) setData(body); })
          .catch(() => { if (live) setData(null); });
        return () => { live = false; };
      }, [cwd, cardRel]);
      const shots = Array.isArray(data?.shots) ? data.shots : [];
      if (!shouldShowRoundGallery({ shots, cardRel })) return null;
      const turntable = shots.find((s) => s.shot_id === "_turntable");
      const turntableAbs = joinAbs(cwd, turntable?.path || "");
      const send = async (text) => {
        const st = await requestSubmit(text);
        setSubmitState({ ...st, text });
      };
      const cells = shots.map((shot) => {
        const video = isVideoPath(shot.path);
        const pathAbs = joinAbs(cwd, shot.path);
        const refsAbs = joinAbsList(cwd, shot.refs);
        const role = shot.role || "shot";
        const openNote = (mode) => { setNoteShot(shot.shot_id); setNoteMode(mode); setNote(""); };
        const buttons = [
          react.createElement("button", {
            key: "rerun",
            type: "button",
            style: actionBtnStyle,
            onClick: () => void send(buildRerunUtterance({ shotId: shot.shot_id, pathAbs, refsAbs, role, isVideo: video, turntableAbs })),
          }, "重出"),
          react.createElement("button", { key: "note", type: "button", style: actionBtnStyle, onClick: () => openNote("rerun-note") }, "改需求重出"),
        ];
        if (!video) {
          buttons.push(react.createElement("button", { key: "edit", type: "button", style: actionBtnStyle, onClick: () => openNote("edit") }, "在这张上修"));
        }
        const editing = noteShot === shot.shot_id;
        return react.createElement(
          "div",
          { key: shot.shot_id, style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, overflow: "hidden", background: "var(--dsw-alias-bg-base)", display: "flex", flexDirection: "column", gap: 6, padding: 8 } },
          video
            ? react.createElement("video", { src: shot.url, preload: "metadata", muted: true, playsInline: true, style: { width: "100%", height: 120, objectFit: "cover" } })
            : react.createElement("img", { src: shot.url, alt: shot.shot_id, style: { width: "100%", height: 120, objectFit: "contain" } }),
          react.createElement("div", { style: { fontSize: 11, fontWeight: 600 } }, shot.shot_id),
          react.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } }, ...buttons),
          editing
            ? react.createElement(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 6 } },
                react.createElement("input", {
                  value: note,
                  onChange: (e) => setNote(e.target.value),
                  placeholder: noteMode === "edit" ? "修改说明" : "新需求",
                  style: { fontSize: 12, padding: 6, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)" },
                }),
                react.createElement("button", {
                  type: "button",
                  style: actionBtnStyle,
                  onClick: () => {
                    const trimmed = note.trim();
                    if (trimmed === "") return;
                    const text = noteMode === "edit"
                      ? buildEditUtterance({ shotId: shot.shot_id, pathAbs, note: trimmed })
                      : buildRerunNoteUtterance({ shotId: shot.shot_id, pathAbs, refsAbs, role, note: trimmed, isVideo: video, turntableAbs });
                    void send(text);
                    setNoteShot("");
                  },
                }, "发送"),
              )
            : null,
        );
      });
      return react.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 8 } },
        react.createElement("div", { style: { margin: 0, fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-tertiary)", textTransform: "uppercase", letterSpacing: 0.5 } }, "本轮套装"),
        react.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 } }, ...cells),
        hintLine(submitState),
      );
    }

    // 图片生成卡片:同步 /v1/images/generations → 展示 <img>。
    function NewapiImageRow(props) {
      const meta = TOOL_META[props.toolName];
      if (meta === void 0) return null;
      const block = props.block;
      const settled = block.kind === "tool-result";
      const args = argsOf(block);
      const result = settled ? resultOf(block) : null;
      const failed = settled && (block.isError === true || (result === null && textContentOf(block) !== ""));
      const prompt = typeof args.prompt === "string" ? args.prompt : "";

      const cardStyle = { display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 12, background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.06))", border: "1px solid var(--dsw-alias-border-l2)", minWidth: 260, maxWidth: 440 };
      const headStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
      const titleStyle = { margin: 0, fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
      const captionStyle = { margin: "2px 0 0", fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--dsw-alias-label-caption)" };
      const statusChip = (label, kind) => ({ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 999, color: "#fff", background: kind === "failed" ? "var(--dsw-alias-state-error-primary, #dc2626)" : kind === "done" ? "var(--dsw-alias-state-success-primary, #16a34a)" : "var(--dsw-alias-state-warn-primary, #d97706)" });
      const sectionStyle = { display: "flex", flexDirection: "column", gap: 6 };
      const sectionLabelStyle = { fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-tertiary)", textTransform: "uppercase", letterSpacing: 0.4 };
      const promptStyle = { margin: 0, fontSize: 14, lineHeight: 1.45, color: "var(--dsw-alias-label-primary)", overflowWrap: "anywhere" };
      const chipRowStyle = { display: "flex", flexWrap: "wrap", gap: 6 };
      const chipStyle = { fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "var(--dsw-alias-bg-layer-3)", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)" };
      const imgWrapStyle = { borderRadius: 10, overflow: "hidden", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)" };
      const imgStyle = { display: "block", width: "100%", maxHeight: 300, objectFit: "contain", background: "var(--dsw-alias-bg-base)" };
      const emptyStyle = { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", fontStyle: "italic" };

      let statusLabel = "生成中";
      let statusKind = "running";
      if (failed) {
        statusLabel = "失败";
        statusKind = "failed";
      } else if (settled) {
        statusLabel = "已完成";
        statusKind = "done";
      }

      const paramChips = [];
      if (typeof args.model === "string" && args.model !== "") paramChips.push(["模型", args.model]);
      if (typeof args.size === "string" && args.size !== "") paramChips.push(["尺寸", args.size]);
      if (typeof args.quality === "string" && args.quality !== "") paramChips.push(["画质", args.quality]);
      if (typeof args.negative_prompt === "string" && args.negative_prompt !== "") paramChips.push(["负向", "有"]);

      const refs = [];
      if (typeof args.image === "string" && args.image !== "") refs.push({ label: "参考图", path: args.image });
      if (Array.isArray(args.images)) for (const ref of args.images) if (typeof ref === "string" && ref !== "") refs.push({ label: "参考图", path: ref });

      const resultFiles = Array.isArray(result?.files) ? result.files : [];
      const role = result?.role || args.role || "";
      const cwd = typeof props.cwd === "string" ? props.cwd : "";
      const [roundInfo, setRoundInfo] = react.useState(null);
      const [roundFetchOk, setRoundFetchOk] = react.useState(false);
      const [submitState, setSubmitState] = react.useState(null);
      react.useEffect(() => {
        if (!cwd) return;
        let live = true;
        fetch("/newapi/session-shots?project=" + encodeURIComponent(cwd))
          .then((r) => (r.ok ? r.json() : Promise.reject()))
          .then((data) => {
            if (!live) return;
            setRoundFetchOk(true);
            setRoundInfo(data);
          })
          .catch(() => {
            if (!live) return;
            setRoundFetchOk(false);
            setRoundInfo(null);
          });
        return () => {
          live = false;
        };
      }, [cwd, settled, resultFiles.length]);

      const turntablePath = resultFiles[0]?.path || "";
      const refsAbs = joinAbsList(cwd, Array.isArray(args.images) ? args.images : args.image ? [args.image] : []);
      const turntableAbs = joinAbs(cwd, turntablePath);
      const hasNonTurntable = Array.isArray(roundInfo?.shots) && roundInfo.shots.some((s) => s.shot_id !== "_turntable");
      const showConfirm = shouldShowConfirmBar({
        role,
        settled,
        failed,
        hasCwd: cwd !== "",
        fetchOk: roundFetchOk,
        turntableConfirmed: roundInfo?.turntableConfirmed === true,
        hasNonTurntable,
      });
      const src = videoSrc(resultFiles[0]);
      const resultBlock = settled
        ? result === null
          ? react.createElement("p", { style: emptyStyle }, "无结构化结果")
          : react.createElement(
              "div",
              { style: sectionStyle },
              react.createElement("div", { style: sectionLabelStyle }, "生成结果"),
              src
                ? react.createElement("div", { style: imgWrapStyle }, react.createElement("img", { src, alt: args.prompt ?? "", style: imgStyle }))
                : result?.urls?.length > 0
                  ? react.createElement("a", { href: result.urls[0], target: "_blank", rel: "noreferrer", style: { fontSize: 12, color: "var(--dsw-alias-brand-primary, #3b82f6)" } }, "结果图片链接")
                  : react.createElement("p", { style: emptyStyle }, "已生成"),
              react.createElement(
                "p",
                { style: { margin: 0, fontSize: 11, color: "var(--dsw-alias-label-tertiary)", overflowWrap: "anywhere" } },
                `张数: ${result?.count ?? resultFiles.length}`,
              ),
            )
        : null;

      const children = [react.createElement("div", { style: headStyle },
        react.createElement("div", { style: { minWidth: 0 } },
          react.createElement("p", { style: captionStyle }, "视频工坊"),
          react.createElement("h4", { style: titleStyle }, meta.title),
        ),
        react.createElement("span", { role: "status", style: statusChip(statusLabel, statusKind) }, statusLabel),
      )];
      if (prompt !== "") children.push(react.createElement("p", { style: promptStyle }, prompt));
      if (paramChips.length > 0) children.push(react.createElement("div", { style: chipRowStyle }, paramChips.map(([k, v]) => react.createElement("span", { key: k, style: chipStyle }, `${k}: ${v}`))));
      if (refs.length > 0) children.push(react.createElement("div", { style: chipRowStyle }, react.createElement("span", { style: chipStyle, title: refs.map((r) => r.path).join("\n") }, `编辑参考图 ×${refs.length}`)));
      if (resultBlock !== null) children.push(resultBlock);
      children.push(react.createElement(NewapiFilesGallery, { key: "gallery", files: resultFiles }));
      if (showConfirm) {
        const run = async (kind) => {
          const text = kind === "confirm"
            ? buildConfirmUtterance({ turntableAbs, refsAbs })
            : buildRegenUtterance({ turntableAbs, refsAbs });
          if (kind === "confirm" && cwd) {
            try {
              const r = await fetch("/newapi/session-shots?project=" + encodeURIComponent(cwd), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "confirm" }),
              });
              if (!r.ok) setSubmitState({ status: "shown", text: "台账未写上，仍会发送确认话术。\n" + text });
            } catch {
              setSubmitState({ status: "shown", text: "台账未写上，仍会发送确认话术。\n" + text });
            }
          }
          const resultStatus = await requestSubmit(text);
          setSubmitState({ ...resultStatus, text });
        };
        children.push(
          react.createElement(
            "div",
            { key: "confirm", style: { display: "flex", flexDirection: "column", gap: 8 } },
            react.createElement("div", { style: { fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-tertiary)" } }, "请确认全能参考图细节是否对得上"),
            react.createElement(
              "div",
              { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
              react.createElement("button", { type: "button", style: actionBtnStyle, onClick: () => void run("confirm") }, "确认，继续"),
              react.createElement("button", { type: "button", style: actionBtnStyle, onClick: () => void run("regen") }, "重生"),
            ),
            hintLine(submitState),
          ),
        );
      }
      children.push(react.createElement(NewapiRoundGallery, {
        key: "round",
        cwd,
        cardRel: cardRelFromResult(cwd, result),
      }));
      return react.createElement("div", { style: cardStyle }, ...children);
    }

    function NewapiToolRow(props) {
      const meta = TOOL_META[props.toolName];
      if (meta === void 0) return null;
      if (props.toolName === "newapi_assets") {
        return react.createElement(NewapiAssetsRow, props);
      }
      if (props.toolName === "newapi_generate_image") {
        return react.createElement(NewapiImageRow, props);
      }
      const block = props.block;
      const settled = block.kind === "tool-result";
      const args = argsOf(block);
      const result = settled ? resultOf(block) : null;
      const failed = settled && (block.isError === true || (result === null && textContentOf(block) !== ""));
      const prompt = typeof args.prompt === "string" ? args.prompt : "";

      const [taskState, setTaskState] = react.useState(void 0);
      react.useEffect(() => {
        if (props.toolName !== "newapi_generate_video" || settled || prompt === "") return;
        let live = true;
        let timer;
        const poll = async () => {
          try {
            const params = new URLSearchParams();
            if (typeof props.cwd === "string" && props.cwd !== "") {
              params.set("project", props.cwd);
              params.set("cwd", props.cwd);
            }
            params.set("prompt", prompt);
            const headers = typeof props.cwd === "string" && props.cwd !== "" ? { "x-newapi-project": props.cwd } : {};
            const response = await fetch(`/newapi/tasks?${params.toString()}`, { headers });
            if (!response.ok) return;
            const data = await response.json();
            const match = (data.tasks ?? []).find((task) =>
              typeof task.prompt === "string" &&
              (task.prompt === prompt || task.prompt.includes(prompt) || prompt.includes(task.prompt)),
            );
            if (live && match !== void 0) {
              const label =
                typeof match.stateLabel === "string" && match.stateLabel !== ""
                  ? match.stateLabel
                  : friendlyState(match.state);
              const pct = typeof match.progress === "number" ? Math.round(match.progress) : void 0;
              setTaskState(pct >= 0 ? `${label} ${pct}%` : label);
            }
          } catch {
            // ignore polling errors
          }
        };
        void poll();
        timer = window.setInterval(() => {
          void poll();
        }, 3000);
        return () => {
          live = false;
          if (timer !== void 0) window.clearInterval(timer);
        };
      }, [props.toolName, settled, prompt, props.cwd]);

      const cardStyle = {
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        borderRadius: 12,
        background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.06))",
        border: "1px solid var(--dsw-alias-border-l2)",
        minWidth: 260,
        maxWidth: 440,
      };
      const headStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
      const titleStyle = { margin: 0, fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
      const captionStyle = { margin: "2px 0 0", fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--dsw-alias-label-caption)" };
      const statusChip = (label, kind) => ({
        fontSize: 11,
        fontWeight: 600,
        padding: "3px 8px",
        borderRadius: 999,
        color: "#fff",
        background:
          kind === "failed"
            ? "var(--dsw-alias-state-error-primary, #dc2626)"
            : kind === "done"
              ? "var(--dsw-alias-state-success-primary, #16a34a)"
              : "var(--dsw-alias-state-warn-primary, #d97706)",
      });
      const sectionStyle = { display: "flex", flexDirection: "column", gap: 4 };
      const sectionLabelStyle = { fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-tertiary)", textTransform: "uppercase", letterSpacing: 0.4 };
      const promptStyle = { margin: 0, fontSize: 14, lineHeight: 1.45, color: "var(--dsw-alias-label-primary)", overflowWrap: "anywhere" };
      const chipRowStyle = { display: "flex", flexWrap: "wrap", gap: 6 };
      const chipStyle = { fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "var(--dsw-alias-bg-layer-3)", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)" };
      const refRowStyle = { display: "flex", flexWrap: "wrap", gap: 6 };
      const refChipStyle = {
        ...chipStyle,
        cursor: "pointer",
        textDecoration: "underline dotted",
        textUnderlineOffset: 2,
      };
      const videoWrapStyle = { borderRadius: 10, overflow: "hidden", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)" };
      const videoStyle = { display: "block", width: "100%", maxHeight: 300, objectFit: "contain", background: "var(--dsw-alias-bg-base)" };
      const emptyStyle = { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", fontStyle: "italic" };

      let statusLabel = "排队中";
      let statusKind = "running";
      const friendlyResult = settled
        ? (typeof result?.statusLabel === "string" && result.statusLabel !== ""
            ? result.statusLabel
            : friendlyState(result?.status))
        : "";
      if (failed) {
        statusLabel = "失败";
        statusKind = "failed";
      } else if (settled) {
        statusLabel = friendlyResult || "已完成";
        statusKind = statusLabel === "失败" ? "failed" : "done";
      } else if (taskState !== void 0 && taskState !== null) {
        statusLabel = taskState;
      }

      // 参数 chips
      const paramChips = [];
      if (typeof args.model === "string" && args.model !== "") paramChips.push(["模型", args.model]);
      if (typeof args.aspect_ratio === "string" && args.aspect_ratio !== "") paramChips.push(["画幅", args.aspect_ratio]);
      if (typeof args.duration === "number" && args.duration > 0) paramChips.push(["时长", `${args.duration}s`]);
      if (typeof args.resolution === "string" && args.resolution !== "") paramChips.push(["档位", args.resolution]);
      if (typeof args.size === "string" && args.size !== "") paramChips.push(["尺寸", args.size]);

      // 素材引用(可点击打开)
      const refs = [];
      if (typeof args.first_frame === "string" && args.first_frame !== "") refs.push({ label: "首帧", path: args.first_frame });
      if (typeof args.last_frame === "string" && args.last_frame !== "") refs.push({ label: "末帧", path: args.last_frame });
      if (typeof args.video === "string" && args.video !== "") refs.push({ label: "源视频", path: args.video });
      if (Array.isArray(args.reference_images)) {
        for (const ref of args.reference_images) {
          if (typeof ref === "string" && ref !== "") refs.push({ label: "参考图", path: ref });
        }
      }

      // 结果视频
      const resultFiles = Array.isArray(result?.files) ? result.files : [];
      const src = videoSrc(resultFiles[0]);

      const resultBlock = settled ? (
        result === null
          ? react.createElement("p", { style: emptyStyle }, "无结构化结果")
          : react.createElement(
              "div",
              { style: sectionStyle },
              react.createElement("div", { style: sectionLabelStyle }, "生成结果"),
              src
                ? react.createElement(
                    "div",
                    { style: videoWrapStyle },
                    react.createElement("video", { controls: true, autoPlay: true, muted: true, loop: true, playsInline: true, src, style: videoStyle }),
                  )
                : result?.urls?.length > 0
                  ? react.createElement(
                      "a",
                      { href: result.urls[0], target: "_blank", rel: "noreferrer", style: { fontSize: 12, color: "var(--dsw-alias-brand-primary, #3b82f6)" } },
                      "结果视频链接",
                    )
                  : react.createElement("p", { style: emptyStyle }, "已生成"),
              typeof result?.taskId === "string" && result.taskId !== ""
                ? react.createElement("p", { style: { margin: 0, fontSize: 11, color: "var(--dsw-alias-label-tertiary)", overflowWrap: "anywhere" } }, "任务 ID:", result.taskId)
                : null,
            )
      ) : null;

      const children = [];
      children.push(
        react.createElement(
          "div",
          { style: headStyle },
          react.createElement(
            "div",
            { style: { minWidth: 0 } },
            react.createElement("p", { style: captionStyle }, "视频工坊"),
            react.createElement("h4", { style: titleStyle }, meta.title),
          ),
          react.createElement("span", { role: "status", style: statusChip(statusLabel, statusKind) }, statusLabel),
        ),
      );

      if (prompt !== "") {
        children.push(
          react.createElement(
            "div",
            { style: sectionStyle },
            react.createElement("div", { style: sectionLabelStyle }, "提示词"),
            react.createElement("p", { style: promptStyle }, prompt),
          ),
        );
      }

      if (paramChips.length > 0) {
        children.push(
          react.createElement(
            "div",
            { style: sectionStyle },
            react.createElement("div", { style: sectionLabelStyle }, "参数"),
            react.createElement(
              "div",
              { style: chipRowStyle },
              paramChips.map(([label, value]) =>
                react.createElement("span", { key: label, style: chipStyle }, `${label}: ${value}`),
              ),
            ),
          ),
        );
      }

      if (refs.length > 0) {
        children.push(
          react.createElement(
            "div",
            { style: sectionStyle },
            react.createElement("div", { style: sectionLabelStyle }, "素材"),
            react.createElement(
              "div",
              { style: refRowStyle },
              refs.map((ref, index) =>
                react.createElement(
                  "span",
                  { key: index, style: refChipStyle, title: ref.path, onClick: () => {
                    if (!props.openFile) return;
                    let target = String(ref.path || "").trim();
                    if (target.startsWith("@")) target = target.slice(1);
                    // 相对路径(如 newapi_image/xxx.png)结合工作区 cwd 解析成绝对路径,避免把 @ 当路径
                    if (!/^https?:\/\//i.test(target) && !/^[a-zA-Z]:[\\/]/.test(target) && typeof props.cwd === "string" && props.cwd !== "") {
                      target = String(props.cwd).replace(/[\\/]+$/, "") + "\\" + target.replace(/[\\/]+/g, "\\");
                    }
                    props.openFile(target);
                  } },
                  `${ref.label}: ${ref.path}`,
                ),
              ),
            ),
          ),
        );
      }

      if (resultBlock) children.push(resultBlock);

      // 生成完成后,卡片底部展示「本次生成」的成品画廊(而非工作区全部素材)
      children.push(react.createElement(NewapiFilesGallery, { key: "gallery", files: resultFiles }));
      children.push(react.createElement(NewapiRoundGallery, {
        key: "round",
        cwd: typeof props.cwd === "string" ? props.cwd : "",
        cardRel: cardRelFromResult(typeof props.cwd === "string" ? props.cwd : "", result),
      }));

      return react.createElement("div", { style: cardStyle }, ...children);
    }

    // -----------------------------------------------------------------------
    // 设置页组件
    // -----------------------------------------------------------------------
    function NewapiVideoSection(scope) {
      return function Section() {
        const snapshot = react.useSyncExternalStore(
          (callback) => scope.subscribe(callback),
          () => scope.getSnapshot(),
        );
        const value = snapshot.value ?? {};
        const ready = snapshot.status === "ready";
        const writable = snapshot.writable === true;

        const [draft, setDraft] = react.useState({});
        const [saveStatus, setSaveStatus] = react.useState("idle");
        const [saveMessage, setSaveMessage] = react.useState("");
        const [open, setOpen] = react.useState(false);
        const [models, setModels] = react.useState([]);
        const [modelsLoading, setModelsLoading] = react.useState(false);

        const refreshModels = react.useCallback(async () => {
          setModelsLoading(true);
          try {
            const r = await fetch("/newapi/models");
            const d = r.ok ? await r.json() : { models: [] };
            setModels(Array.isArray(d?.models) ? d.models : []);
          } catch {
            setModels([]);
          }
          setModelsLoading(false);
        }, []);

        react.useEffect(() => {
          refreshModels();
        }, [refreshModels]);
        // 中转站 /v1/models 可能不列出快乐马/部分 seedance 等模型,但接受不在列表的模型 id。
        // 因此除返回列表外,再内置这些常用 id 作为下拉建议;仍可用「自定义…」手填任意 id。
        const HAPPYHORSE_MODELS = ["happyhorse-1.1-i2v", "happyhorse-1.1-t2v", "happyhorse-1.0-i2v", "happyhorse-1.0-t2v"];
        const SEEDANCE_MODELS = ["doubao-seedance-2-0-mini-260615"];
        const videoModels = [...new Set([...models.filter((m) => /seedance|happyhorse|video|wan|h3|vidu/i.test(m)), ...HAPPYHORSE_MODELS, ...SEEDANCE_MODELS])];
        const imageModels = [...new Set([...models.filter((m) => /image|seedream|banana/i.test(m))])];

        react.useEffect(() => {
          if (ready && snapshot.value) setDraft({ ...snapshot.value });
        }, [ready, snapshot.value]);

        const cardStyle = { padding: "12px 4px", display: "flex", flexDirection: "column", gap: 2 };
        const titleStyle = { margin: 0, fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
        const descStyle = { margin: "0 0 4px", fontSize: 12, color: "var(--dsw-alias-label-tertiary)" };
        const fieldStyle = { padding: "8px 0" };
        const labelStyle = { display: "block", fontSize: 13, fontWeight: 500, color: "var(--dsw-alias-label-primary)", marginBottom: 4 };
        const inputStyle = {
          width: "100%",
          boxSizing: "border-box",
          height: 34,
          padding: "0 12px",
          fontSize: 13,
          color: "var(--dsw-alias-label-primary)",
          background: "var(--dsw-alias-bg-layer-3)",
          border: "1px solid var(--dsw-alias-border-l2)",
          borderRadius: 8,
        };
        const hintStyle = { margin: "4px 0 0", fontSize: 12, color: "var(--dsw-alias-label-tertiary)" };
        const boolRowStyle = { display: "flex", alignItems: "center", gap: 8, padding: "8px 0" };
        const boolLabelStyle = { fontSize: 13, color: "var(--dsw-alias-label-primary)", cursor: "pointer" };
        const saveRowStyle = {
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 0 4px",
          marginTop: 6,
          borderTop: "1px solid var(--dsw-alias-border-l2)",
        };
        const saveButtonStyle = {
          height: 32,
          padding: "0 16px",
          fontSize: 13,
          fontWeight: 600,
          color: "#fff",
          background: "var(--dsw-alias-brand-primary, #3b82f6)",
          border: "none",
          borderRadius: 8,
          cursor: "pointer",
        };
        const saveButtonDisabledStyle = { ...saveButtonStyle, opacity: 0.5, cursor: "not-allowed" };

        function normalize(field, raw) {
          if (field.type === "bool") return raw === true;
          if (field.type === "number") {
            if (typeof raw === "number") return raw;
            const s = String(raw ?? "").trim();
            if (s === "") return 0;
            const num = Number(s);
            return Number.isNaN(num) ? void 0 : num;
          }
          return typeof raw === "string" ? raw : String(raw ?? "");
        }

        async function handleSave() {
          if (saveStatus === "saving" || !writable) return;
          setSaveStatus("saving");
          setSaveMessage("正在保存…");
          const before = scope.getSnapshot().revision;

          const ops = [];
          for (const field of FIELDS) {
            const next = normalize(field, draft[field.key]);
            if (next === void 0) continue;
            const current = normalize(field, value[field.key] ?? "");
            if (!Object.is(next, current)) ops.push({ field, next });
          }

          try {
            for (const { field, next } of ops) await scope.set(field.key, next);
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
            const after = scope.getSnapshot().revision;
            const ok = ops.length === 0 || (after !== void 0 && after !== before);
            setSaveStatus(ok ? "success" : "error");
            setSaveMessage(ops.length === 0 ? "没有需要保存的变更" : ok ? "保存成功 ✓" : "保存失败,请重试");
          } catch (error) {
            setSaveStatus("error");
            setSaveMessage("保存失败:" + (error && error.message ? error.message : String(error)));
          }

          setTimeout(() => {
            setSaveStatus((s) => (s === "success" || s === "error" ? "idle" : s));
            setSaveMessage("");
          }, 3000);
        }

        const rows = FIELDS.filter((field) => !field.onlyFor || draft.provider === field.onlyFor).map((field) => {
          const draftValue = draft[field.key];
          if (field.type === "bool") {
            return react.createElement(
              "label",
              { key: field.key, style: boolRowStyle },
              react.createElement("input", {
                type: "checkbox",
                checked: draftValue === true,
                disabled: !writable,
                onChange: (event) => setDraft((d) => ({ ...d, [field.key]: event.target.checked })),
              }),
              react.createElement("span", { style: boolLabelStyle }, field.label),
              field.hint ? react.createElement("span", { style: { ...hintStyle, margin: 0 } }, field.hint) : null,
            );
          }
          if (field.type === "select") {
            const select = react.createElement(
              "select",
              {
                key: field.key,
                value: typeof draftValue === "string" ? draftValue : (field.options[0][0] ?? ""),
                disabled: !writable,
                style: inputStyle,
                onChange: (event) => setDraft((d) => ({ ...d, [field.key]: event.target.value })),
              },
              (field.options ?? []).map((opt) => react.createElement("option", { key: opt[0], value: opt[0] }, opt[1])),
            );
            return react.createElement(
              "div",
              { key: field.key, style: fieldStyle },
              react.createElement("label", { style: labelStyle }, field.label),
              select,
              field.hint ? react.createElement("p", { style: hintStyle }, field.hint) : null,
            );
          }
          if (field.type === "model") {
            const opts = field.kind === "video" ? videoModels : imageModels;
            const currVal = draftValue === undefined || draftValue === null ? "" : String(draftValue);
            const isKnown = opts.includes(currVal);
            const selectValue = isKnown ? currVal : "__custom__";
            const modelSelect = react.createElement(
              "select",
              {
                key: field.key,
                value: selectValue,
                disabled: !writable,
                style: { ...inputStyle, flex: 1, minWidth: 0 },
                onChange: (event) => setDraft((d) => ({ ...d, [field.key]: event.target.value })),
              },
              opts.map((m) => react.createElement("option", { key: m, value: m }, m)).concat(
                react.createElement("option", { key: "__custom__", value: "__custom__" }, "自定义…"),
              ),
            );
            const customInput =
              selectValue === "__custom__"
                ? react.createElement("input", {
                    type: "text",
                    value: currVal,
                    disabled: !writable,
                    placeholder: "输入自定义模型 id",
                    style: { ...inputStyle, marginTop: 6 },
                    onChange: (event) => setDraft((d) => ({ ...d, [field.key]: event.target.value })),
                  })
                : null;
            const refreshBtn = react.createElement(
              "button",
              {
                type: "button",
                disabled: !writable || modelsLoading,
                onClick: () => refreshModels(),
                style: {
                  height: 34,
                  padding: "0 12px",
                  fontSize: 12,
                  fontWeight: 600,
                  border: "1px solid var(--dsw-alias-border-l2)",
                  borderRadius: 8,
                  background: "var(--dsw-alias-bg-layer-3)",
                  color: "var(--dsw-alias-label-primary)",
                  cursor: writable && !modelsLoading ? "pointer" : "not-allowed",
                  whiteSpace: "nowrap",
                  flex: "none",
                },
              },
              modelsLoading ? "获取中…" : "获取模型",
            );
            return react.createElement(
              "div",
              { key: field.key, style: fieldStyle },
              react.createElement("label", { style: labelStyle }, field.label),
              react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } }, modelSelect, refreshBtn),
              customInput,
              field.hint ? react.createElement("p", { style: hintStyle }, field.hint) : null,
              modelsLoading ? react.createElement("p", { style: hintStyle }, "正在获取模型列表…") : null,
            );
          }
          if (field.type === "chip") {
            const curr = draftValue === undefined || draftValue === null ? "" : String(draftValue);
            const chipRow = react.createElement(
              "div",
              { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
              (field.options ?? []).map(([value, label]) => {
                const active = curr === value;
                const chipStyle = {
                  height: 28,
                  padding: "0 12px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 600,
                  border: "1px solid var(--dsw-alias-border-l2)",
                  cursor: writable ? "pointer" : "not-allowed",
                  opacity: writable ? 1 : 0.6,
                  color: active ? "#fff" : "var(--dsw-alias-label-secondary)",
                  background: active ? "var(--dsw-alias-brand-primary, #3b82f6)" : "var(--dsw-alias-bg-layer-3)",
                };
                return react.createElement("button", { key: value, style: chipStyle, disabled: !writable, onClick: () => setDraft((d) => ({ ...d, [field.key]: value })) }, label);
              }),
            );
            return react.createElement(
              "div",
              { key: field.key, style: fieldStyle },
              react.createElement("label", { style: labelStyle }, field.label),
              chipRow,
              field.hint ? react.createElement("p", { style: hintStyle }, field.hint) : null,
            );
          }
          const input = react.createElement("input", {
            key: field.key,
            type: field.type === "password" ? "password" : "text",
            value: draftValue === undefined || draftValue === null ? "" : String(draftValue),
            disabled: !writable,
            style: inputStyle,
            onChange: (event) => setDraft((d) => ({ ...d, [field.key]: event.target.value })),
          });
          return react.createElement(
            "div",
            { key: field.key, style: fieldStyle },
            react.createElement("label", { style: labelStyle }, field.label),
            input,
            field.hint ? react.createElement("p", { style: hintStyle }, field.hint) : null,
          );
        });

        const statusStyle = {
          margin: 0,
          fontSize: 12,
          fontWeight: 500,
          color:
            saveStatus === "success"
              ? "var(--dsw-alias-state-success-primary, #16a34a)"
              : saveStatus === "error"
                ? "var(--dsw-alias-state-error-primary, #dc2626)"
                : "var(--dsw-alias-label-tertiary)",
        };
        const saveRow = react.createElement(
          "div",
          { style: saveRowStyle },
          react.createElement(
            "button",
            {
              type: "button",
              style: writable && saveStatus !== "saving" ? saveButtonStyle : saveButtonDisabledStyle,
              disabled: !writable || saveStatus === "saving",
              onClick: handleSave,
            },
            saveStatus === "saving" ? "保存中…" : "保存",
          ),
          saveStatus === "success" || saveStatus === "error" || saveStatus === "saving"
            ? react.createElement("p", { style: statusStyle }, saveMessage)
            : null,
        );

        const chevron = react.createElement(
          "svg",
          { width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", style: { transition: "transform .15s ease", transform: open ? "rotate(180deg)" : "none", flexShrink: 0 } },
          react.createElement("path", { d: "M4 6l4 4 4-4" }),
        );

        return react.createElement(
          "div",
          { style: { ...cardStyle, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)", padding: 0, overflow: "hidden" } },
          react.createElement(
            "button",
            {
              type: "button",
              onClick: () => setOpen((v) => !v),
              "aria-expanded": open,
              style: { display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "12px 14px", background: "none", border: "none", cursor: "pointer", color: "var(--dsw-alias-label-primary)", textAlign: "left" },
            },
            react.createElement(
              "span",
              { style: { minWidth: 0 } },
              react.createElement("h3", { style: { ...titleStyle, fontSize: 15 } }, "视频工坊"),
              react.createElement("p", { style: descStyle }, "调用 new-api 中转站视频模型;修改后点「保存」生效(无需重启)"),
            ),
            chevron,
          ),
          open
            ? react.createElement(
                "div",
                { style: { padding: "8px 14px 14px" } },
                ready ? react.createElement(react.Fragment, null, rows, saveRow) : react.createElement("p", { style: descStyle }, "正在加载配置…"),
              )
            : null,
        );
      };
    }

    const inject = ["slots", "settingsScope"];

    // -----------------------------------------------------------------------
    // 输入框上方实时预览条:解析 draft 里的 @图片/@视频 引用,渲染缩略图
    // -----------------------------------------------------------------------
    const MEDIA_REF_RE = /@(?:(["'])([^"']*)\1|([^\s@]+))/g;
    const MEDIA_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|avif|svg|mp4|mov|webm|mkv|m4v|avi)$/i;
    const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|m4v|avi)$/i;

    function parseMediaRefs(draft) {
      const out = [];
      if (typeof draft !== "string" || draft === "") return out;
      MEDIA_REF_RE.lastIndex = 0;
      let m;
      while ((m = MEDIA_REF_RE.exec(draft)) !== null) {
        const ref = ((m[2] ?? m[3] ?? "") || "").trim();
        if (ref === "") continue;
        if (MEDIA_EXT_RE.test(ref)) out.push(ref);
      }
      return out;
    }

    // 当前会话工作区:与 @ 引用选择器一致(会话级),避免 /newapi/workspace 误选到其它活动会话/第一个根
    function sessionCwd(props) {
      const s = props?.session;
      if (!s) return "";
      return s.cwd || s?.header?.cwd || s?.workspace?.path || s?.workspace?.cwd || s?.path || "";
    }
    // 初始化 project:优先取会话 cwd(同步、会话级正确),否则回退到 /newapi/workspace
    function useWorkspaceProject(props, setProject) {
      react.useEffect(() => {
        let live = true;
        const sc = sessionCwd(props);
        if (sc) {
          setProject(sc);
          return () => {
            live = false;
          };
        }
        fetch("/newapi/workspace")
          .then((r) => (r.ok ? r.json() : { project: "" }))
          .then((d) => {
            if (live) setProject(typeof d?.project === "string" ? d.project : "");
          })
          .catch(() => {});
        return () => {
          live = false;
        };
      }, [props]);
    }

    function NewapiComposerPreview(props) {
      const [project, setProject] = react.useState("");
      useWorkspaceProject(props, setProject);

      const draft = props.input?.draft;
      const refs = parseMediaRefs(draft);
      if (refs.length === 0) return null;

      const rowStyle = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", padding: "4px 6px 6px" };
      const chipStyle = { position: "relative", width: 60, height: 60, borderRadius: 8, overflow: "hidden", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", flex: "none" };
      const mediaStyle = { width: "100%", height: "100%", objectFit: "cover", display: "block" };
      const labelStyle = { position: "absolute", left: 0, right: 0, bottom: 0, fontSize: 9, lineHeight: 1.4, padding: "1px 4px", color: "#fff", background: "rgba(0,0,0,0.55)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

      const chips = refs.map((ref, index) => {
        const url = `/newapi/preview?path=${encodeURIComponent(ref)}&project=${encodeURIComponent(project)}`;
        const isVideo = VIDEO_EXT_RE.test(ref);
        const media = isVideo
          ? react.createElement("video", {
              src: url,
              preload: "metadata",
              muted: true,
              playsInline: true,
              style: mediaStyle,
              // `preload="metadata"` 只加载元数据、不渲染帧;seek 到极小时间强制解码出首帧
              onLoadedMetadata: (e) => {
                const v = e.currentTarget;
                v.currentTime = 0.001;
              },
              onCanPlay: (e) => {
                const v = e.currentTarget;
                if (v.paused && v.currentTime < 0.01) v.currentTime = 0.001;
              },
            })
          : react.createElement("img", { src: url, alt: ref, style: mediaStyle, onError: (e) => { e.currentTarget.style.opacity = "0.25"; } });
        const name = ref.split(/[\\/]/).pop() ?? ref;
        return react.createElement("div", { key: `${ref}#${index}`, style: chipStyle, title: ref }, media, react.createElement("span", { style: labelStyle }, name));
      });

      return react.createElement("div", { style: rowStyle }, chips);
    }

    // -----------------------------------------------------------------------
    // 智能创作:四步(描述诉求+素材 → 生成策划清单 → 审核确认 → 一键批量生成)
    // -----------------------------------------------------------------------
    const SMART_DEFS = [
      { key: "main", name: "爆款主图", ratio: "1:1", size: "1024x1024", prompt: (req) => `制作电商爆款主图,1:1,产品清晰居中,卖点突出,背景干净高级,高清。诉求:${req}` },
      { key: "detail", name: "详情卖点拆解", ratio: "3:4", size: "1024x1365", prompt: (req) => `制作电商详情页卖点拆解长图,3:4,突出核心卖点与功能,信息层级清晰,版式美观。诉求:${req}` },
      { key: "white", name: "纯白底精修", ratio: "1:1", size: "1024x1024", prompt: (req) => `制作纯白底精修标品图,1:1,产品完整呈现,柔和光影,纯净白底,高清。诉求:${req}` },
    ];

    function NewapiSmartCreate() {
      return function SmartPage() {
        const [project, setProject] = react.useState("");
        const [request, setRequest] = react.useState("");
        const [images, setImages] = react.useState([]);
        const [selRefs, setSelRefs] = react.useState([]);
        const [withVideo, setWithVideo] = react.useState(false);
        const [tasks, setTasks] = react.useState([]);
        const [generating, setGenerating] = react.useState(false);
        const [results, setResults] = react.useState([]);
        const [error, setError] = react.useState("");

        react.useEffect(() => {
          let live = true;
          (async () => {
            let ws = "";
            try {
              const wres = await fetch("/newapi/workspace");
              if (wres.ok) {
                const wdata = await wres.json();
                if (typeof wdata?.project === "string" && wdata.project !== "") ws = wdata.project;
              }
            } catch {
              // ignore
            }
            if (!live) return;
            setProject(ws);
            if (ws === "") return;
            try {
              const ares = await fetch(`/newapi/assets?project=${encodeURIComponent(ws)}`);
              if (ares.ok) {
                const adata = await ares.json();
                const imgs = (adata.assets || []).filter((a) => a.kind === "image");
                if (live) setImages(imgs);
              }
            } catch {
              // ignore
            }
          })();
          return () => {
            live = false;
          };
        }, []);

        const buildPlan = () => {
          const req = request.trim();
          const refs = selRefs.slice();
          if (refs.length === 0) {
            setError("请先勾选参考素材(产品图)");
            return;
          }
          const list = SMART_DEFS.map((d) => ({ kind: "image", key: d.key, name: d.name, ratio: d.ratio, size: d.size, prompt: d.prompt(req), reference: refs, model: "", enabled: true }));
          if (withVideo) {
            list.push({ kind: "video", key: "video", name: "宣传视频", ratio: "9:16", size: "", prompt: `${req} 制作一段产品宣传视频,主体突出,运镜流畅,风格统一。`, first_frame: refs[0], reference_images: [], model: "", duration: 5, aspect_ratio: "9:16", resolution: "720p", enabled: true });
          }
          setTasks(list);
          setResults([]);
          setError("");
        };

        const toggleTask = (key) =>
          setTasks((prev) => prev.map((t) => (t.key === key ? { ...t, enabled: !t.enabled } : t)));
        const setTaskPrompt = (key, prompt) =>
          setTasks((prev) => prev.map((t) => (t.key === key ? { ...t, prompt } : t)));

        const generate = async () => {
          const active = tasks.filter((t) => t.enabled);
          const activeRefs = selRefs.slice();
          if (active.length === 0) {
            setError("请至少勾选一个任务");
            return;
          }
          if (activeRefs.length === 0 && active.some((t) => t.kind === "image")) {
            setError("图片任务需要参考素材(产品图)");
            return;
          }
          setGenerating(true);
          setError("");
          setResults([]);
          try {
            const payload = {
              project,
              tasks: active.map((t) => {
                if (t.kind === "video") return { kind: "video", name: t.name, prompt: t.prompt, first_frame: t.first_frame, aspect_ratio: t.aspect_ratio, duration: t.duration, resolution: t.resolution, model: t.model };
                return { kind: "image", name: t.name, prompt: t.prompt, size: t.size, reference: t.reference, model: t.model };
              }),
            };
            const r = await fetch("/newapi/smart-generate", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(3600000),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(String(j?.error || `HTTP ${r.status}`));
            setResults(Array.isArray(j.results) ? j.results : []);
          } catch (err) {
            setError(String(err?.message ?? err));
          } finally {
            setGenerating(false);
          }
        };

        const pageStyle = { display: "flex", flexDirection: "column", gap: 14 };
        const h = (label, sub) =>
          react.createElement(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8 } },
            react.createElement("span", { style: { width: 24, height: 24, borderRadius: 999, background: "#3b82f6", color: "#fff", fontSize: 13, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" } }, label),
            react.createElement("span", { style: { fontWeight: 600, fontSize: 13, color: "var(--dsw-alias-label-primary)" } }, sub),
          );
        const textareaStyle = { width: "100%", boxSizing: "border-box", minHeight: 64, padding: 8, fontSize: 13, borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)", resize: "vertical" };
        const btn = { height: 28, padding: "0 12px", fontSize: 12, fontWeight: 600, borderRadius: 8, border: "none", cursor: "pointer", color: "#fff", background: "#3b82f6", whiteSpace: "nowrap" };
        const btnGhost = { ...btn, background: "transparent", color: "var(--dsw-alias-label-secondary)", border: "1px solid var(--dsw-alias-border-l2)" };
        const box = { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, padding: 10, background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03))" };

        const refRow = react.createElement(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          images.map((a) => {
            const on = selRefs.includes(a.rel);
            const st = { width: 74, height: 74, borderRadius: 8, overflow: "hidden", cursor: "pointer", border: on ? "2px solid #3b82f6" : "2px solid var(--dsw-alias-border-l1)", flex: "none", position: "relative" };
            return react.createElement(
              "div",
              { key: a.rel, style: st, title: a.name, onClick: () => setSelRefs((prev) => (on ? prev.filter((x) => x !== a.rel) : [...prev, a.rel])) },
              react.createElement("img", { src: a.url, style: { width: "100%", height: "100%", objectFit: "cover", display: "block" } }),
              react.createElement("span", { style: { position: "absolute", top: 2, right: 2, width: 16, height: 16, borderRadius: 999, background: on ? "#3b82f6" : "rgba(0,0,0,0.45)", color: "#fff", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center" } }, on ? "✓" : ""),
            );
          }),
        );

        const planBox = react.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 8 } },
          tasks.map((t) =>
            react.createElement(
              "div",
              { key: t.key, style: { display: "flex", alignItems: "center", gap: 8, padding: 8, borderRadius: 8, background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l1)" } },
              react.createElement("input", { type: "checkbox", checked: t.enabled, onChange: () => toggleTask(t.key) }),
              react.createElement("span", { style: { minWidth: 96, fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary)", whiteSpace: "nowrap" } }, `${t.name} · ${t.ratio}`),
              react.createElement("textarea", { value: t.prompt, onChange: (e) => setTaskPrompt(t.key, e.target.value), style: { flex: "1 1 auto", minHeight: 46, padding: "4px 6px", fontSize: 11, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)", resize: "vertical" } }),
            ),
          ),
        );

        const resultsBox = results.length > 0 &&
          react.createElement(
            "div",
            { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
            results.map((r, i) => {
              const url = r.files?.[0]?.url || r.urls?.[0] || "";
              const st = { width: 96, borderRadius: 8, overflow: "hidden", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)" };
              return react.createElement(
                "div",
                { key: i, style: st },
                r.ok
                  ? react.createElement("img", { src: url, style: { width: "100%", height: 96, objectFit: "cover", display: "block" } })
                  : react.createElement("div", { style: { width: "100%", height: 96, display: "flex", alignItems: "center", justifyContent: "center", color: "#dc2626", fontSize: 11, textAlign: "center", padding: 6 } }, "生成失败"),
                react.createElement("p", { style: { margin: 0, padding: "4px 6px", fontSize: 10, color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, r.ok ? r.name : String(r.error || r.name).slice(0, 30)),
              );
            }),
          );

        return react.createElement(
          "div",
          { style: pageStyle },
          react.createElement("p", { style: { margin: 0, fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--dsw-alias-label-caption)" } }, "视频工坊"),
          react.createElement("h4", { style: { margin: 0, fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "智能创作"),
          h("①", "描述创作诉求 + 输入素材"),
          react.createElement("div", { style: box },
            react.createElement("textarea", { placeholder: "例:帮我做一整套电商套图:1:1主图 + 3:4详情图 + 2K白底精修", value: request, onChange: (e) => setRequest(e.target.value), style: textareaStyle }),
            react.createElement("p", { style: { margin: "6px 0 4px", fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, "选择参考素材(产品图,可多选):"),
            images.length === 0 ? react.createElement("p", { style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, "素材库暂无图片,请先上传") : refRow,
          ),
          react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
            react.createElement("button", { style: btn, onClick: buildPlan }, "② 生成策划清单"),
            react.createElement("label", { style: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
              react.createElement("input", { type: "checkbox", checked: withVideo, onChange: (e) => setWithVideo(e.target.checked) }),
              "附带一条宣传视频"),
          ),
          tasks.length > 0 && h("③", "审核任务清单 · 策划确认"),
          tasks.length > 0 && planBox,
          tasks.length > 0 &&
            react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
              react.createElement("button", { style: btn, disabled: generating, onClick: generate }, generating ? "批量生成中…" : "④ 一键批量生成"),
            ),
          error !== "" && react.createElement("p", { style: { margin: 0, fontSize: 12, color: "#dc2626" } }, error),
          resultsBox,
        );
      };
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NS });

      // 1) 设置卡片:放到 Settings → 插件(settings.plugin.item),与 dsh-video-gen 同款入口。
      ctx.slots.inject("settings.plugin.item", () => {
        const dispose = ctx.slots.register(
          { name: "settings.plugin.item", key: NS, id: NS, order: 100, inject: () => ({ scope }) },
          NewapiVideoSection(scope),
        );
        return dispose;
      });

      // 2) 会话区顶部「对话 | 轨迹」旁再加一个「资产库」标签页(conversation.view)。
      //    宿主把 conversation.view 和输入框放在同一个 [data-conversation-scroll] 里,
      //    对话页会把滚动条锚在底部。不声明 composer-overlay 时,切到资产库后视口仍停在
      //    底部空白处,整页看起来全白。官方图库用同一标记把 viewArea 改成铺满视口、内部自滚。
      const AssetLibraryPanel = NewapiAssetsSection();
      function AssetsConversationView() {
        react.useEffect(() => {
          if (document.getElementById("nva-assets-view-css")) return;
          const el = document.createElement("style");
          el.id = "nva-assets-view-css";
          el.textContent =
            "[data-conversation-scroll]:has([data-newapi-assets]) > [data-composer-seat]{display:none!important}";
          document.head.appendChild(el);
        }, []);
        return react.createElement(
          "div",
          {
            "data-conversation-composer-overlay": "",
            "data-newapi-assets": "",
            style: {
              width: "100%",
              height: "100%",
              minHeight: 0,
              flex: 1,
              display: "flex",
              flexDirection: "column",
              overflow: "auto",
              background: "var(--dsw-alias-bg-base)",
              boxSizing: "border-box",
            },
          },
          react.createElement(AssetLibraryPanel),
        );
      }
      // 资产库标签页(conversation.view)始终挂载。
      ctx.slots.inject("conversation.view", () => {
        const dispose = ctx.slots.register(
          { name: "conversation.view", id: NS + "-assets-view", order: 11, label: () => "资产库", inject: () => ({}) },
          AssetsConversationView,
        );
        return dispose;
      });

      // 3) 可视化生成卡片
      ctx.slots.inject("tool.call.toolview", () => {
        const keys = Object.keys(TOOL_META);
        const disposers = keys.map((key) => ctx.slots.register({ name: "tool.call.toolview", key }, NewapiToolRow));
        return () => {
          for (const dispose of disposers) dispose();
        };
      });

      // 4) 输入框上方实时预览条:@ 引用的图片/视频直接渲染缩略图
      ctx.slots.inject("conversation.input.dock", () => {
        const disposeSubmit = ctx.slots.register({ name: "conversation.input.dock", id: NS + "-submit", order: 90 }, NewapiSubmitBridge);
        const disposePreview = ctx.slots.register({ name: "conversation.input.dock", id: NS + "-preview", order: 100 }, NewapiComposerPreview);
        return () => {
          disposeSubmit();
          disposePreview();
        };
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
