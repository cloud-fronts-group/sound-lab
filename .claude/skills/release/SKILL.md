---
name: release
description: Cut a new Sound Lab version — bump semver everywhere, date the CHANGELOG, verify, package the VSIX, tag. Never publishes to the Marketplace.
argument-hint: "patch | minor | major"
disable-model-invocation: true
---

# Release

Bump type: $ARGUMENTS (default: patch)

The normal way to release is the **Release** GitHub Actions workflow (Actions → Release → Run workflow on `main`). It runs CI, commits the bump, tags, builds the VSIX + plugin zip, creates the GitHub release and publishes. Suggest that first. Follow the steps below only when the user wants to cut the release locally.

1. Run `/verify` first. Do not release from a red build.
2. Make sure `## Unreleased` in `CHANGELOG.md` describes every user-visible change since the last tag (`git log $(git describe --tags --abbrev=0)..HEAD --oneline`). New commands or settings → minor, fixes only → patch.
3. `node scripts/version.js bump <patch|minor|major>`. It updates `package.json`, `package-lock.json`, the plugin's `package.json` and `.claude-plugin/plugin.json` together and renames `## Unreleased` to `## <version> - <date>`. Never edit those versions by hand: CI fails when they drift.
4. `npm run package`, then confirm `sound-lab-<version>.vsix` exists.
5. `git add -A && git commit -m "Release v<version>"`, then `git tag -a v<version> -m "Sound Lab v<version>"`.
6. Tell the user the VSIX path and the install command: `code --install-extension sound-lab-<version>.vsix`. Pushing `main` and the tag (`git push origin main v<version>`) is theirs to do: the tag push runs the Release workflow, which publishes the GitHub release, the Marketplace/Open VSX listing and versioned container images.

Publishing (`vsce publish`) is deliberately denied in `.claude/settings.json`. It needs the publisher token, which lives only in the `marketplace` GitHub environment.
