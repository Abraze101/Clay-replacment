# Local Claude Code workflow

Claude Code is installed locally at `~/.local/bin/claude`. Use the project wrapper so the global shell `PATH` does not need to change:

```text
./scripts/claude-local
```

`CLAUDE.md` is the shared project memory. Every session reads the same accepted requirements and operating rules from disk.

## Core Build session

Start in the project root:

```text
./scripts/claude-local --name "Core Build" --permission-mode plan
```

Then enter `/core-build`. Review the proposed milestone plan before switching out of plan mode.

## Feature Lab session

Start a separate local session in the same folder:

```text
./scripts/claude-local --name "Feature Lab" --permission-mode plan
```

Then enter `/feature-lab`. This session proposes and documents features without editing application code.

## UI Build session

Plan the UI in a separate session. Do not implement it until the engine contract is stable:

```text
./scripts/claude-local --name "UI Build" --permission-mode plan
```

Then enter `/ui-build`.

When UI implementation begins, use Claude Code's worktree option so it cannot collide with active engine work:

```text
./scripts/claude-local --worktree ui --name "UI Build" --permission-mode plan
```

## Safety rules

- Do not run two editing sessions against the same working tree simultaneously.
- Commit each accepted implementation milestone before starting another.
- Keep feature proposals in `docs/proposals/` until approved.
- Keep provider credentials in the local environment, never in Claude prompts or repository files.
- Use plan mode before any milestone, provider integration, migration, or UI implementation.
