# Simple Mod Framework

A mod framework and manager for HITMAN 3 that synthesizes mods from source files instead of
shipping raw, hand-edited game archives.

The app is where you point at your game install, drop in mod archives (`.zip`/`.7z`/`.rar`) or raw
`.rpkg` files, arrange load order, toggle mod options, and deploy.

## Getting started (using the framework)

1. Install the app (see [Development](#development) below to build it, or grab a release build).
2. On first launch, the setup wizard asks for your HITMAN 3 install folder ("game root"). Mods and
   the working temp folder default to `<gameRoot>/.smf/mods` and `.../.smf/tmp`.
3. Drag mod archives or `.rpkg` files onto the window (or use "Add mod") to install them.
4. Reorder mods to control load order, toggle the ones you want enabled, and expand a mod's
   settings to pick its options.
5. Click Deploy. Progress and any errors show in a persistent status toast; you can cancel a
   running deploy up until it starts finalizing.

## Development

We use Bun.

```
bun install
bun run dev   # launches the Electron app
```

`bun run build` typechecks and produces an `out/` bundle; `bun run build:win` additionally packages
it with electron-builder into `dist/`. `bun run typecheck`/`bun run lint` run standalone.
`postinstall`/`bun run setup` fetch the bundled third-party tools into `extra/Third-Party` (RPKG
CLI, hash lists, etc.) that the app needs at runtime.

### Developing on WSL

The officially supported target is Windows, so on a WSL host you want to run the real Windows
Electron binary rather than the Linux one `node_modules/electron` downloads by default (which
needs WSLg/GPU passthrough to render at all, and still wouldn't reflect real Windows behavior).
`flake.nix`'s default `nix develop` shell has the Node/Bun toolchain needed for everyday
dev/build/typecheck work.

- `bun run dev:win` - fetches a standalone Windows Electron build and runs it against the normal
  Vite dev server via WSL's reverse interop, so you get hot reload against the real target
  platform. If the window won't close from Ctrl-C, close it directly or `taskkill /IM electron.exe
  /F` from a Windows shell - signals don't cross the interop boundary.
- `bun run build:win` - a full electron-builder package (`dist/win-unpacked/Mod Manager.exe`),
  buildable from WSL without `wine`. Run `chmod +x` on the produced `.exe` once if you want to
  launch it directly from a WSL shell.

### Running natively on Linux

The bundled tools (RPKG CLI, resource/entity tools, 7-Zip, ...) are still Windows binaries, but the
app can also run as a native Linux Electron process and transparently shell out to those tools
through Wine instead of requiring a Windows host at all - deploy works as expected through this
path. `nix develop .#e2e` provides everything needed (Wine, a virtual display, font/EGL setup) to
run the app headlessly for testing.

### Docs

The original project's `docs/` (manifest reference, special file types, scripting API, folder
structure) isn't carried over in this build. Possibly a static site down the line.

## What changed from the original framework

The original project was a separate Svelte/Electron GUI ("Mod Manager") that shelled out to a
standalone `Deploy.exe` CLI to do the actual work. This repo collapses that into one Electron app
with the deploy/discover/analyse logic itself running in-process, rather than as a separate CLI the
GUI launches and talks to. The framework still shells out to the same third-party tools it always
has (RPKG CLI, ResourceTool, etc.) - that hasn't changed, only the GUI/`Deploy.exe` split is gone.

### Mod authoring & docs

- **Dropped:** the old GUI's in-app **authoring pages** (guided manifest creation, an in-app
  option editor) and its **in-app documentation viewer** are gone - there's no in-app way to build
  a mod by hand-holding anymore. The mod-update auto-download UI is also gone (it wasn't working) -
  the manifest's `updateCheck` field is still read and stored, just not surfaced or acted on
  anywhere yet.
- **Kept and improved:** importing mods (framework archives or raw `.rpkg` files) is still
  drag-and-drop, and now installs multiple dropped files **in parallel** instead of one at a time,
  with per-file progress.

### Deploy behavior

- Deploys are now **cancellable** mid-run from the status toast (disabled once finalizing starts,
  since that phase can't be safely interrupted), and the app warns before quitting during an active
  deploy instead of leaving a partial deploy on disk.
- Runtime file writes during deploy are atomic, and a pre-deploy cleanup crash mid-way through no
  longer leaves the Runtime folder in a broken intermediate state.
- Mod option image previews got a proper lightbox (zoom/pan) with a "locate current option"
  shortcut, instead of a plain inline `<img>`.

### Performance

- Mod discovery persists its index to disk instead of rescanning every launch, and skips
  re-hashing/re-extracting files that haven't changed since last time.
- Each mod now builds independently and eagerly (as soon as it's added or its options change)
  against a SQLite-backed cache, instead of one full rebuild pass across every mod on deploy.
- Deploy's file cache moved from a single blob-cache file to content-addressed loose files, which
  parallelizes and invalidates more cheaply.
- The settings drawer's option lists are virtualized, and both first-launch startup and opening the
  drawer/dialogs no longer visibly lag on larger mod lists.

### Platform / infra

- Windows is the officially shipped target, with Linux (via Wine) also working - see
  [Running natively on Linux](#running-natively-on-linux) above.
- Sentry error reporting was replaced with local `electron-log` file logging. The Piscina-based
  worker pool was replaced with a small hand-rolled one, and mod script transpilation moved off a
  bundled TypeScript compiler onto `esbuild`.
- The UI now has i18n infrastructure (Lingui) wired up, though only English (US) is exposed in the
  language picker for now.
