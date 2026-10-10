import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { TokenSource } from "../google/auth.js";
import { JsonFile } from "../store.js";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
}

interface ManifestEntry {
  /** Path inside the mirror folder. */
  path: string;
  modifiedTime: string;
}

const FOLDER = "application/vnd.google-apps.folder";
/** Google-native files have no bytes of their own; they are exported to a format we can read. */
const EXPORTS: Record<string, { mimeType: string; extension: string }> = {
  "application/vnd.google-apps.document": { mimeType: "text/plain", extension: ".txt" },
  "application/vnd.google-apps.presentation": { mimeType: "text/plain", extension: ".txt" },
  "application/vnd.google-apps.spreadsheet": {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
  },
};
/** Uploaded file types the knowledge base can index. */
const READABLE = new Set([".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md"]);
const MAX_BYTES = 30_000_000;
const MAX_DEPTH = 6;

/**
 * Mirrors Google Drive folders (and single files) into a local folder, which the knowledge base
 * then indexes like any other. Only new or changed files are downloaded; files removed from
 * Drive are removed from the mirror.
 */
export class DriveSync {
  private readonly manifest: JsonFile<Record<string, ManifestEntry>>;
  private loaded = false;

  constructor(
    private readonly auth: TokenSource,
    /** Folder or file ids, or their Drive URLs. */
    private readonly sources: string[],
    /** Local mirror folder. */
    readonly dir: string,
    private readonly apiUrl = "https://www.googleapis.com/drive/v3",
  ) {
    this.manifest = new JsonFile(join(dir, ".manifest.json"), {});
  }

  /** Brings the mirror up to date. Throws on auth or network failure, leaving the mirror as it was. */
  async sync(): Promise<string> {
    if (!this.loaded) {
      await mkdir(this.dir, { recursive: true });
      await this.manifest.load();
      this.loaded = true;
    }

    // Walk first, so a failure half-way cannot be mistaken for "these files were deleted".
    const found = new Map<string, { file: DriveFile; path: string }>();
    for (const source of this.sources) {
      const root = await this.api<DriveFile>(`/files/${driveId(source)}`, { fields: "id,name,mimeType,modifiedTime,size" });
      if (root.mimeType === FOLDER) await this.walk(root.id, "", found, 0);
      else this.add(root, "", found);
    }

    let downloaded = 0;
    for (const [id, { file, path }] of found) {
      const known = this.manifest.data[id];
      if (known && known.path === path && known.modifiedTime === file.modifiedTime) continue;
      try {
        if (known && known.path !== path) await rm(join(this.dir, known.path), { force: true });
        await this.download(file, join(this.dir, path));
        this.manifest.data[id] = { path, modifiedTime: file.modifiedTime ?? "" };
        downloaded++;
      } catch (error) {
        console.error(`[drive] cannot download "${file.name}":`, error instanceof Error ? error.message : error);
      }
    }

    let removed = 0;
    for (const [id, entry] of Object.entries(this.manifest.data)) {
      if (found.has(id)) continue;
      await rm(join(this.dir, entry.path), { force: true });
      delete this.manifest.data[id];
      removed++;
    }
    if (downloaded || removed) await this.manifest.save();

    const summary = `${found.size} file trên Drive (${downloaded} tải mới, ${removed} gỡ bỏ)`;
    console.log(`[drive] ${summary}`);
    return summary;
  }

  private async walk(folderId: string, prefix: string, found: Map<string, { file: DriveFile; path: string }>, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let pageToken: string | undefined;
    do {
      const page = await this.api<{ files?: DriveFile[]; nextPageToken?: string }>("/files", {
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
        pageSize: "200",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const file of page.files ?? []) {
        if (file.mimeType === FOLDER) await this.walk(file.id, `${prefix}${safeName(file.name)}/`, found, depth + 1);
        else this.add(file, prefix, found);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  private add(file: DriveFile, prefix: string, found: Map<string, { file: DriveFile; path: string }>): void {
    const exported = EXPORTS[file.mimeType];
    const extension = exported?.extension ?? extname(file.name).toLowerCase();
    if (!exported && !READABLE.has(extension)) return;
    if (Number(file.size ?? 0) > MAX_BYTES) return void console.warn(`[drive] skipped "${file.name}": larger than ${MAX_BYTES / 1e6} MB`);

    const base = safeName(exported ? file.name : file.name.slice(0, file.name.length - extension.length));
    let path = `${prefix}${base}${extension}`;
    // Drive allows two files with one name in a folder; the local disk does not.
    const taken = [...found.values()].some((other) => other.path.toLowerCase() === path.toLowerCase());
    if (taken) path = `${prefix}${base} (${file.id.slice(0, 6)})${extension}`;
    found.set(file.id, { file, path });
  }

  private async download(file: DriveFile, target: string): Promise<void> {
    const exported = EXPORTS[file.mimeType];
    const response = await this.request(
      exported ? `/files/${file.id}/export` : `/files/${file.id}`,
      exported ? { mimeType: exported.mimeType } : { alt: "media", supportsAllDrives: "true" },
      120_000,
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
  }

  private async api<T>(path: string, query: Record<string, string>): Promise<T> {
    return (await this.request(path, { supportsAllDrives: "true", ...query }, 30_000)).json() as Promise<T>;
  }

  private async request(path: string, query: Record<string, string>, timeoutMs: number): Promise<Response> {
    const response = await fetch(`${this.apiUrl}${path}?${new URLSearchParams(query)}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${await this.auth.accessToken()}` },
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`Drive API ${response.status} for ${path}: ${detail}`);
    }
    return response;
  }
}

/** Accepts a bare id or any Drive / Docs URL containing one. */
export function driveId(source: string): string {
  return /\/folders\/([\w-]+)/.exec(source)?.[1] ?? /\/d\/([\w-]+)/.exec(source)?.[1] ?? /[?&]id=([\w-]+)/.exec(source)?.[1] ?? source.trim();
}

/** Drive names may hold characters a Windows path cannot. */
function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim() || "untitled";
}
