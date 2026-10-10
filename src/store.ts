import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** A small JSON document on disk: load once, mutate `data`, call `save()`. */
export class JsonFile<T> {
  data: T;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    private readonly path: string,
    initial: T,
  ) {
    this.data = initial;
  }

  /** A missing file keeps the initial value; a corrupt one throws rather than being overwritten later. */
  async load(): Promise<this> {
    const json = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (json !== null) this.data = JSON.parse(json) as T;
    return this;
  }

  /** Writes are serialised and coalesced, and go through a temp file so a crash cannot truncate the store. */
  save(): Promise<void> {
    if (this.dirty) return this.writing;
    this.dirty = true;
    this.writing = this.writing.then(async () => {
      this.dirty = false;
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      await writeFile(temp, JSON.stringify(this.data));
      await rename(temp, this.path);
    });
    this.writing = this.writing.catch((error) => console.error(`[store] cannot write ${this.path}:`, error));
    return this.writing;
  }
}
