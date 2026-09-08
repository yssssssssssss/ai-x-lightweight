# ai-x-lightweight

## Agent skills

### Issue tracker

GitHub Issues on `yssssssssssss/ai-x-lightweight` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

### Real LLM development

Before calibrating a feature with real model calls, follow
`docs/agents/real-llm-development-workflow.md`: freeze local contracts and diagnostics first, then run one real single-path and one real second-path smoke.

## Design simplicity (anti-over-engineering)

Over-engineering is the most frequent correction in this workspace. These are
hard defaults and they apply INSIDE the requested scope, not just to adjacent
changes:

- No backward compatibility, migration shims, legacy fallbacks, or old-data
backfill unless the user explicitly asks for them. Assume breaking changes
are acceptable by default.
- Words like 完美 / 长远 / 通用 / 一定不能影响 / "perfect" / "long-term"
describe quality goals, not authorization to platformize. Implement only
what the current stated requirement needs; mention future extensions as
one-line notes in the final message, never as extra code, schemas, tiers,
modes, or config surfaces.
- Do not mechanize judgment: no hardcoded validators, closed error-code sets,
alias tables, or rule engines to enforce what instructions and review
already cover.
- Validate once at the trusted boundary. Do not duplicate the same check
across layers (double probes, dual bookkeeping that must be reconciled).
- Design-size checkpoint: before writing code, if the plan adds a new
abstraction layer, a new config surface, more than ~5 new files, or any
speculative option, present the minimal version and the additions as
separate items and default to the minimal version.
- VibeGuard's error-handling strictness (U-17/U-29) applies to real error
paths inside the requested change; it never justifies adding new
validators, checks, or compatibility layers.
- When the user says something is over-designed: cut it, do not defend it.

## Output handling

- Emit business content and PII directly through Dataset, Tool, Skill, synthesis,
  report, export, and editorial paths; do not mask or block them based on
  sensitivity or redaction policy.
- Continue masking credentials such as API keys, authorization headers, tokens,
  secrets, and passwords.
- Existing redaction metadata fields are inert audit metadata and must not gate
  processing, model egress, rendering, or publication.

## Problem framing and tool choice

- Before the first tool call, identify the exact target, failure direction,and requested access path.
- The user's latest correction overrides earlier assumptions immediately.
- When the user specifies SSH, CLI, API, or another access path, use that path.
Do not substitute UI automation unless the requested path is unavailable.
- Do not use Computer Use, desktop UI automation, screen control, or synthetic
clicks/keystrokes unless the user explicitly requests Computer Use or UI
operation for the current task. The presence of a running desktop app, an
available Computer Use tool, or a potentially useful signed-in session is not
authorization.
- When a task requires opening or operating a browser, use the Ego Lite browser.
Do not launch or use Google Chrome unless the user explicitly overrides this rule
for the current task.
- Diagnose the named system first. Do not inspect or modify adjacent tools merely
because they could plausibly cause the symptom.
- For troubleshooting, establish evidence before mutation. Make one minimal
change, verify the original symptom, then stop when it passes.
- If the target or direction is genuinely ambiguous, ask one short clarification
question before operating external systems.
