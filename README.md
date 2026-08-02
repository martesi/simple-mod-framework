# Simple Mod Framework

A mod framework for HITMAN 3 that allows the automatic synthesis of mods from source files.

This is a single Electron app (React 19 + shadcn/ui on Base UI) - there's no separate CLI anymore.
The framework core (deploy/discover/analyse a mod, `src/main/core`) is embedded in-process, replacing the
old `Deploy.exe` subprocess.

`src/main`/`src/preload` are the real backend, not stubs. `src/main/ipcHandlers.ts` registers the
actual `ipcMain.handle` channels (config, mods, deploy) backed by `modIndex.ts`/`modOps.ts`/
`deployManager.ts`/`deployPipeline.ts` - the latter is the only place that reaches into `src/main/core`,
including the game-directory picker and userData-backed settings. `src/preload/index.ts` exposes
those channels as `window.smf`, with no raw `fs`/`child_process` handed to the renderer.

The renderer talks only to the typed `SmfApi` contract in `src/renderer/src/lib/ipc.ts`.
`src/renderer/src/main.tsx` is the single swap point: it uses `ipc.electron.ts` (the real
`window.smf`-backed implementation) whenever the app is running inside real Electron, and falls
back to the in-memory `ipc.mock.ts` only when the renderer is previewed outside Electron (e.g. a
plain `vite` browser preview). The component tree never needs to change either way.

## Setup

```
npm install   # or: bun install
npm run dev   # launches the Electron app
```

`npm run build` typechecks and produces an `out/` bundle; `npm run build:win` additionally packages
it with electron-builder; `npm run preview` launches a built `out/` without a dev server.

`postinstall`/`npm run setup` populate `extra/Third-Party` (RPKG tools, hitman-hashes, etc.) - the
embedded framework core's dev-mode `toolsRoot` (see `src/main/paths.ts`). A packaged build gets the
same tools via `electron-builder.yml`'s `extraResources`, sourced from that same folder.

## Developing on WSL

This is a win-only app (see `electron-builder.yml`'s `win:` section) - the target you actually care
about running is the real Windows Electron binary, not the Linux one `node_modules/electron`
downloads for the WSL host by default (which would need WSLg/GPU passthrough to render at all, and
still wouldn't reflect real Windows behavior).

`flake.nix` provides a `nix develop` shell (node/bun/jj, plus the shared libs the plain `npm run
dev`/`build` Linux-side tooling needs - `electron-vite`'s own build/typecheck steps run as normal
Node code, no Windows binary involved there).

- `npm run dev:win` - the actual dev loop. Fetches a standalone win32-x64 Electron (cached
  alongside whatever `npm install`/`build:win` already downloaded) into `.win-electron-dev/`
  (gitignored), then points `electron-vite`'s `ELECTRON_EXEC_PATH` at it so the *real* Windows
  Electron process launches - via WSL's reverse interop for PE binaries - against the normal Vite
  dev server. Hot reload works exactly like `npm run dev`, just against the real target platform.
  Two WSL-interop-specific quirks this script papers over, in case they resurface elsewhere:
  - `NO_SANDBOX=1` - without it, Chromium's GPU process fails to launch (its sandbox broker
    doesn't cope with the unusual parent-process/desktop context a reverse-interop launch has),
    crashing the whole app on startup.
  - `WSLENV=...ELECTRON_RENDERER_URL` - env vars don't cross the WSL→Windows interop boundary
    unless listed in `WSLENV`; without this the Windows process never learns the Vite dev server's
    URL and falls back to loading a nonexistent production `out/renderer/index.html`.
  - Closing the window: Ctrl-C on the `npm run dev:win` terminal does **not** reliably kill the
    Windows-side `electron.exe` processes (signals don't cross reverse interop either) - close the
    app window itself, or `taskkill /IM electron.exe /F` from a Windows shell if it's stuck running.
- `npm run build:win` - full electron-builder package (`dist/win-unpacked/Mod Manager.exe`). Works
  from WSL without `wine` (see `electron-builder.yml`'s `signAndEditExecutable: false`) - the
  tradeoff is no real icon/version-info embedding; see that file's comment to opt back in.
  electron-builder doesn't set the Unix executable bit on the binary it produces, so `chmod +x
  "dist/win-unpacked/Mod Manager.exe"` once after each build if you want to launch it directly
  from a WSL shell (`./dist/win-unpacked/Mod\ Manager.exe`) rather than from Windows/Explorer -
  and if you do, it hits the same `NO_SANDBOX`/reverse-interop crash as above (launching it from
  Windows/Explorer instead avoids that entirely, since then it isn't going through interop).
