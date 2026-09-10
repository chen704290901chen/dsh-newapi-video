import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export function emptyLedger() {
  return { files: [], roundId: "", turntableConfirmed: false, shots: {} };
}

export function parseLedgerRaw(raw) {
  if (Array.isArray(raw)) {
    return {
      files: raw.filter((p) => typeof p === "string" && p !== ""),
      roundId: "",
      turntableConfirmed: false,
      shots: {},
    };
  }
  if (raw && typeof raw === "object") {
    const files = Array.isArray(raw.files) ? raw.files.filter((p) => typeof p === "string" && p !== "") : [];
    const shots = raw.shots && typeof raw.shots === "object" && !Array.isArray(raw.shots) ? raw.shots : {};
    return {
      files,
      roundId: typeof raw.roundId === "string" ? raw.roundId : "",
      turntableConfirmed: raw.turntableConfirmed === true,
      shots,
    };
  }
  return emptyLedger();
}

export function sessionLedgerPath(project) {
  return join(resolve(project), ".dsh-newapi-session.json");
}

export function relFromAbs(project, fullPath) {
  const rel = relative(resolve(project), resolve(fullPath)).replace(/\\/g, "/");
  if (rel === "" || rel.startsWith("..")) return null;
  return rel;
}

export async function readSessionDocument(project) {
  try {
    const raw = JSON.parse((await readFile(sessionLedgerPath(project), "utf8")).replace(/^\uFEFF/, ""));
    return parseLedgerRaw(raw);
  } catch {
    return emptyLedger();
  }
}

export async function writeSessionDocument(project, doc) {
  const payload = {
    files: Array.isArray(doc.files) ? doc.files : [],
    roundId: typeof doc.roundId === "string" ? doc.roundId : "",
    turntableConfirmed: doc.turntableConfirmed === true,
    shots: doc.shots && typeof doc.shots === "object" && !Array.isArray(doc.shots) ? doc.shots : {},
  };
  await mkdir(dirname(sessionLedgerPath(project)), { recursive: true });
  await writeFile(sessionLedgerPath(project), JSON.stringify(payload, null, 0), "utf8");
}

export async function readSessionLedger(project) {
  const doc = await readSessionDocument(project);
  return new Set(doc.files);
}

export async function addSessionFile(project, fullPath) {
  try {
    const rel = relFromAbs(project, fullPath);
    if (rel === null) return;
    const doc = await readSessionDocument(project);
    if (doc.files.includes(rel)) return;
    doc.files = [...doc.files, rel];
    await writeSessionDocument(project, doc);
  } catch {
    // ignore ledger write errors
  }
}

export async function removeSessionFile(project, rel) {
  try {
    const normalized = String(rel).replace(/\\/g, "/");
    const doc = await readSessionDocument(project);
    if (!doc.files.includes(normalized)) return;
    doc.files = doc.files.filter((p) => p !== normalized);
    await writeSessionDocument(project, doc);
  } catch {
    // ignore ledger write errors
  }
}

export function applyRecordShot(doc, entry) {
  const role = entry?.role === "turntable" || entry?.role === "shot" || entry?.role === "edit" ? entry.role : "";
  if (role === "") return doc;
  let shotId = typeof entry.shotId === "string" ? entry.shotId.trim() : "";
  if (role === "turntable") shotId = "_turntable";
  if (shotId === "") return doc;
  const now = typeof entry.now === "number" ? entry.now : Date.now();
  const next = {
    files: Array.isArray(doc.files) ? [...doc.files] : [],
    roundId: doc.roundId || "",
    turntableConfirmed: doc.turntableConfirmed === true,
    shots: { ...(doc.shots && typeof doc.shots === "object" ? doc.shots : {}) },
  };
  if (role === "turntable") {
    next.roundId = "m" + now.toString(36);
    next.turntableConfirmed = false;
    next.shots = {};
  }
  next.shots[shotId] = {
    role,
    shot_id: shotId,
    path: String(entry.relPath || "").replace(/\\/g, "/"),
    refs: Array.isArray(entry.refs) ? entry.refs.map((p) => String(p).replace(/\\/g, "/")) : [],
    prompt: typeof entry.prompt === "string" ? entry.prompt : "",
    size: typeof entry.size === "string" ? entry.size : "",
    updatedAt: now,
  };
  return next;
}

