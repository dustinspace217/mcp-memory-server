#!/usr/bin/env python3
"""
check-memory-noise.py — PostToolUse hook for mcp__memory__add_observations.

Inspects newly added observations for common noise patterns (line numbers,
function signatures, test counts, file inventories, table definitions) and
injects an advisory warning back into the model context. Never blocks writes.

Reads JSON from stdin with shape:
  { "tool_name": "mcp__memory__add_observations",
    "tool_input": { "observations": [{ "entityName": "...", "contents": [...] }] },
    "tool_response": { ... } }

Outputs JSON with hookSpecificOutput.additionalContext if noise detected,
or nothing (empty stdout) if clean.
"""

import json
import re
import sys


# ── Noise patterns ──────────────────────────────────────────────────────
# Each entry: (pattern_name, compiled_regex). Applied to each observation
# content string. A match means the observation is likely derivable from
# grep/read and shouldn't be in memory.

NOISE_PATTERNS = [
    # Line number references: "at line 1064", "line ~300", "(line 42)", "lines 10-20"
    ("line number", re.compile(
        r'\b(?:at |on )?lines?\s*~?\d+(?:\s*[-–]\s*\d+)?', re.IGNORECASE
    )),

    # TypeScript/JS function signatures with typed parameters:
    # "createEntities(entities: EntityInput[], projectId?: string)"
    ("function signature", re.compile(
        r'\w+\([^)]*:\s*(?:string|number|boolean|any|void|Promise|Array|Record|Map|Set|'
        r'z\.(?:string|number|array|object|boolean|enum)|'
        r'\w+(?:Input|Output|Result|Response|Config|Options|Params|Schema|Type))'
    )),

    # Import/require statements: "import X from 'y'", "require('z')"
    ("import statement", re.compile(
        r'^(?:import\s|const\s+\w+\s*=\s*require\(|from\s+[\'"])', re.MULTILINE
    )),

    # Test count snapshots: "520 tests", "4 tests across 9 files"
    ("test count", re.compile(
        r'\b\d+\s+tests?\b(?:\s+(?:across|in|total|passing|failing))?', re.IGNORECASE
    )),

    # File inventory lists: "7 source files: types.ts, cursor.ts, ..."
    ("file inventory", re.compile(
        r'\b\d+\s+(?:source|test|config)?\s*files?\s*:', re.IGNORECASE
    )),

    # Table/column DDL definitions: "Table entities: id INTEGER ..."
    ("table definition", re.compile(
        r'(?:^Table\s+\w+\s*:|'
        r'\b(?:INTEGER|TEXT|REAL|BLOB)\s+(?:PRIMARY\s+KEY|NOT\s+NULL|DEFAULT|UNIQUE|REFERENCES))',
        re.IGNORECASE | re.MULTILINE
    )),

    # SQL column listings: "columns: id, name, entity_type, project, ..."
    ("column listing", re.compile(
        r'\bcolumns?\s*:\s*(?:\w+,\s*){3,}', re.IGNORECASE
    )),

    # Package version snapshots outside decision context:
    # "@1.2.3" or "version 1.2.3" when it's just a fact, not a decision
    ("version snapshot", re.compile(
        r'(?:@\d+\.\d+\.\d+|^version\s+\d+\.\d+\.\d+)', re.IGNORECASE | re.MULTILINE
    )),

    # API input/output schema descriptions:
    # "input { entities: EntityInput[] } -> output { created: Entity[] }"
    ("api schema", re.compile(
        r'(?:input|output)\s*\{[^}]*\}\s*(?:->|→|=>)\s*(?:input|output)\s*\{',
        re.IGNORECASE
    )),
]


def check_observations(tool_input: dict) -> list[dict]:
    """
    Check each observation content string against noise patterns.
    Returns a list of { entityName, content (truncated), patterns } for flagged obs.
    """
    flagged = []
    observations = tool_input.get("observations", [])

    for obs_group in observations:
        entity_name = obs_group.get("entityName", "unknown")
        contents = obs_group.get("contents", [])

        for content in contents:
            if not isinstance(content, str):
                continue

            matched_patterns = []
            for pattern_name, pattern_re in NOISE_PATTERNS:
                if pattern_re.search(content):
                    matched_patterns.append(pattern_name)

            if matched_patterns:
                # Truncate content for the warning message (keep it readable)
                truncated = content[:80] + "..." if len(content) > 80 else content
                flagged.append({
                    "entityName": entity_name,
                    "content": truncated,
                    "patterns": matched_patterns,
                })

    return flagged


def main():
    """Read tool input from stdin, check for noise, output warning if found."""
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as exc:
        # Can't parse input — exit without blocking the hook chain, but log to
        # stderr so format changes don't silently disable the noise guardrail.
        print(f"check-memory-noise.py: failed to parse stdin JSON: {exc}", file=sys.stderr)
        return

    tool_input = data.get("tool_input", {})
    flagged = check_observations(tool_input)

    if not flagged:
        # No noise detected — empty stdout means no hook effect
        return

    # Count total observations to give a ratio
    total_obs = sum(
        len(og.get("contents", []))
        for og in tool_input.get("observations", [])
    )

    # Build the warning message
    details = []
    for item in flagged[:5]:  # Cap at 5 examples to keep the warning concise
        patterns_str = ", ".join(item["patterns"])
        details.append(f'  - [{patterns_str}] "{item["content"]}"')

    warning = (
        f"MEMORY NOISE WARNING: {len(flagged)} of {total_obs} observations match "
        f"noise patterns and may be derivable from grep/read.\n"
        f"The write policy says: don't store what grep can find.\n"
        f"Flagged observations:\n"
        + "\n".join(details)
    )

    if len(flagged) > 5:
        warning += f"\n  ... and {len(flagged) - 5} more."

    warning += (
        "\nConsider superseding these with higher-level architectural summaries, "
        "or not storing them at all."
    )

    # Output the hook response — injects warning as context, never blocks
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": warning,
        }
    }
    json.dump(output, sys.stdout)


if __name__ == "__main__":
    main()
