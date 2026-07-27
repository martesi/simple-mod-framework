# Mod Manager UI (src-new)

React 19 + shadcn/ui rebuild of the Mod Manager renderer — **UI only** (LEI-137).

This is a standalone Vite app. It is not wired into the Electron main process yet;
it talks to a fully mocked implementation of the future IPC contract
(`src/lib/ipc.ts` / `src/lib/ipc.mock.ts`) so the screens aren't blocked on:

- LEI-134 (moving fs/child_process off the renderer, real `ipcMain.handle` wiring)
- LEI-133 (embedded core + game-directory picker wiring)
- LEI-136 (structured deploy progress channel)

When those land, swap `src/lib/ipc.mock.ts` for a real implementation of the
`SmfApi` interface (e.g. backed by `window.smf` exposed from the hardened
preload) - the components only ever import `useSmfApi()` / the `smf` singleton
from `src/lib/ipc.ts`, never `window.fs` etc. directly.

Only the two screens covered by the `new-ui/Mod Manager.dc.html` design comp are
implemented here: **Mods** (list, drag reorder, enable/disable, deploy) and
**Settings**. The other four screens in the Electron/Svelte app (Authoring,
Docs, Info, and the standalone ModList view) are out of scope for this build.

## Setup (run on your machine, not in the sandbox)

```
cd "Mod Manager/src-new"
bun install   # or: npm install
bun run dev   # or: npm run dev
```
