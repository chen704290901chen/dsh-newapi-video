import { basename } from "node:path";

// Keep the attachment name safe for HTTP headers while preserving the real
// UTF-8 filename for modern browsers. `basename` and the CR/LF stripping also
// prevent a caller-controlled relative path from becoming a response header.
export function attachmentContentDisposition(filename) {
  const rawName = basename(String(filename || "download")) || "download";
  const name = rawName.replace(/[\x00-\x1f\x7f]/g, "_");
  const fallback =
    name
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\\r\n]/g, "_")
      .slice(0, 180) || "download";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
