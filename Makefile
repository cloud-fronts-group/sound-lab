# Sound Lab — build, package and install the VS Code extension.
#
#   make                 install npm deps → compile → bump the version (patch) → package dist/sound-lab-<new>.vsix
#   make install         install the highest-versioned dist/*.vsix into VS Code (VSIX=path to choose one;
#                        CODE=code-insiders / codium / cursor also work)
#   make all install     both, in one go
#   make BUMP=minor      bump minor instead (patch | minor | major | X.Y.Z | none)
#   make package         package the current version without bumping
#   make download        fetch the VSIX that CI built from the latest green commit on GitHub (needs the gh CLI)
#   make test / test-ui / check / clean / help
#
# Versions are bumped with scripts/version.js, which keeps package.json, package-lock.json and the Claude Code plugin
# manifests in lockstep and dates the CHANGELOG (CI fails if they drift). A bump edits tracked files: commit them, or
# use the Release workflow on GitHub for an official, tagged release.

SHELL       := /bin/bash
.SHELLFLAGS := -eo pipefail -c
NPM   ?= npm
NODE  ?= node
CODE  ?= code
BUMP  ?= patch
DIST  ?= dist
VSIX  ?=
REPO  ?= cloud-fronts-group/sound-lab
NAME  := $(shell $(NODE) -p "require('./package.json').name")
# Read at recipe time so a bump earlier in the same run is picked up.
VERSION = $$($(NODE) scripts/version.js current)

.DEFAULT_GOAL := all
.PHONY: all vsix deps compile test test-ui check bump package install uninstall download clean distclean help

all: vsix ## (default) deps → compile → bump → package

vsix: deps ## bump the version, then package dist/<name>-<version>.vsix
	@$(MAKE) --no-print-directory bump
	@$(MAKE) --no-print-directory package

# npm ci only when the lockfile or manifest changed since the last install
node_modules/.package-lock.json: package-lock.json package.json
	$(NPM) ci --no-audit --no-fund
	@touch $@

deps: node_modules/.package-lock.json ## install npm dependencies (npm ci)

compile: deps ## TypeScript → out/
	$(NPM) run compile

test: deps ## compile + integration tests against real ffmpeg (~100 s)
	$(NPM) test

test-ui: deps ## Playwright webview harnesses (screenshots in test/ui/out/)
	$(NPM) run test:ui

check: ## every manifest carries the same version
	$(NODE) scripts/version.js check

bump: ## bump the version everywhere (BUMP=patch|minor|major|X.Y.Z|none)
ifeq ($(BUMP),none)
	@echo "Version stays $(VERSION)"
else
	@from=$(VERSION); \
	$(NODE) scripts/version.js bump $(BUMP) --allow-empty-changelog >/dev/null; \
	$(NODE) scripts/version.js check >/dev/null; \
	echo "Version $$from → $(VERSION)"
endif

package: compile ## package the current version into dist/ (no bump)
	@mkdir -p $(DIST)
	@out="$(DIST)/$(NAME)-$(VERSION).vsix"; \
	npx --no-install vsce package --out "$$out"; \
	echo; echo "Packaged $$out ($$(du -h "$$out" | cut -f1)). Install it with: make install"

install: ## install the highest-versioned dist/*.vsix into VS Code (or VSIX=path)
	@vsix="$(VSIX)"; \
	[ -n "$$vsix" ] || vsix=$$(ls $(DIST)/$(NAME)-*.vsix 2>/dev/null | sort -V | tail -1); \
	if [ -z "$$vsix" ]; then $(MAKE) --no-print-directory all; vsix=$$(ls $(DIST)/$(NAME)-*.vsix | sort -V | tail -1); fi; \
	if ! command -v $(CODE) >/dev/null 2>&1; then \
	  echo "The '$(CODE)' command isn't on PATH. In VS Code run \"Shell Command: Install 'code' command in PATH\","; \
	  echo "or install $$vsix from the Extensions view: ⋯ → Install from VSIX…  (CODE=code-insiders|codium|cursor also work)"; \
	  exit 1; \
	fi; \
	$(CODE) --install-extension "$$vsix" --force; \
	echo "Installed $$vsix — reload the VS Code window to pick it up."

uninstall: ## remove the extension from VS Code
	$(CODE) --uninstall-extension $$($(NODE) -p "require('./package.json').publisher").$(NAME)

download: ## download the VSIX CI built from the latest green commit on main
	@command -v gh >/dev/null || { echo "Needs the GitHub CLI (gh)."; exit 1; }
	@mkdir -p $(DIST)
	@run=$$(gh run list -R $(REPO) --workflow ci.yml --branch main --status success --limit 1 --json databaseId,headSha -q '.[0].databaseId'); \
	[ -n "$$run" ] || { echo "No successful CI run on main yet."; exit 1; }; \
	gh run download $$run -R $(REPO) -n vsix -D $(DIST); \
	echo "Downloaded: $$(ls -t $(DIST)/*.vsix | head -1)"

clean: ## remove build output (out/, dist/)
	rm -rf out $(DIST)

distclean: clean ## also remove node_modules
	rm -rf node_modules

help: ## list targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/^([a-z-]+):.*## (.*)/  \1\t\2/' | expand -t 14
