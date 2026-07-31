#!/usr/bin/env python3
"""
Shared substrate for the 3D semantic-layout graph AND the NN link suggester.

Computes one embedding vector per ACTIVE entity from the per-observation MiniLM
vectors the memory server already stores. Pure standard library — it reads the
sqlite-vec *shadow* tables directly (the `vec_observations` virtual table itself
needs the `vec0` extension, which stdlib sqlite3 can't load, but the shadow tables
that back it are plain SQLite). Verified 2026-07-31 against ~/.claude/memory.db.

How the vectors are stored (sqlite-vec internals, re-probed 2026-07-31 after a
server-side schema change — the vec table is now declared
`vec0(embedding float[384], +observation_id TEXT NOT NULL)`):
  - `vec_observations_rowids(rowid, id, chunk_id, chunk_offset)`
        `rowid`         = AUTO-ASSIGNED by sqlite-vec (observed 627250+; it is NOT
                          the observation rowid — that old invariant died with the
                          schema change; `id` is still NULL for every row)
        `chunk_id`      = which vector chunk holds this observation's vector
        `chunk_offset`  = the slot index within that chunk
  - `vec_observations_auxiliary(rowid, value00)`
        `rowid`   = the vec row's rowid (shared with the rowids table — the join key)
        `value00` = the `+observation_id` aux column: the observation's id as TEXT
                    ("1", "2", …). sqlite-vec stores `+`-prefixed aux columns here.
  - `vec_observations_vector_chunks00(rowid, vectors)`
        `rowid`   = chunk_id
        `vectors` = one contiguous blob of float32, DIM floats per slot,
                    up to 1024 slots per chunk (1024*384*4 = 1,572,864 bytes)
  - Each stored vector is ALREADY L2-normalized (re-probed 2026-07-31 under the new
    schema: norm == 1.000000), so cosine similarity is just the dot product.
  - LEGACY layout (pre-2026-07 server, e.g. old backup DBs): no aux table; the vec
    table's own rowid WAS the observation rowid. _load_observation_vectors keeps a
    fallback for that layout.

Entity vector = L2-normalized MEAN of that entity's active observations' vectors.
At ~450 entities / ~4,300 embedded observations this is trivial in pure Python,
which keeps generate.py dependency-free and offline (its design constraint).
"""
import math
import sqlite3
import struct
from pathlib import Path

# Canonical memory DB location (same path the load hooks read).
DB_PATH = Path.home() / ".claude" / "memory.db"

# MiniLM-L6-v2 embedding dimensionality. A module constant, not a magic number,
# because every blob offset below is computed from it.
DIM = 384
# Bytes per stored vector: DIM float32 values.
VEC_BYTES = DIM * 4


def _load_observation_vectors(conn):
    """
    Read every per-observation vector out of the shadow tables.

    Returns: dict mapping observation_rowid -> tuple(float * DIM).

    `conn` is an open read-only sqlite3 connection (passed in from the caller so the
    connection lifetime is managed in one place). Each vector chunk blob is fetched
    at most once and cached, so we never re-read the same ~1.5 MB blob per slot.
    """
    cur = conn.cursor()
    # (observation rowid, chunk id, slot offset) for every embedded observation.
    #
    # HOW the observation id is found (schema changed server-side, probed 2026-07-31):
    # the vec table is now declared `vec0(embedding float[384], +observation_id TEXT)`.
    # sqlite-vec stores `+`-prefixed auxiliary columns in vec_observations_auxiliary
    # (value00 = first aux column), and the vec rowids are auto-assigned — they no
    # longer equal the observation rowid (probed: vec rowids 627250+, obs rowids
    # 1..8694, ranges don't even overlap). So the observation id must come from the
    # aux table, joined on the shadow tables' shared rowid.
    #
    # The pre-2026-07 server stored each observation's rowid AS the vec table's own
    # rowid (no aux column at all). We keep that as a fallback so `--db` pointed at
    # an older backup still renders, chosen only when the aux path yields nothing.
    try:
        slots = cur.execute(
            """
            SELECT CAST(a.value00 AS INTEGER), r.chunk_id, r.chunk_offset
            FROM vec_observations_rowids r
            JOIN vec_observations_auxiliary a ON a.rowid = r.rowid
            """
        ).fetchall()
    except sqlite3.OperationalError:
        # Usually "no such table" on a legacy DB — but OperationalError is broader
        # than that (a renamed aux column or a transient error lands here too), so
        # this branch ASSUMES legacy rather than proving it. If the fallback below
        # ever runs against a new-schema DB, the disjoint rowid ranges make the
        # result empty, not wrong — the symptom is 0 entities with vectors
        # (run verify_entity_vectors.py to check after any server upgrade).
        slots = []
    if not slots:
        # Legacy schema: the vec rowid IS the observation rowid.
        slots = cur.execute(
            "SELECT rowid, chunk_id, chunk_offset FROM vec_observations_rowids"
        ).fetchall()

    # chunk_id -> the chunk's raw float32 blob. Populated lazily.
    chunk_cache = {}

    def chunk_blob(chunk_id):
        # Fetch-once-per-chunk: the blob holds up to 1024 vectors, so caching it
        # turns N per-slot reads into one read per chunk.
        if chunk_id not in chunk_cache:
            row = cur.execute(
                "SELECT vectors FROM vec_observations_vector_chunks00 WHERE rowid = ?",
                (chunk_id,),
            ).fetchone()
            chunk_cache[chunk_id] = row[0] if row else b""
        return chunk_cache[chunk_id]

    vectors = {}
    for obs_rowid, chunk_id, offset in slots:
        blob = chunk_blob(chunk_id)
        base = offset * VEC_BYTES
        # Guard against a short/truncated chunk: skip rather than unpack past the end.
        if base + VEC_BYTES > len(blob):
            continue
        # struct.unpack_from reads DIM little-endian float32s starting at `base`.
        # Note: with auto-assigned vec rowids, two vec rows COULD carry the same
        # observation_id (e.g. a server re-embed that doesn't delete the old row).
        # This dict write is last-scan-wins with no ORDER BY guarantee — fine today
        # (ids are unique in practice), flagged so a future re-embed feature knows.
        vectors[obs_rowid] = struct.unpack_from(f"<{DIM}f", blob, base)
    return vectors


