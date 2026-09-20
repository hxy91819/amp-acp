# AGENTS.md

## Commands
- `bun run build` — Bundle TypeScript to `dist/index.js` (single file, Bun target)
- `bun start` or `bun dist/index.js` — Run the ACP adapter
- `bun run lint` — Type-check with `tsc --noEmit`
- `bun test src/` — Run tests with Bun's built-in test runner

## Architecture
This is an ACP (Agent Client Protocol) adapter that bridges Amp Code to ACP-compatible clients like Zed.

- `src/index.ts` — Entry point, redirects console to stderr (stdout reserved for ACP stream)
- `src/run-acp.ts` — Sets up ACP connection using stdin/stdout JSON streams
- `src/server.ts` — `AmpAcpAgent` class: handles sessions, prompts, MCP config, and calls `@ampcode/sdk` (formerly `@sourcegraph/amp-sdk`)
- `src/amp-modes.ts` — Discovers selectable Amp modes from static plugin metadata, with an explicit trusted CLI-discovery opt-in
- `src/to-acp.ts` — Converts Amp stream events to ACP `sessionUpdate` notifications
- `src/mcp-config.ts` — Converts ACP MCP server configs to Amp SDK format
- `src/utils.ts` — Node-to-Web stream converters

## Code Style
- TypeScript with ES modules (`"type": "module"` in package.json), use `.js` extension in imports
- Strict mode enabled; avoid `any` and type assertions unless necessary
- Use `console.error` for logging (stdout is for ACP protocol only)
- Error handling: throw `RequestError` from `@agentclientprotocol/sdk` for protocol errors
- Naming: camelCase for variables/functions, PascalCase for classes/interfaces

<!-- open-source-fork-maintenance:start -->
## Local aggregate fork maintenance

This checkout is maintained as a non-maintainer fork. Its root workspace is the `local/aggregate` integration branch. It is based on the configured upstream ref and is the only checkout used for local integration, packaging, and experience. After verification, publish it to the personal fork as a reusable source snapshot; never use it for an upstream pull request.

Every product change starts on an independent `feature/*` or `fix/*` branch and worktree. That worktree owns implementation, tests, commits, `$autoreview` closeout, and fork publication. Invoke `$autoreview` there after development is complete; the branch is verified for aggregation only after that review reports no accepted/actionable findings. Publish every completed, verified source branch and the completed aggregate to the personal fork with normal non-forced pushes. The aggregate receives only verified commits through `git cherry-pick -x`; repair aggregate conflicts in the source worktree and reintroduce a new source commit instead of creating product-only aggregate fixes.

`config/local-aggregate-features.json` is the authoritative registry for each included branch's last packaged source commit, aggregate commit, and upstream feedback issue. Keep this overview synchronized with that registry. Every local `feature/*` and `fix/*` worktree is a default aggregation candidate once it is committed, verified, and registered.

| Branch | Source commit | Aggregate commit | Upstream feedback |
| --- | --- | --- | --- |
| `fix/amp-steer` | `05f1268c` | `98e1528c` | [#61](https://github.com/tao12345666333/amp-acp/issues/61) |
| `fix/amp-persistent-steer` | `5e0d9a40` | `aa50bedc` | [#61](https://github.com/tao12345666333/amp-acp/issues/61) |

Use `$open-source-fork-maintenance` before upstream synchronization, aggregate rebuilding, or local packaging. It checks new worktrees, source commit changes, upstream changes, and upstream feedback before asking for a rebase or packaging decision. When a stable-release tag pattern is configured, rebase affected source branches onto the latest matching tag and rebuild from that tag. Unreleased commits on the upstream ref after that tag are debt unless the user chooses them. When the user explicitly declines a rebase, incremental packaging on the existing local baseline remains allowed, but the registry must retain the previous upstream baseline and the result must report the outstanding upstream debt.
<!-- open-source-fork-maintenance:end -->
