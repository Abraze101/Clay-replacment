# Codex project instructions

Before planning or changing code, read `CLAUDE.md` and every project document it lists. The operating rules in `CLAUDE.md` are project-wide rules despite the filename.

Additional Codex requirements:

- Work on one implementation milestone at a time and report exact validation results.
- Keep the engine independent from Codex, Claude, and any individual model provider.
- Treat the CLI and MCP server as adapters over the same application services.
- Implement MCP through stdio for local use and Streamable HTTP for remote use; do not implement legacy SSE.
- Keep tool schemas strict and stable. Annotate read-only versus mutating tools and preserve the engine's preview/approval-token gate even when the harness has its own approval UI.
- Do not add a project `.codex/config.toml` entry for the lead engine until the MCP executable and its tested start command exist.
- Never call live lead providers or spend credits during CI or a fake-data milestone.

Start with `docs/implementation-plan.md` and stop at the boundary of the approved milestone.
