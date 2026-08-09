# Simple Mod Framework

A mod framework and manager for HITMAN 3 that synthesizes mods from source files instead of
shipping raw, hand-edited game archives.

The app is where you point at your game install, drop in mod archives (`.zip`/`.7z`/`.rar`) or raw
`.rpkg` files, arrange load order, toggle mod options, and deploy.

## Getting started (using the framework)

1. Install the app (see [Development](#development) below to build it, or grab a release build).
2. On first launch, the setup wizard asks for your HITMAN 3 install folder ("game root") and its
   storefront. The manager suggests a storefront from the install when possible, and you can
   override it. Mods and the working temp folder default to `<gameRoot>/.smf/mods` and
   `.../.smf/tmp`.
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

### Third-party tools and provenance

The app invokes several Windows tools from `extra/Third-Party`. The table below records the
upstream project or release used for each one. “Fetched” means `bun run setup` downloads it when it
is absent; the other files are kept in the repository because their exact compatibility or
provenance still matters to the framework. The fetcher's operational details live in
[`scripts/fetch-third-party.md`](scripts/fetch-third-party.md).

| Files | Upstream | Release/source used | Provisioning and notes |
| --- | --- | --- | --- |
| `quickentity-rs.exe` | [atampy25/quickentity-rs](https://github.com/atampy25/quickentity-rs) | [3.1](https://github.com/atampy25/quickentity-rs/releases/tag/3.1) | Fetched from the latest release by `scripts/fetch-third-party.ts`. |
| `HMLanguageTools.exe`, `HMTextureTools.exe` | [AnthonyFuller/TonyTools](https://github.com/AnthonyFuller/TonyTools) | [`TonyTools.zip`](https://github.com/AnthonyFuller/TonyTools/releases/latest) | Fetched and extracted by `scripts/fetch-third-party.ts`; `TonyTools-LICENSE` is included. |
| `7z.exe` | [ip7z/7zip](https://github.com/ip7z/7zip) | Latest `*-extra.7z` package, currently [26.02](https://github.com/ip7z/7zip/releases/tag/26.02) | Fetched by `scripts/fetch-third-party.ts` as the standalone `7za.exe`, then stored under the filename expected by the app; see `7z-LICENSE`. |
| `hash_list.txt` | [glacier-modding/Hitman-Hashes](https://github.com/glacier-modding/Hitman-Hashes) | Latest [`latest-hashes.7z`](https://github.com/glacier-modding/Hitman-Hashes/releases/latest), currently v375 | Downloaded and extracted by `scripts/fetch-hashes.ts`. The checked-in `baseGameEntities.txt` and `baseGameSoundbanks.txt` are not included in this release and remain tracked. |
| `rpkg-cli.exe`, `quickentity_ffi.dll`, `assimp.dll`, `hash_list.hmla` | [glacier-modding/RPKG-Tool](https://github.com/glacier-modding/RPKG-Tool) | [`v2.34.0` CLI release](https://github.com/glacier-modding/RPKG-Tool/releases/tag/v2.34.0) | Fetched and extracted by `scripts/fetch-third-party.ts`. The archive also contains ResourceLib copies; the shared ResourceLib files listed below are selected for the ResourceTool build. |
| `ResourceTool.exe`, `ResourceLib_HM2.dll`, `ResourceLib_HM2016.dll`, `ResourceLib_HM3.dll` | [OrfeasZ/ZHMTools](https://github.com/OrfeasZ/ZHMTools) | [`v4.1.0` Windows ResourceTool release](https://github.com/OrfeasZ/ZHMTools/releases/tag/v4.1.0) | Fetched and extracted by `scripts/fetch-third-party.ts` from `ResourceTool-win-x64.zip`; the upstream license is the LGPL text in `COPYING.LESSER`. |
| `quickentity-3.exe` | Related to [atampy25/quickentity-rs](https://github.com/atampy25/quickentity-rs) | [3.0 release](https://github.com/atampy25/quickentity-rs/releases/tag/3.0) | Fetched by `scripts/fetch-third-party.ts` from the 3.0 release and renamed to the filename used by the app. The upstream asset is named `quickentity-rs.exe`. |
| `h6xtea.exe` | [HHCHunter/HITMAN](https://github.com/HHCHunter/HITMAN/blob/master/h6xtea/h6xtea/h6xtea.exe) | The checked-in file is byte-identical to the linked file | [glacier-modding/hitman-xtea.rs](https://github.com/glacier-modding/hitman-xtea.rs) is a related Zlib-licensed Rust implementation, but it has not been verified as the same executable or command-line interface. |
| `xdelta3.exe` | [jmacd/xdelta](https://github.com/jmacd/xdelta) | [`v3.2.0` Windows x64 release](https://github.com/jmacd/xdelta/releases/tag/v3.2.0) | Fetched and extracted from `xdelta3-3.2.0-windows-x86_64.zip`; `xdelta3-LICENSE` is included. |
| `OREStool.exe` | No public repository or release could be confirmed | A Discord message with source appended is the only known reference: [message](https://discord.com/channels/555224628251852811/815577522958893096/858685324103778344) | Remains checked in. Treat its provenance as unverified until a public source or release is available. |

This table reflects the upstream audit performed on 2026-08-09; check the linked release pages
before changing a tool version.

The public releases are the compatibility reference for updates. CI therefore builds the SMF
application against these audited artifacts instead of compiling every tool from source. Several
tools do have public source, but `quickentity-3.exe`, the exact `h6xtea.exe` build, and `OREStool.exe`
do not currently have a reproducible public build path. A future source-build job can verify tools
such as QuickEntity, RPKG-Tool, ZHMTools, and xdelta separately, but it should not replace the
release artifacts until its output and behavior have been compared with the versions above.

### Developing on WSL

The officially supported target is Windows, so on a WSL host you want to run the real Windows
Electron binary rather than the Linux one `node_modules/electron` downloads by default (which
needs WSLg/GPU passthrough to render at all, and still wouldn't reflect real Windows behavior).
`flake.nix`'s default `nix develop` shell has the Bun toolchain needed for everyday
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

### v3 compatibility milestone

The [Issue #677 compatibility milestone](https://github.com/atampy25/simple-mod-framework/issues/677) is implemented
within its stated scope. The app remains a v2.33.40 engine, but accepts the selected v3-style
manifest inputs and normalizes them at the archive, index, validation, and analysis boundaries.

Implemented in this milestone:

- v3 data aliases and precedence, legacy references and ranges, supported-platform mapping, and
  future-framework rejection.
- Invalid manifests remain visible as disabled invalid mods instead of being treated as raw RPKGs;
  normalized index/deploy caches are versioned and safely invalidated.
- Root-manifest archives, wrapper/multi-mod archives, collision checks, HTTPS mod URLs, and
  compatibility metadata for requirements, incompatibilities, and load order.
- Deploy preflight validation with aggregated actionable errors, including platform, version-range,
  enabled-target, and load-order checks.
- `localisation.patch.json` validation and deterministic conversion into the existing localization
  override system.

This is not full v3 support. Graph deployment, Rune, multi-game support, update downloads, option
interpolation, automatic packagedefinition entries, QuickEntity install-time migration, automatic
reordering, and broader validation remain future work.

### Mod authoring & docs

- **Dropped:** the old GUI's in-app **authoring pages** (guided manifest creation, an in-app
  option editor) and its **in-app documentation viewer** are gone - there's no in-app way to build
  a mod by hand-holding anymore. The mod-update auto-download UI is also gone (it wasn't working);
  an HTTPS manifest `url` is available from the mod row and opens in the system browser.
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
