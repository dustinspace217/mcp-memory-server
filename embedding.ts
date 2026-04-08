// embedding.ts -- Embedding pipeline wrapper for vector search.
// Manages the lifecycle of the @huggingface/transformers model:
// loading -> ready -> failed state machine. Provides embed() and
// embedBatch() methods that check state before attempting inference.
// Used by SqliteStore for generating observation embeddings.

// FeatureExtractionPipeline is the type returned by pipeline('feature-extraction', ...).
// It takes text in, returns float vectors out.
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

/** The embedding model: all-MiniLM-L6-v2 converted to ONNX format.
 * 384 dimensions, ~23MB download. Cached locally after first use.
 * 'Xenova/' prefix means the ONNX-converted version on Hugging Face. */
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

/** Dimensionality of the embedding vectors. Must match the vec0 table definition. */
export const EMBEDDING_DIM = 384;

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
      const pipe = await pipeline('feature-extraction', MODEL_NAME, {
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
   * @param text - The observation content to embed
   * @returns Float32Array of EMBEDDING_DIM length, or null if unavailable
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (this._state.status !== 'ready') return null;

    try {
      // pipeline(text, options) runs the ONNX model on the input text.
      // pooling: 'mean' averages all token embeddings into one vector.
      // normalize: true L2-normalizes so cosine similarity = dot product.
      const output = await this._state.pipeline(text, {
        pooling: 'mean',
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
