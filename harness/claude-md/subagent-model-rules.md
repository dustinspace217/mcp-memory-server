# CLAUDE.md fragment — Subagent Model Rules

Paste this into your `~/Claude/CLAUDE.md` (alongside the Session Protocol). The harness's pre/post-compact and session-end agents dispatch subagents; the rules below set quality floors for those dispatches.

---

## Subagent Model Rules (Important)
These rules override any model selection guidance in skills (including Superpowers).

**Floors — never dispatch a subagent below these models:**
- **Implementation subagents** (writing code): Sonnet minimum. Never use Haiku.
- **Review subagents** (spec compliance, code quality, any review): Opus only.

**Mandatory Opus review of non-Opus code:**
Whenever a Sonnet (or any non-Opus) subagent finishes writing code, the head agent must immediately dispatch an Opus review subagent before proceeding to the next task. This is a lightweight quality gate — read the diff, flag obvious bugs, security issues, missing requirements, or violations of commenting/style rules. Keep the review output under 200 words.

**Skill invocation precedence.** The system prompt's exploratory-questions guidance (2-3 sentences, recommendation + tradeoff) overrides Superpowers' brainstorming-MUST rule when the user is asking an open-ended strategy question rather than committing to build. Brainstorming applies once they've signaled commit-to-build intent.

## Agents
Full agent roster is in system-reminders each session. Custom agents (`silent-failure-hunter`, `adversarial-tester`) in `~/.claude/agents/` — launch as `general-purpose` with their prompt baked in. Per-project CLAUDE.md files highlight which agents are most critical for that project.