def compute_entity_vectors(db_path=DB_PATH):
    """
    Compute {normalized_name: [float * DIM]} — one unit vector per active entity.

    Keyed by normalized_name — the canonical entity identity that relations and the
    graph viewer's nodes key on (display names aren't unique and don't match the edge
    endpoints, e.g. 'mcp-memory-server' normalizes to 'mcpmemoryserver'). An entity's
    vector is the L2-normalized mean of its ACTIVE observations' (already-unit)
    vectors. Entities/observations that are superseded or tombstoned are excluded so
    the geometry reflects only live memory. Entities with no embedded active
    observation are omitted (no vector to place them in space).

    Returns a plain dict of Python lists so the caller (generate.py) can embed it as
    JSON in the offline viewer with no numpy/JSON-encoder surprises.
    """
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        obs_vectors = _load_observation_vectors(conn)
        cur = conn.cursor()
        # Active observation rowid -> its entity's normalized_name. Filter both the
        # observation and the entity to active (the "'' OR IS NULL" pattern accepts
        # the current '' sentinel and a hypothetical future NULL, matching the hooks).
        obs_rows = cur.execute(
            """
            SELECT o.rowid, e.normalized_name
            FROM observations o
            JOIN entities e ON o.entity_id = e.id
            WHERE (o.superseded_at IS NULL OR o.superseded_at = '')
              AND (o.tombstoned_at IS NULL OR o.tombstoned_at = '')
              AND (e.superseded_at IS NULL OR e.superseded_at = '')
              AND (e.tombstoned_at IS NULL OR e.tombstoned_at = '')
            """
        ).fetchall()
    finally:
        conn.close()

    # Accumulate a running sum + count per entity. We sum into a fresh list and
    # divide once at the end (one mean per entity) rather than averaging
    # incrementally, which keeps the arithmetic obvious.
    sums = {}    # normalized_name -> [float * DIM] running sum
    counts = {}  # normalized_name -> int
    for obs_rowid, key in obs_rows:
        vec = obs_vectors.get(obs_rowid)
        if vec is None:
            continue  # this observation has no embedded vector (e.g. embedding off)
        if key not in sums:
            sums[key] = list(vec)
            counts[key] = 1
        else:
            running = sums[key]
            for i in range(DIM):
                running[i] += vec[i]
            counts[key] += 1

    result = {}
    for key, running in sums.items():
        n = counts[key]
        mean = [x / n for x in running]
        norm = math.sqrt(sum(x * x for x in mean))
        if norm > 0.0:
            result[key] = [x / norm for x in mean]
    return result


def cosine(a, b):
    """Cosine similarity of two equal-length vectors. For unit vectors this is the
    dot product; we divide by the norms anyway so it's correct for any input."""
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


if __name__ == "__main__":
    ev = compute_entity_vectors()
    print(f"entities with vectors: {len(ev)}")
