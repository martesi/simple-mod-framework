# Mod Manager: Electron → Tauri rewrite

## Context

The current "Mod Manager" (`Mod Manager/`) is an Electron app whose renderer talks to the OS directly: `preload.cjs` puts raw Node modules (`fs-extra`, `path`, `original-fs`, `child_process`, `klaw-sync`) on `window`, and ~150 call sites across 8 Svelte files use them synchronously. Tauri's webview has no Node runtime, so none of that works as-is — every one of those call sites needs to cross an `invoke()` boundary to Rust.

The CLI core (`src/`, 11.3k lines: `main.ts`, `deploy.ts`, `core.ts`, `rpkg.ts`, the QuickEntity parsers, plus the `rust/` napi addon) is unaffected by any of this — it reads args and does its job as `Deploy.exe`, built by an entirely separate, untouched pipeline (`npm run build:win` at repo root). The user wants Deploy.exe integrated into the new app (spawned and its output streamed into the UI), not left as a fire-and-forget shell-out.

Goal: build a new Tauri app in a new top-level directory, leaving `Mod Manager/`, `src/`, and `rust/` untouched (kept as a working fallback until cutover), that reuses the existing Svelte UI code as directly as possible and moves filesystem/process work behind a thin, scoped Rust bridge.

## Key design decision: thin compat shim, not bespoke per-feature commands

Looking at the actual call sites (e.g. `addMod()` in `modList/+page.svelte`), the *business logic* — extraction → detect framework-mod vs RPKG-mod → validate via the existing Ajv schemas → warn on scripts/peacockPlugins → copy into `../Mods` — is real UI-level logic that should stay in Svelte untouched. Only the leaf IO calls (`readFileSync`, `existsSync`, `copySync`, `execSync`, etc.) need to move.

So instead of designing bespoke commands like `install_mod()`, the Rust side exposes a **generic, scoped IO bridge** that mirrors the `fs-extra`/`child_process` calls already in use:

