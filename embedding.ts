// embedding.ts -- Embedding pipeline wrapper for vector search.
// Manages the lifecycle of the @huggingface/transformers model:
// loading -> ready -> failed state machine. Provides embed() and
// embedBatch() methods that check state before attempting inference.
// Used by SqliteStore for generating observation embeddings.

// FeatureExtractionPipeline is the type returned by pipeline('feature-extraction', ...).
// It takes text in, returns float vectors out.
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

/** The HISTORICAL default embedding model: all-MiniLM-L6-v2 converted to ONNX.
 * 384 dimensions, ~23MB download, cached locally after first use. 'Xenova/'
 * prefix means the ONNX-converted version on Hugging Face. Exported separately
 * from EMBED_MODEL because the v15 vec_config migration seeds with THIS name —
 * every pre-v15 vector was written by MiniLM, so seeding the configured model
 * would let a simultaneous model switch slip past the mismatch guard. */
export const DEFAULT_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** The ACTIVE embedding model, env-overridable (Phase G1). Switching models is
 * a config flip: on startup the store compares this against vec_config's
 * recorded model and clears vec_observations on mismatch (self-healing
 * re-embed via the background sweep) — a mixed-model index is never possible.
 * Any candidate must be a transformers.js-loadable ONNX model with
 * EMBEDDING_DIM-dimensional output (the vec0 schema is fixed at 384). */
export const EMBED_MODEL = process.env.MEMORY_EMBED_MODEL || DEFAULT_EMBED_MODEL;

/** Pooling strategy, env-overridable. MiniLM wants 'mean'; bge-family models
 * want 'cls' — the 2026-06-20 fidelity check proved a mean/cls mismatch is a
 * SILENT ~4% cosine drift, not an error, so this must switch WITH the model. */
export const EMBED_POOLING: 'mean' | 'cls' =
  process.env.MEMORY_EMBED_POOLING === 'cls' ? 'cls' : 'mean';
// A typo'd value ('CLS', 'Mean') silently mapping to 'mean' would reproduce
// the exact silent ~4% drift this knob exists to prevent — warn loudly
// (cross-exam #87). Startup-time check, stderr only.
if (process.env.MEMORY_EMBED_POOLING && !['mean', 'cls'].includes(process.env.MEMORY_EMBED_POOLING)) {
  console.error(`WARNING: MEMORY_EMBED_POOLING='${process.env.MEMORY_EMBED_POOLING}' is not 'mean' or 'cls' — falling back to 'mean'. A pooling/model mismatch is a SILENT cosine drift, not an error; fix the env value.`);
}

/** Query-side instruction prefix, env-overridable (default: none, correct for
 * MiniLM's symmetric embedding). Retrieval-specialized models are ASYMMETRIC:
 * arctic-embed wants "Represent this sentence for searching relevant
 * passages: " on QUERIES only — the 2026-06-20 Phase 2b control showed that
 * omitting it turns a dead-heat model into an apparent loser. */
const QUERY_PREFIX = process.env.MEMORY_EMBED_QUERY_PREFIX ?? '';

/** Which side of retrieval a text is on. Stored observations are 'passage';
 * search/precedent queries are 'query'. Dedup comparisons are passage-to-
 * passage (both sides are stored-observation-shaped text). */
export type EmbedKind = 'query' | 'passage';

/**
 * Applies the query-side instruction prefix when (and only when) embedding a
 * query with a non-empty configured prefix. Pure — the prefix parameter
 * defaults to the env-resolved value but is injectable for tests (env is baked
 * at module load, so tests can't vary it after import).
 */
export function prefixedInput(text: string, kind: EmbedKind, prefix: string = QUERY_PREFIX): string {
  return kind === 'query' && prefix ? prefix + text : text;
}

/** Dimensionality of the embedding vectors. Must match the vec0 table definition. */
export const EMBEDDING_DIM = 384;

/**
 * Parses a cosine-threshold env override: a finite number in [0, 1], else the
 * default with a loud stderr warning. Same typo-guard rationale as
 * EMBED_POOLING above — a silently-ignored garbage value would leave the
 * server running MiniLM-tuned gates against a different model's geometry.
 */
function thresholdFromEnv(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    console.error(`WARNING: ${envName}='${raw}' is not a number in [0,1] — falling back to ${fallback}. Thresholds are model-geometry-coupled; fix the env value.`);
    return fallback;
  }
  return n;
}

/**
 * Cosine-similarity gates, env-overridable BECAUSE they are model-geometry-
 * coupled: every embedding model distributes cosines differently (granite-r2's
 * random-pair median is ~0.77 where MiniLM's is ~0.11 — recalibration run
 * 2026-07-02, scripts/recalibrate-thresholds.py), so a model switch that
 * doesn't move these gates silently breaks dedup and the precedent floor.
 * They live HERE, next to the model/pooling/prefix envs, so the whole
 * geometry moves as one unit in the MCP registration; the defaults remain the
 * historical MiniLM-tuned values (deployments that don't set MEMORY_EMBED_MODEL
 * keep byte-identical behavior, and rollback = drop the env block).
 * Deviation from plan Task G3's "apply via the constants": editing the
 * constants while DEFAULT_EMBED_MODEL stays MiniLM would run MiniLM deployments
 * (including the test suite) on another model's thresholds.
 */
export const SIMILAR_THRESHOLD = thresholdFromEnv('MEMORY_SIMILAR_THRESHOLD', 0.85);   // addObservations similarExisting warning
export const DUPLICATE_THRESHOLD = thresholdFromEnv('MEMORY_DUPLICATE_THRESHOLD', 0.80); // check_duplicates advisory match
export const PRECEDENT_FLOOR = thresholdFromEnv('MEMORY_PRECEDENT_FLOOR', 0.25);      // find_precedents minSimilarity default

