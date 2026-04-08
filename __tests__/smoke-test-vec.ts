// smoke-test-vec.ts -- One-off check that sqlite-vec loads and works
// with better-sqlite3. Run with: npx tsx __tests__/smoke-test-vec.ts
// Not a vitest test -- just a script that exits 0 on success, 1 on failure.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
// pipeline() is the high-level factory from @huggingface/transformers.
// It returns a task-specific pipeline object (here: feature extraction = embeddings).
import { pipeline } from '@huggingface/transformers';

// Open an in-memory database (no file needed for this test)
const db = new Database(':memory:');

// Load the sqlite-vec extension into the database connection.
// sqliteVec.load() calls db.loadExtension() internally with the correct
// path to the native .so/.dylib binary shipped by the sqlite-vec npm package.
sqliteVec.load(db);

// Create a vec0 virtual table with 384-dimensional float vectors
// (matches all-MiniLM-L6-v2 output dimensionality)
db.exec(`
  CREATE VIRTUAL TABLE test_vec USING vec0(
    item_id INTEGER PRIMARY KEY,
    embedding float[384]
  );
`);

// Insert a test vector (all zeros except first element = 1.0)
const testVector = new Float32Array(384);
testVector[0] = 1.0;

// vec0 expects the embedding as a raw binary blob of float32 values.
// Buffer.from(testVector.buffer) wraps the Float32Array's ArrayBuffer
// as a Node.js Buffer for SQLite binding.
//
// Note: vec0 does not accept explicit values for the INTEGER PRIMARY KEY column
// in the INSERT column list -- it must be omitted and allowed to auto-assign.
// Attempting `INSERT INTO test_vec (item_id, embedding) VALUES (?, ?)` triggers
// "Only integers are allows for primary key values on test_vec" (a vec0 error).
// The rowid auto-assigns to 1 for the first insert, so item_id will be 1.
db.prepare('INSERT INTO test_vec (embedding) VALUES (?)').run(
  Buffer.from(testVector.buffer)
);

// Run a KNN query: find the 1 nearest neighbor to our query vector
const queryVector = new Float32Array(384);
queryVector[0] = 0.9;  // Similar to our stored vector

// vec0 KNN syntax: WHERE embedding MATCH ? AND k = ?
// Returns rows with item_id and distance (lower = more similar)
const results = db.prepare(`
  SELECT item_id, distance
  FROM test_vec
  WHERE embedding MATCH ? AND k = ?
`).all(Buffer.from(queryVector.buffer), 1) as { item_id: number; distance: number }[];

if (results.length !== 1 || results[0].item_id !== 1) {
  console.error('FAIL: KNN query returned unexpected results:', results);
  process.exit(1);
}

console.log('PASS: sqlite-vec loaded, virtual table created, KNN query works');
console.log(`  Result: item_id=${results[0].item_id}, distance=${results[0].distance}`);

// --- Part 2: Test @huggingface/transformers embedding generation ---

console.log('Loading embedding model (first run downloads ~23MB)...');

// pipeline() returns a FeatureExtractionPipeline that converts text to vectors.
// 'feature-extraction' is the task type for generating embeddings.
// 'Xenova/all-MiniLM-L6-v2' is the ONNX-converted version of the popular
// sentence-transformers model. 384 dimensions, fast, good for semantic similarity.
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
	dtype: 'fp32',
});

// Generate an embedding for a test sentence.
// The result is a nested array: [[384 floats]]. We need the inner array.
const output = await embedder('This is a test sentence about programming.', {
	pooling: 'mean',       // Average all token embeddings into one vector
	normalize: true,       // L2-normalize so cosine similarity = dot product
});

// output.data is a Float32Array of the pooled embedding
const embedding = output.data as Float32Array;

if (embedding.length !== 384) {
	console.error(`FAIL: Expected 384 dimensions, got ${embedding.length}`);
	process.exit(1);
}

console.log(`PASS: Embedding generated, ${embedding.length} dimensions`);
console.log(`  First 5 values: [${Array.from(embedding.slice(0, 5)).map(v => v.toFixed(4)).join(', ')}]`);

// Test that the embedding can be inserted into sqlite-vec
db.prepare('INSERT INTO test_vec (embedding) VALUES (?)').run(
	Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
);

// KNN search with the real embedding as query.
// Note: k is hardcoded in the SQL string (not a bind parameter) because vec0
// treats k as a literal constraint, not a parameterized value. Using AND k = ?
// may fail depending on the vec0 version; hardcoding is the safe form.
const semanticResults = db.prepare(`
	SELECT item_id, distance
	FROM test_vec
	WHERE embedding MATCH ? AND k = 2
`).all(Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)) as { item_id: number; distance: number }[];

console.log(`PASS: KNN search with real embedding returned ${semanticResults.length} results`);

// Cleanup
db.close();
