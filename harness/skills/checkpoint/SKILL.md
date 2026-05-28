---
name: checkpoint
description: Saves a detailed context snapshot to the memory MCP server right now. Use as /checkpoint at any point during a coding session to lock in current state and prevent hallucination of variable/function/library names in future sessions.
---

Invoke the context-saver agent immediately to save a full checkpoint of the current project state to the memory MCP server.

Save all of the following with exact names copied directly from the code — never paraphrase:
- Project name, purpose, and working directory
- Every file touched: path and what it does
- Every function/method: exact name, file, parameters (exact names and types), return value, purpose
- Every key variable: exact name, what it holds, where defined, where used
- Every library/import: exact package name, version if known, what it is used for
- Every API endpoint or external service: exact URL, method, inputs, outputs
- Any database tables, columns, or schema details
- Any config keys or environment variable names
- Current status: what is done, what is in progress, what is broken, what is next

After saving, confirm what was stored with a brief summary so you can verify the checkpoint is complete.