export function confirmTurntable(doc) {
  const shots = doc?.shots && typeof doc.shots === "object" ? doc.shots : {};
  if (!shots._turntable) return { ok: false, status: 409, doc };
  return { ok: true, status: 200, doc: { ...doc, shots: { ...shots }, files: [...(doc.files || [])], turntableConfirmed: true } };
}

export function shotsGetResponse(project, doc) {
  const shotsObj = doc?.shots && typeof doc.shots === "object" ? doc.shots : {};
  const shots = Object.values(shotsObj)
    .filter((s) => s && typeof s === "object")
    .slice()
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
    .map((s) => ({
      role: s.role,
      shot_id: s.shot_id,
      path: s.path,
      refs: Array.isArray(s.refs) ? s.refs : [],
      prompt: s.prompt || "",
      size: s.size || "",
      updatedAt: s.updatedAt || 0,
      url: `/newapi/assets/file?project=${encodeURIComponent(project)}&rel=${encodeURIComponent(s.path || "")}`,
    }));
  return {
    project,
    roundId: typeof doc?.roundId === "string" ? doc.roundId : "",
    turntableConfirmed: doc?.turntableConfirmed === true,
    shots,
  };
}

export async function sessionShotsGet(project) {
  const doc = await readSessionDocument(project);
  return shotsGetResponse(resolve(project), doc);
}

export async function sessionShotsConfirm(project) {
  const doc = await readSessionDocument(project);
  const result = confirmTurntable(doc);
  if (!result.ok) return { ok: false, status: result.status };
  await writeSessionDocument(project, result.doc);
  return { ok: true, status: 200, body: shotsGetResponse(resolve(project), result.doc) };
}

export function parseConfirmBody(text) {
  try {
    const payload = JSON.parse(String(text || ""));
    if (payload && payload.action === "confirm") return { ok: true };
    return { ok: false, status: 400 };
  } catch {
    return { ok: false, status: 400 };
  }
}

export function normalizeRole(value) {
  return value === "turntable" || value === "shot" || value === "edit" ? value : "";
}

function stripAt(value) {
  let s = typeof value === "string" ? value.trim() : "";
  s = s.replace(/^@/, "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s;
}

export function refsFromArgs(args, cwd) {
  const raw = [];
  const image = stripAt(args?.image);
  if (image) raw.push(image);
  if (Array.isArray(args?.images)) {
    for (const item of args.images) {
      const s = stripAt(String(item));
      if (s) raw.push(s);
    }
  }
  const first = stripAt(args?.first_frame);
  if (first) raw.push(first);
  if (Array.isArray(args?.reference_images)) {
    for (const item of args.reference_images) {
      const s = stripAt(String(item));
      if (s) raw.push(s);
    }
  }
  const out = [];
  for (const src of raw) {
    if (/^https?:\/\//i.test(src) || /^data:/i.test(src)) continue;
    const rel = relFromAbs(cwd, resolve(cwd, src));
    out.push(rel === null ? src.replace(/\\/g, "/") : rel);
  }
  return out;
}

export function buildShotEntry(cwd, args, result, now) {
  const role = normalizeRole(args?.role);
  if (role === "") return null;
  const files = Array.isArray(result?.files) ? result.files : [];
  const saved = files.find((f) => f && typeof f.path === "string" && f.path !== "");
  if (!saved) return null;
  const relPath = relFromAbs(cwd, saved.path);
  if (relPath === null) return null;
  let shotId = typeof args?.shot_id === "string" ? args.shot_id.trim() : "";
  if (role === "turntable") shotId = "_turntable";
  if (shotId === "") return null;
  return {
    role,
    shotId,
    relPath,
    refs: refsFromArgs(args, cwd),
    prompt: typeof args?.prompt === "string" ? args.prompt : "",
    size: typeof args?.size === "string" ? args.size : "",
    now,
  };
}

export async function recordGeneration(cwd, args, result) {
  try {
    const entry = buildShotEntry(cwd, args, result, Date.now());
    if (!entry) return {};
    const doc = applyRecordShot(await readSessionDocument(cwd), entry);
    await writeSessionDocument(cwd, doc);
    return { role: entry.role, shot_id: entry.shotId, roundId: doc.roundId };
  } catch {
    return {};
  }
}
