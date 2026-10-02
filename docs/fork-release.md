# Personal fork releases

Download from [hxy91819/amp-acp Releases](https://github.com/hxy91819/amp-acp/releases). These packages include the fork's image, steering, resume, and mode-selection changes. Upstream npm and ACP Registry releases have their own release history.

## Install

The adapter includes its JavaScript runtime. Install and authenticate the Amp CLI separately (`amp login`, `amp --version`). Linux packages target glibc systems; Alpine/musl packages are not provided.

Assets: `amp-acp-linux-x64.tar.gz`, `amp-acp-linux-arm64.tar.gz`, `amp-acp-darwin-x64.tar.gz`, `amp-acp-darwin-arm64.tar.gz`, and `amp-acp-windows-x64.zip`. Each archive contains the executable, `LICENSE`, these instructions, and `VERSION.json` with its tag, source commit, and platform.

For Linux x64, use a new empty download directory:

```bash
tag=fork-v0.10.0-20261002.1
asset=amp-acp-linux-x64.tar.gz
base="https://github.com/hxy91819/amp-acp/releases/download/$tag"
curl -fLO "$base/$asset"
curl -fLO "$base/SHA256SUMS"
awk -v asset="$asset" '$2 == asset { print }' SHA256SUMS > selected.sha256
test -s selected.sha256
sha256sum -c selected.sha256
tar -xzf "$asset"
mkdir -p "$HOME/.local/bin"
install -m 755 amp-acp "$HOME/.local/bin/amp-acp"
```

For Linux arm64 or macOS, change `asset` to the matching archive. On macOS replace the checksum command with `shasum -a 256 -c selected.sha256`. macOS packages are not notarized; if macOS blocks a download, use **System Settings → Privacy & Security → Open Anyway** after verifying its checksum.

On Windows x64, download the ZIP and `SHA256SUMS`, compare `Get-FileHash .\amp-acp-windows-x64.zip -Algorithm SHA256` with the matching checksum, then `Expand-Archive .\amp-acp-windows-x64.zip`. Point the ACP client to the resulting `amp-acp.exe`.

For a terminal smoke test (Linux/macOS), the adapter must return an ACP initialize response with image support and native steering:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' | "$HOME/.local/bin/amp-acp"
```

Configure BB's Amp provider command to the installed executable, remove the old `dist/index.js` argument, and retain existing environment settings such as `AMP_CLI_PATH`, `AMP_ACP_MODE_SOURCE=remote`, and `AMP_ACP_CANCEL_MODE=steer`. Other ACP clients can use the same executable. Restart idle runtimes to load an upgrade; retained state directories keep session mappings and saved image files.

## Publish or rerun

`.github/workflows/fork-release.yml` builds annotated `fork-v<package-version>-<UTC-date>.<sequence>` tags from pushed, verified `local/aggregate` commits. It preserves the repository's existing feature branches, cherry-pick aggregation, and registry. The current baseline policy is intentionally unchanged by the release tooling.

The personal fork's default branch is `local/aggregate`. Keep its verified release workflow pushed there before tagging: GitHub's built-in token cannot create a release when the target introduces workflow changes relative to the default branch. This also makes fresh clones use the maintained fork. The upstream repository's default branch is unchanged.

Before a tag, add its notes to `CHANGELOG.fork.md`, complete repository checks and independent review, aggregate and push the verified source, then create an annotated unused tag and push that tag to the personal `origin` remote. Do not use the upstream `v*` trigger for fork releases: it includes npm publication to the upstream package.

The workflow pins Bun 1.4.2 and action commits, uses frozen dependencies, and tests extracted archives on native Linux, macOS, and Windows runners. `scripts/fork_release_v1.py` is the repository's versioned GitHub-binary adapter; it needs only Python's standard library and the GitHub CLI in the publishing job. No registry, OIDC configuration, secrets, or external skill installation are needed for this GitHub-only workflow. The `secure-release` skill's npm kit is not used for binary publication.

Build jobs upload archives once. Assembly verifies embedded identity, adds `SHA256SUMS`, notes, and `manifest.json`. Publishing verifies every asset, finds drafts through the paginated releases list, and pins further reads to the Release ID. It creates a draft, fills missing matching assets, downloads and compares bytes, then makes the release public and downloads it again. Published versions are verified on rerun, never overwritten. Retry only failed jobs to reuse the exact built bytes (`gh run rerun RUN_ID --failed`); a full rebuild with changed bytes needs a new tag. Do not move release tags. If build artifacts have expired, publish a new tag rather than reconstructing an existing release.

Inspect results with `gh run list -R hxy91819/amp-acp --workflow fork-release.yml` and `gh release view TAG -R hxy91819/amp-acp`. Completion requires a successful workflow, a public release with all five archives/checksums/metadata, and a download/install smoke outside the build directory.

The first release retains tested baseline `d82473919f4e1db28664d929075739ec752f3e9c` (unreleased upstream package version 0.10.0). Upstream stable remains v0.9.0. Pending upstream commits observed when preparing the release: plugin mode discovery `d4c2e2c`, turn usage `5d4fd6e`, open mode passthrough `eca0ee9`, SDK update `6ed45c8`, and live E2E setup `e35216d`. They are not included in this release. Check upstream again when preparing a later release.
