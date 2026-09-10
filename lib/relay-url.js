// Relay Base URL helpers. Users paste either `https://host` or `https://host/v1`.
// Paths we join as `/v1/...` must not become `/v1/v1/...`. Other paths
// (`/videos/generations`, `/tasks/submit`) keep a trailing `/v1` if the user
// included one.

export function trimBase(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

export function stripTrailingV1(url) {
  return trimBase(url).replace(/\/v1$/i, "");
}

export function joinRelayPath(base, path) {
  const p = String(path || "");
  const suffix = p.startsWith("/") ? p : `/${p}`;
  const origin = suffix === "/v1" || suffix.startsWith("/v1/") ? stripTrailingV1(base) : trimBase(base);
  return `${origin}${suffix}`;
}