- `fs_read_text`, `fs_write_text`, `fs_exists`, `fs_read_dir`, `fs_copy`, `fs_remove`, `fs_empty_dir`, `fs_ensure_dir` — map 1:1 to the `fs-extra` calls seen in `lib/utils.ts`, `routes/modList/+page.svelte`, `routes/+page.svelte`.
- `klaw_walk(path, { nodir })` — mirrors `klaw-sync` usage (recursive file listing).
- `extract_archive(archivePath, destDir)` — replaces the `execSync('"..\\Third-Party\\7z.exe" x "..." -aoa -y -o"..."')` calls (4 occurrences). Runs `Third-Party/7z.exe` via `std::process::Command` with an **args array**, not a shell string — this also fixes an existing command-injection bug (today's archive path is interpolated raw into a shell command).
- `run_deploy()` — spawns `../Deploy.exe` via `Command`, streams stdout/stderr as Tauri events (`deploy-output`, `deploy-finished`), replacing `ipcMain.on("deploy")` + `mainWindow.webContents.send(...)`.
- `write_temp_bytes(path, bytes)` — the one case that's a genuine exception to "frontend never touches file content": the auto-download-mod flow in `+page.svelte` fetches an archive over the network into memory (`chunksAll`) and needs to persist it before extraction. Frontend does the `fetch()`, hands the bytes to this one command.

All path *composition* (`path.join`, `path.resolve`) stays client-side as plain string logic (via `@tauri-apps/api/path` or even plain JS — no OS call needed for joining), matching the ask to keep the frontend to "query a path" territory — the frontend decides *which* path, Rust only touches disk once a path is handed to it, and only within a capability-scoped root.

A `src/lib/native.ts` shim in the new app exposes functions with the *same names and shapes* as today's `window.fs.*`/`window.path.*`/`window.child_process.*`/`window.ipc.*`, backed by `invoke()`. Porting a component becomes: `window.fs.readFileSync(...)` → `await fs.readFileSync(...)`, i.e. mostly adding `async`/`await`, not restructuring logic. This directly narrows the "long and hard to debug" risk: one shim to test in isolation, then a mechanical pass over call sites.

**Known friction point:** a few places derive state synchronously in Svelte reactive blocks (e.g. `$: enabledMods = getConfig().loadOrder.map(...)` in `modList/+page.svelte:62`). Reactive blocks can't `await`. These need to become a writable store populated on load/on relevant events, with the `$:` block deriving from the store instead of calling `getConfig()` inline. This is localized (a handful of spots) but is the one place that's a real restructure, not a mechanical swap — call it out explicitly during Phase 2/4 so it doesn't surprise mid-port.

## Path resolution (fixes an existing hack)

Today, `electron.cjs` relies on process `cwd` and a relaunch-with-chdir dance to make `../Deploy.exe`, `../Mods`, `../config.json`, `../Third-Party` resolve correctly. In Tauri, resolve the "framework root" once via `std::env::current_exe()` (the new app's exe's parent directory) in a small `paths.rs` helper, and derive all sibling paths (`Mods/`, `Third-Party/`, `config.json`, `docs/`, `Deploy.exe`) from that — no cwd dependence, no relaunch hack needed. Preserve the existing on-disk layout (new app's exe lives where `Mod Manager.exe` lives today, one level below the framework root) so existing users' `Mods/`/`config.json` keep working without a migration step.

## New directory layout

Create `mod-manager-tauri/` at the repo root (sibling to `Mod Manager/`, `src/`, `rust/`):

```
mod-manager-tauri/
  package.json            # SvelteKit deps carried over minus electron-only ones
                           # (drop electron, electron-builder, @electron/remote,
                           #  electron-window-state, electron-context-menu,
                           #  electron-serve, electron-updater, electron-reloader;
                           #  add @tauri-apps/cli, @tauri-apps/api, and plugins:
                           #  dialog, shell, fs, window-state, single-instance, deep-link)
  svelte.config.js, vite.config.js, tailwind.config.cjs, tsconfig.json  # copied from Mod Manager/, adapted per Tauri's SvelteKit guide (static adapter, same as today)
  src/
    routes/...             # copied from `Mod Manager/src/routes`, ported per-file
    lib/
      native.ts            # NEW — the invoke-backed shim described above
      *.svelte, *-schema.json   # copied as-is (Ajv validation, UI components unchanged)
  static/                  # copied as-is (shiki assets)
  src-tauri/
    Cargo.toml
    tauri.conf.json
    capabilities/default.json   # Tauri v2 permissions: scope fs/shell to the resolved framework root + Third-Party/7z.exe + ../Deploy.exe only, not arbitrary paths
    src/
      main.rs
      paths.rs             # framework-root resolver
      commands/
        fs_bridge.rs        # fs_read_text / fs_write_text / fs_exists / fs_read_dir / fs_copy / fs_remove / fs_empty_dir / klaw_walk
        archive.rs           # extract_archive, write_temp_bytes
        deploy.rs             # run_deploy + event streaming
```

## Build order (each phase independently runnable/testable)

0. **Scaffold**: `npm create tauri-app` (or manual) in `mod-manager-tauri/`, empty window, verify dev loop works (`tauri dev`) before porting anything.
1. **Config vertical slice**: `paths.rs`, `fs_bridge` commands, `get_config`/`set_config` round-trip through `native.ts`. Smallest possible end-to-end proof that invoke works and paths resolve correctly outside Electron.
2. **Mod list (read-only)**: port `lib/utils.ts` read paths (`getAllMods`, `getModManifest`, `validateModFolder`) and `routes/modList/+page.svelte`'s listing view onto the shim. No install/uninstall yet — gets the main screen rendering real data.
3. **Deploy integration**: `deploy.rs` + event streaming, port the deploy-trigger button and output modal in `modList/+page.svelte`. Self-contained; doesn't depend on install/uninstall.
4. **Install/uninstall/archives**: `archive.rs`, port `addMod()`/`installRPKGMod()` in `modList/+page.svelte` and the setup wizard in `routes/+page.svelte` (including the one bytes-over-the-wire download case). This is the riskiest phase — do it last, once the shim pattern is proven on phases 1–3.
5. **Remaining screens**: `routes/settings`, `routes/docs/[page]` (reads root `docs/*.md`), `routes/authoring/**`, `lib/Mod.svelte`, `lib/ModManifestInterface.svelte` — all small, same mechanical pattern. Wire up native dialogs (`@tauri-apps/plugin-dialog`) for the three `dialog.showOpenDialogSync` cases, window-state persistence, and the `simple-mod-framework://` deep link.
6. **Packaging**: `tauri.conf.json` bundle config, extend `flake.nix` with Tauri's Linux deps (webkit2gtk4.1, gtk3, libayatana-appindicator, librsvg, `cargo-tauri`) alongside the existing rustc/cargo already there for `rust/`. Verify a built app placed in the existing relative layout (next to `Deploy.exe`, `Third-Party/`, `Mods/`, `config.json`) launches and deploys correctly. CI workflow updates are a follow-up, not in scope here.

## Out of scope / explicit non-goals

- Rewriting or touching `src/` (CLI core) or `rust/` (napi addon) — Deploy.exe keeps being built by the existing pipeline and is only *spawned* differently.
- Moving `Mods/`/`config.json` to OS-standard app-data directories — preserve the current sibling-to-exe layout for upgrade compatibility.
- Auto-updater / code signing — carry over later, not part of this port.
- `.github/workflows/*` changes — follow-up once the new app is stable.

## Verification per phase

- Phase 0: `tauri dev` opens a window on Linux (via the flake's devShell) and Windows.
- Phase 1: invoke `get_config`/`set_config` from the devtools console or a temp UI button; confirm it reads/writes the real `config.json` one level above the exe.
- Phase 2: mod list screen shows real mods from a test `Mods/` folder, matching what the existing Electron app shows for the same folder.
- Phase 3: trigger deploy against a real (or stub) `Deploy.exe`, confirm streamed output matches what the Electron app shows.
- Phase 4: install a framework mod zip and an RPKG mod through the new UI, confirm `Mods/` ends up identical to doing the same operation in the existing Electron app; confirm a filename containing `"` or `&` no longer breaks/exploits extraction.
- Phase 6: full build placed in the real relative layout, run through add-mod → deploy → launch-game-adjacent flow end to end.
