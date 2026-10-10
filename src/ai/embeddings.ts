import { createHash } from "node:crypto";
import type { GoogleGenAI } from "@google/genai";
import { JsonFile } from "../store.js";

const DIMENSIONS = 768;
const BATCH = 50;

interface Cache {
  model: string;
  /** sha1(text) -> base64 Float32Array, already normalised. */
  vectors: Record<string, string>;
}

/** Gemini text embeddings with an on-disk cache, so unchanged documents are never embedded twice. */
export class Embedder {
  private readonly cache: JsonFile<Cache>;

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly model: string,
    cacheFile: string,
  ) {
    this.cache = new JsonFile<Cache>(cacheFile, { model, vectors: {} });
  }

  async load(): Promise<void> {
    await this.cache.load();
    // Vectors from different models are not comparable.
    if (this.cache.data.model !== this.model) this.cache.data = { model: this.model, vectors: {} };
  }

  /**
   * Embeds documents, reusing cached vectors. A text whose embedding failed gets `null`
   * (it stays searchable by keyword and is retried on the next call).
   */
  async embedDocuments(texts: string[]): Promise<(Float32Array | null)[]> {
    const { vectors } = this.cache.data;
    const keys = texts.map(hash);
    const missing = [...new Set(keys.filter((key) => !vectors[key]))];
    const textByKey = new Map(keys.map((key, index) => [key, texts[index]!]));

    for (let start = 0; start < missing.length; start += BATCH) {
      const batch = missing.slice(start, start + BATCH);
      try {
        const embedded = await this.request(batch.map((key) => textByKey.get(key)!), "RETRIEVAL_DOCUMENT");
        batch.forEach((key, index) => (vectors[key] = encode(embedded[index]!)));
      } catch (error) {
        console.error(`[embeddings] failed, ${missing.length - start} chunks left keyword-only:`, message(error));
        break;
      }
    }

    // Drop vectors of chunks that no longer exist.
    const live = new Set(keys);
    for (const key of Object.keys(vectors)) if (!live.has(key)) delete vectors[key];
    if (missing.length) await this.cache.save();

    return keys.map((key) => (vectors[key] ? decode(vectors[key]) : null));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return (await this.request([text], "RETRIEVAL_QUERY"))[0]!;
  }

  private async request(texts: string[], taskType: string): Promise<Float32Array[]> {
    const response = await this.ai.models.embedContent({
      model: this.model,
      contents: texts,
      // Search falls back to keywords on failure, so do not let a hung request hold up an answer.
      config: { taskType, outputDimensionality: DIMENSIONS, abortSignal: AbortSignal.timeout(20_000) },
    });
    const embeddings = response.embeddings ?? [];
    if (embeddings.length !== texts.length) throw new Error(`expected ${texts.length} embeddings, got ${embeddings.length}`);
    return embeddings.map((embedding) => normalise(Float32Array.from(embedding.values ?? [])));
  }
}

/** Dot product; equals cosine similarity because stored vectors are normalised. */
export function similarity(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

function normalise(vector: Float32Array): Float32Array {
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

const hash = (text: string) => createHash("sha1").update(text).digest("hex");
const encode = (vector: Float32Array) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");

function decode(base64: string): Float32Array {
  // Copy first: a pooled Buffer's offset is not guaranteed to be 4-byte aligned.
  return new Float32Array(new Uint8Array(Buffer.from(base64, "base64")).buffer);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
