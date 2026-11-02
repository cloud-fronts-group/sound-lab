---
name: release
description: Cut a new Sound Lab version — bump semver, update CHANGELOG, verify, package the VSIX, tag. Never publishes to the Marketplace.
argument-hint: "patch | minor | major"
disable-model-invocation: true
---

# Release

Bump type: $ARGUMENTS (default: patch)

1. Run `/verify` first. Do not release from a red build.
2. Bump `version` in `package.json` according to semver: new commands or settings → minor, fixes only → patch.
3. Add a `## <version>` section at the top of `CHANGELOG.md`. Summarise user-visible changes from `git log <last-tag>..HEAD --oneline`.
4. `npm run package`, then confirm `sound-lab-<version>.vsix` exists.
5. `git add -A && git commit -m "Release v<version>"`, then `git tag v<version>`.
6. Tell the user the VSIX path and the install command: `code --install-extension sound-lab-<version>.vsix`.

Publishing (`vsce publish`) is deliberately denied in `.claude/settings.json`. It needs the user's publisher token, and they should run it themselves.
