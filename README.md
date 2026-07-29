# Simple Mod Framework

A mod framework for HITMAN 3 that allows the automatic synthesis of mods from source files.

This is a single Electron app (React 19 + shadcn/ui on Base UI) - there's no separate CLI anymore.
The framework core (deploy/discover/analyse a mod, `src/core`) is embedded in-process, replacing the
old `Deploy.exe` subprocess.

`src/main`/`src/preload` are the real backend, not stubs. `src/main/ipcHandlers.ts` registers the
actual `ipcMain.handle` channels (config, mods, deploy) backed by `modIndex.ts`/`modOps.ts`/
`deployManager.ts`/`deployPipeline.ts` - the latter is the only place that reaches into `src/core`,
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

`postinstall`/`npm run setup` populate `build/Third-Party` (RPKG tools, hitman-hashes, etc.) - the
embedded framework core's dev-mode `toolsRoot` (see `src/main/paths.ts`). A packaged build gets the
same tools via `electron-builder.yml`'s `extraResources` instead.
