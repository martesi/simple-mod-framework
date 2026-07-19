# Build pipeline for simple-mod-framework, as a dependency graph instead of
# the npm-script `&&` chains in package.json (build:cli, build:win, dist:win).
#
# Why: those chains are sequential end to end, but only *part* of the graph
# actually has to be. The root CLI build is a true pipeline - build-tsc ->
# build-exe, each step consuming the last one's output - so that part stays
# sequential here too. The Mod Manager GUI, though, is a fully
# separate npm project (its own package.json/node_modules/vite/electron-builder)
# that assemble-dist.js only reads from at the very end (Mod Manager/dist/win-unpacked).
# It doesn't depend on the CLI build or vice versa, so the two can run side by
# side - that's the actual time saved here, not micro-parallelism inside either
# chain.
#
# Requires just >= 1.42 (for the `[parallel]` attribute, added 2025-07-13).
# Already available after `npm install` - it's the `rust-just` devDependency
# in package.json, so `npm run build` / `npm run dist` work with nothing
# extra installed. To run `just` directly instead of through npm scripts,
# either use `npx just <recipe>`, or install it standalone with
# `cargo install just`, `winget install --id Casey.Just`, or via the
# flake.nix devshell (`nix develop`).
#
# Usage:
#   just              # list recipes
#   just dist         # full release build -> dist/
#   just cli          # just the CLI (build/Deploy.exe), skip the GUI
#   just build-mm      # just the Mod Manager GUI
#   just --dry-run dist   # show what would run, without running it
#
# Equivalent via npm (no `just` on PATH required):
#   npm run dist      # -> just dist
#   npm run build     # -> just build

default:
    @just --list

# ---------------------------------------------------------------------------
# Installs - independent of each other, safe to parallelize
# ---------------------------------------------------------------------------

[parallel]
install: install-root install-mm

install-root:
    bun install

install-mm:
    cd "Mod Manager" && bun install

# ---------------------------------------------------------------------------
# Root CLI build - strictly sequential (each step needs the last step's
# output on disk)
# ---------------------------------------------------------------------------

build-tsc: install-root
    node scripts/build.js

build-exe: build-tsc
    pkg package.json --targets node18-win-x64 --output build/Deploy.exe --compress Brotli

# Whole CLI pipeline, e.g. `just cli` to build just the exe without the GUI
cli: build-exe

# TypeScript typecheck + bundle, in watch mode, for local dev
dev-deploy: install-root
    node scripts/build.js --watch

# ---------------------------------------------------------------------------
# Mod Manager GUI - separate npm project, builds independently of the CLI
# ---------------------------------------------------------------------------

build-mm: install-mm
    cd "Mod Manager" && npm run build:win

# ---------------------------------------------------------------------------
# Assembly - the one place that needs both halves, so it's the one place
# parallelism actually pays off
# ---------------------------------------------------------------------------

[parallel]
build: cli build-mm

assemble: build
    node scripts/assemble-dist.js
    node scripts/fetch-hashes.js dist

# Full release build, equivalent to `npm run dist:win`
dist: assemble
    @echo "dist/ assembled"

# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------

clean:
    rm -rf build dist
