# Fork releases

## fork-v0.10.0-20261002.1

- First installable release of the personal fork, including all seven registered fixes and features.
- Preserves image input, native mid-turn steering, durable session resume, and remote account mode selection.
- Oversized image inputs retain original bytes in durable files with explicit image-viewing instructions.
- Ships standalone adapters for Linux/macOS x64 and arm64, and Windows x64, with checksums and source metadata. Amp CLI must be installed and authenticated separately.

This release keeps the tested upstream baseline `d82473919f4e1db28664d929075739ec752f3e9c`, which contains unreleased changes after upstream stable `v0.9.0`. It does not claim to be an upstream `v0.10.0` release. Five subsequent upstream main commits are not integrated; see the baseline policy in `docs/fork-release.md`.
