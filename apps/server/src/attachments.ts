import { promises as fs } from "node:fs";
import path from "node:path";
import type { AttachmentMeta } from "@ph/shared";
import { paths } from "./settings.js";
import { exists, randomId, writeFileAtomic } from "./util.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // larger images are attached as files only

/** Uploaded attachments, stored host-side per session under PH_HOME/attachments. */
export class AttachmentStore {
  private dir(sessionId: string) {
    return path.join(paths.home, "attachments", sessionId);
  }

  async save(sessionId: string, a: { name: string; mediaType: string; data: string }): Promise<AttachmentMeta> {
    const buf = Buffer.from(a.data ?? "", "base64");
    if (!buf.length) throw new Error("attachment is empty");
    if (buf.length > MAX_ATTACHMENT_BYTES) throw new Error("attachments are limited to 20 MB");
    // A plain file name only: no paths, no leading dots, nothing the shell or the sandbox could misread.
    const base = path.basename(a.name || "attachment").replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^[.\s]+/, "").slice(0, 120) || "attachment";
    const id = randomId("att_", 6);
    const mediaType = (a.mediaType || "application/octet-stream").toLowerCase();
    const kind = IMAGE_TYPES.has(mediaType) && buf.length <= MAX_IMAGE_BYTES ? "image" : mediaType === "application/pdf" ? "pdf" : "file";
    const meta: AttachmentMeta = { id, name: base, mediaType, size: buf.length, kind, sandboxPath: `/home/agent/attachments/${id.slice(4)}-${base}` };
    await fs.mkdir(this.dir(sessionId), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(this.dir(sessionId), id), buf, { mode: 0o600 });
    await writeFileAtomic(path.join(this.dir(sessionId), `${id}.json`), JSON.stringify(meta), 0o600);
    return meta;
  }

  async get(sessionId: string, id: string): Promise<{ meta: AttachmentMeta; data: Buffer }> {
    if (!/^att_[0-9a-f]+$/.test(id)) throw new Error("bad attachment id");
    const metaFile = path.join(this.dir(sessionId), `${id}.json`);
    if (!(await exists(metaFile))) throw new Error(`attachment ${id} not found`);
    return { meta: JSON.parse(await fs.readFile(metaFile, "utf8")), data: await fs.readFile(path.join(this.dir(sessionId), id)) };
  }

  async removeSession(sessionId: string) {
    await fs.rm(this.dir(sessionId), { recursive: true, force: true });
  }
}
