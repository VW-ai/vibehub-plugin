// Composer attachments: images pasted from the clipboard, dropped onto the
// Composer or picked with the plus control, and ordinary audio. Every image
// becomes the `image` Turn input with a data: URL (a browser File carries no
// filesystem path, so localImage is never produced) inside the existing
// byte bound; several may travel in one Turn.

import { escapeHtml } from "./chat-renderer.mjs";

export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// The image files a paste or drop carries: clipboardData/dataTransfer files
// first, then file items, image/* only, in the order the browser lists them.
export function imageFilesFrom(transfer) {
  const files = [...(transfer?.files ?? [])];
  if (!files.length) {
    for (const item of transfer?.items ?? []) {
      if (item?.kind !== "file") continue;
      const file = item.getAsFile?.();
      if (file) files.push(file);
    }
  }
  return files.filter((file) => typeof file?.type === "string" && file.type.startsWith("image/"));
}

export function attachmentKind(file) {
  return typeof file?.type === "string" && file.type.startsWith("audio/") ? "audio" : "image";
}

export function attachmentName(file, index = 0) {
  const name = String(file?.name ?? "").trim();
  if (name) return name;
  const kind = attachmentKind(file);
  const extension = String(file?.type ?? "").split("/")[1]?.split(";")[0];
  return kind === "audio" ? "Voice recording" : `Pasted image ${index + 1}${extension ? `.${extension}` : ""}`;
}

// The attachment list with one more entry, or the reason it was refused:
// the count bound and the byte bound are both named, nothing is dropped silently.
export function acceptAttachment(attachments, { file, url, name }, { max = MAX_ATTACHMENTS, maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
  const current = attachments ?? [];
  if (current.length >= max) return { attachments: current, refused: `At most ${max} attachments travel in one Turn; remove one first.` };
  if (Number.isFinite(file?.size) && file.size > maxBytes) return { attachments: current, refused: `${name ?? attachmentName(file)} is larger than the ${Math.round(maxBytes / 1024 / 1024)} MiB attachment limit.` };
  if (typeof url !== "string" || !url.startsWith("data:")) return { attachments: current, refused: "The attachment could not be read as a data URL." };
  return { attachments: [...current, { type: attachmentKind(file), url, name: name ?? attachmentName(file, current.length) }], refused: null };
}

// Removable chips with accessible names; images carry a thumbnail.
export function renderAttachmentChips(attachments) {
  return (attachments ?? []).map((item, index) => {
    const label = `${item.type === "audio" ? "Attached audio" : "Attached image"} ${item.name}`;
    const preview = item.type === "image" && /^data:image\//.test(item.url) ? `<img src="${escapeHtml(item.url)}" alt="">` : `<i aria-hidden="true">${item.type === "audio" ? "◉" : "▧"}</i>`;
    return `<span class="attachment-chip" role="group" data-attachment-index="${index}" data-attachment-type="${escapeHtml(item.type)}" aria-label="${escapeHtml(label)}">${preview}<span>${escapeHtml(item.name)}</span><button type="button" data-remove-attachment="${index}" aria-label="Remove ${escapeHtml(item.name)}">×</button></span>`;
  }).join("");
}
