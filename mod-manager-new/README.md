# Mod Manager UI (mod-manager-new)

React 19 + shadcn/ui (on Base UI) rebuild of the Mod Manager renderer — **UI
only** (LEI-137), wired up as a real Electron app via electron-vite so it can
be run directly, not just previewed in a browser.

`src/main` and `src/preload` are intentionally inert stubs - just enough to
open a window and load the renderer. There is no fs/child_process access, no
real `ipcMain.handle` wiring, and no Deploy.exe invocation here; that's
LEI-134 (moving fs/child_process off the renderer) and LEI-133 (embedded core
+ game directory picker + userData settings). Everything in the renderer
talks to a typed, fully mocked contract instead:
`src/renderer/src/lib/ipc.ts` / `ipc.mock.ts`.

When LEI-134/LEI-133 land, expose the real channels from `src/preload/index.ts`
behind the same `SmfApi` shape and swap the mock for a thin wrapper around
`window.smf` in `src/renderer/src/main.tsx` - the component tree doesn't need
to change.

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
