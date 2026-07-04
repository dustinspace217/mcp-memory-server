// write-jsonl.ts -- test helper: serialize entities/relations to a .jsonl file.
//
// The migration tests used to seed a .jsonl fixture by calling JsonlStore's write
// methods (createEntities/createRelations). JsonlStore was deleted in the v1.6.0
// JSONL-backend retirement, so this helper takes its place: it writes the same
// newline-delimited-JSON shape the old saveGraph produced. The tests still
// exercise the real migration path — SqliteStore.init() reads this fixture via
// jsonl-reader.readJsonlGraph — they just need a way to PRODUCE the fixture, which
// is a handful of JSON.stringify lines and needs no store lifecycle.

import { promises as fs } from 'fs';

/** One entity line. `observations` may be plain strings (legacy) or full objects,
 *  matching what a real .jsonl file could hold. Timestamp/project fields are
 *  optional — omit them to simulate pre-Phase-3/4 files. */
export interface JsonlEntitySpec {
  name: string;
  entityType: string;
  observations: Array<string | Record<string, unknown>>;
  project?: string | null;
  updatedAt?: string;
  createdAt?: string;
}

/** One relation line. Temporal fields are optional (added on read by the parser). */
export interface JsonlRelationSpec {
  from: string;
  to: string;
  relationType: string;
}

/**
 * Writes entities and relations to `filePath` as JSONL, one JSON object per line
 * with a `type` discriminator — the exact format jsonl-reader.readJsonlGraph parses.
 * Undefined optional fields are dropped by JSON.stringify, so omitting project or
 * timestamps produces a line that looks like an older-format file.
 *
 * @param filePath - Absolute path to write the .jsonl fixture to
 * @param entities - Entity lines to write (entities are always written before relations)
 * @param relations - Relation lines to write (default none)
 */
export async function writeJsonlFixture(
  filePath: string,
  entities: JsonlEntitySpec[],
  relations: JsonlRelationSpec[] = [],
): Promise<void> {
  const lines = [
    ...entities.map(e => JSON.stringify({ type: 'entity', ...e })),
    ...relations.map(r => JSON.stringify({ type: 'relation', ...r })),
  ];
  await fs.writeFile(filePath, lines.join('\n') + '\n');
}
