export function joinAbs(cwd, path) {
  const p = String(path || "").replace(/^@/, "").trim();
  if (p === "") return "";
  if (/^https?:\/\//i.test(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/")) return p.replace(/\\/g, "/");
  const root = String(cwd || "").replace(/[\\/]+$/, "");
  if (root === "") return p.replace(/\\/g, "/");
  return (root + "/" + p).replace(/\\/g, "/");
}

export function joinAbsList(cwd, paths) {
  return (Array.isArray(paths) ? paths : []).map((p) => joinAbs(cwd, p)).filter(Boolean);
}

export function formatRefsPhrase(absPaths) {
  return (absPaths || []).filter(Boolean).map((p) => "@" + p).join(" ");
}

export function buildConfirmUtterance({ turntableAbs, refsAbs }) {
  const refs = formatRefsPhrase(refsAbs);
  return `全能参考图已确认：@${turntableAbs}。产品源图：${refs}。请按已锁定规格继续生成套装。后续镜头用这组源图作 images，视频把全能图作为 reference_images。不要再生成 turntable。`;
}

export function buildRegenUtterance({ turntableAbs, refsAbs }) {
  const refs = formatRefsPhrase(refsAbs);
  return `全能参考图需要重生：@${turntableAbs}。产品源图：${refs}。请用同一组源图重新生成一张 role=turntable 的全能参考图，不要生成套装镜头。`;
}

export function buildRerunUtterance({ shotId, pathAbs, refsAbs, role, isVideo, turntableAbs }) {
  if (isVideo) {
    return `请按原参数重出镜头 ${shotId}：@${pathAbs}。全能参考图：@${turntableAbs}。使用 role=${role}，shot_id=${shotId}。`;
  }
  const refs = formatRefsPhrase(refsAbs);
  return `请按原参数重出镜头 ${shotId}：@${pathAbs}。产品源图：${refs}。使用 role=${role}，shot_id=${shotId}。`;
}

export function buildRerunNoteUtterance({ shotId, pathAbs, refsAbs, role, note, isVideo, turntableAbs }) {
  if (isVideo) {
    return `请按新需求重出镜头 ${shotId}：@${pathAbs}。需求：${note}。全能参考图：@${turntableAbs}。使用 role=${role}，shot_id=${shotId}。`;
  }
  const refs = formatRefsPhrase(refsAbs);
  return `请按新需求重出镜头 ${shotId}：@${pathAbs}。需求：${note}。产品源图：${refs}。使用 role=${role}，shot_id=${shotId}。`;
}

export function buildEditUtterance({ shotId, pathAbs, note }) {
  return `请在这张图上修改镜头 ${shotId}：@${pathAbs}。修改：${note}。使用 role=edit，shot_id=${shotId}，image=@${pathAbs}。需要锁外观时把 productRefs 一并传入 images，与当前图合计仍 ≤3。`;
}

export function tryRequestSubmit(text, actions, clipboard) {
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

export function shouldShowConfirmBar({ role, settled, failed, hasCwd, fetchOk, turntableConfirmed, hasNonTurntable }) {
  if (role !== "turntable" || !settled || failed) return false;
  if (!hasCwd || !fetchOk) return true;
  if (turntableConfirmed === true) return false;
  if (hasNonTurntable) return false;
  return true;
}

export function shouldShowRoundGallery({ shots, cardRel }) {
  const list = Array.isArray(shots) ? shots : [];
  if (list.length < 2 || !cardRel) return false;
  let latest = list[0];
  for (const item of list) {
    if ((item.updatedAt ?? 0) >= (latest.updatedAt ?? 0)) latest = item;
  }
  return latest.path === cardRel;
}

export function isVideoPath(path) {
  return /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(String(path || ""));
}

export function cardRelFromResult(cwd, result) {
  const files = Array.isArray(result?.files) ? result.files : [];
  const saved = files.find((f) => f && typeof f.path === "string" && f.path !== "");
  if (!saved) return "";
  const abs = String(saved.path).replace(/\\/g, "/");
  const root = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && abs.startsWith(root + "/")) return abs.slice(root.length + 1);
  return abs.split("/").slice(-2).join("/");
}
