# Mod Manager UI (mod-manager-new)

React 19 + shadcn/ui (on Base UI) rebuild of the Mod Manager renderer
(LEI-137), wired up as a real Electron app via electron-vite.

`src/main`/`src/preload` are the real backend now, not stubs. `src/main/ipcHandlers.ts`
registers the actual `ipcMain.handle` channels (config, mods, deploy) backed by
`modIndex.ts`/`modOps.ts`/`deployManager.ts`/`deployPipeline.ts` - the framework
core is embedded in-process (LEI-133), including the game-directory picker and
userData-backed settings. `src/preload/index.ts` exposes those channels as
`window.smf`, with no raw `fs`/`child_process` handed to the renderer
(LEI-134).

The renderer still talks only to the typed `SmfApi` contract in
`src/renderer/src/lib/ipc.ts`. `src/renderer/src/main.tsx` is the single swap
point: it uses `ipc.electron.ts` (the real `window.smf`-backed implementation)
whenever the app is running inside real Electron, and falls back to the
in-memory `ipc.mock.ts` only when the renderer is previewed outside Electron
(e.g. a plain `vite` browser preview). The component tree never needs to
change either way.

Only the two screens covered by the `new-ui/Mod Manager.dc.html` design comp
are implemented: **Mods** (list, drag reorder, enable/disable, deploy) and
**Settings**. Authoring, Docs, Info, and the standalone ModList view are out
of scope for this build.

## Setup (run on your machine, not in the sandbox)

```
cd mod-manager-new
npm install   # or: bun install
npm run dev   # launches the Electron app
```

`npm run build` typechecks and produces an `out/` bundle; `npm run preview`
launches that build without a dev server.