/** Maximum consecutive pipeline failures before transitioning to 'failed' state.
 * After this many failures, the pipeline stops attempting inference until restart. */
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * State machine for the embedding model lifecycle.
 * - 'loading': model download/init in progress
 * - 'ready': model loaded, pipeline available for inference
 * - 'failed': model failed to load or too many runtime failures
 * - 'unavailable': sqlite-vec extension not loaded or MEMORY_VECTOR_SEARCH=off
 */
export type VectorState =
  | { status: 'loading' }
  | { status: 'ready'; pipeline: FeatureExtractionPipeline }
  | { status: 'failed'; error: Error; failedAt: string }
  | { status: 'unavailable' };

/**
 * Manages the embedding model lifecycle and provides methods to generate embeddings.
 * Create one instance per SqliteStore. Call startLoading() after store.init().
 * Check state before calling embed/embedBatch -- they return null if not ready.
 */
export class EmbeddingPipeline {
  /** Current state of the model lifecycle */
  private _state: VectorState = { status: 'unavailable' };

  /** Counter for consecutive runtime failures. Resets on success. */
  private consecutiveFailures = 0;

  /** Returns the current state (read-only for callers to inspect) */
  get state(): VectorState {
    return this._state;
  }

  /**
   * Begins loading the embedding model in the background.
   * Transitions: unavailable -> loading -> ready | failed.
   * Does NOT block -- returns immediately.
   * Calls onReady callback when the model is loaded so the store
   * can trigger the embedding sweep.
   *
   * @param onReady - Callback invoked when model transitions to 'ready'
   */
  startLoading(onReady?: () => void): void {
    this._state = { status: 'loading' };
    console.error('Embedding model: loading...');

    // Dynamic import because @huggingface/transformers is ESM-only
    // and we want to avoid loading the heavy ONNX runtime if vector search
    // is disabled. import() returns a Promise -- we handle it async below.
    import('@huggingface/transformers').then(async ({ pipeline }) => {
      // pipeline() downloads the model on first run (~23MB), then caches it.
      // 'feature-extraction' is the task for generating dense vector embeddings.
      const pipe = await pipeline('feature-extraction', EMBED_MODEL, {
        dtype: 'fp32',
      });

      this._state = { status: 'ready', pipeline: pipe };
      this.consecutiveFailures = 0;
      console.error('Embedding model: ready');

      if (onReady) onReady();
    }).catch((err: unknown) => {
      // .catch() receives unknown at runtime — the Error annotation was incorrect.
      // Dynamic import() or pipeline() rejections are typically Errors, but
      // this handles any rejection value safely.
      const error = err instanceof Error ? err : new Error(String(err));
      this._state = { status: 'failed', error, failedAt: new Date().toISOString() };
      console.error(`Embedding model: failed to load: ${error.message}`);
      console.error('Vector search disabled. LIKE search remains functional.');
    });
  }

  /**
   * Generates a single embedding vector from text.
   * Returns null if the model isn't ready (loading, failed, unavailable).
   * Wraps pipeline() in try-catch so a runtime failure doesn't crash the caller.
   *
   * @param text - The text to embed
   * @param kind - 'passage' (default — stored observations, dedup comparisons)
   *   or 'query' (search/precedent lookups). Only queries receive the
   *   configured instruction prefix; with the MiniLM default (no prefix) the
   *   two kinds are identical.
   * @returns Float32Array of EMBEDDING_DIM length, or null if unavailable
   */
  async embed(text: string, kind: EmbedKind = 'passage'): Promise<Float32Array | null> {
    if (this._state.status !== 'ready') return null;

    try {
      // pipeline(text, options) runs the ONNX model on the input text.
      // pooling: env-resolved ('mean' for MiniLM; 'cls' for bge-family — a
      // mismatch is a silent ~4% cosine drift, so it switches WITH the model).
      // normalize: true L2-normalizes so cosine similarity = dot product.
      const output = await this._state.pipeline(prefixedInput(text, kind), {
        pooling: EMBED_POOLING,
        normalize: true,
      });

      this.consecutiveFailures = 0;
      // output.data is the raw Float32Array of the embedding
      return output.data as Float32Array;
    } catch (err: unknown) {
      this.consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Embedding failed for text (${text.slice(0, 50)}...): ${msg}`);

      // Circuit breaker: after too many consecutive failures, stop trying
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this._state = {
          status: 'failed',
          error: err instanceof Error ? err : new Error(msg),
          failedAt: new Date().toISOString(),
        };
        console.error(`Embedding model: transitioned to 'failed' after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
      }

      return null;
    }
  }

  /**
   * Generates embeddings for multiple texts. Processes sequentially (not batched
   * at the ONNX level) because all-MiniLM-L6-v2 doesn't benefit much from
   * batching in ONNX runtime and sequential gives us per-item error isolation.
   *
   * @param texts - Array of { id, content } pairs to embed
   * @returns Array of { id, embedding } for successful embeddings (failures skipped)
   */
  async embedBatch(
    texts: Array<{ id: number; content: string }>
  ): Promise<Array<{ id: number; embedding: Float32Array }>> {
    const results: Array<{ id: number; embedding: Float32Array }> = [];

    for (const { id, content } of texts) {
      // If the circuit breaker tripped mid-batch, stop iterating —
      // embed() would return null for every remaining item anyway
      if (this._state.status !== 'ready') break;

      const embedding = await this.embed(content);
      if (embedding) {
        results.push({ id, embedding });
      }
    }

    return results;
  }
}
