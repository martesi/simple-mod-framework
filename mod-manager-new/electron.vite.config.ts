import { resolve } from "node:path"
import { defineConfig } from "electron-vite"
import react from "@vitejs/plugin-react"

// This app replaces the old Svelte Mod Manager's Electron renderer (see
// LEI-137 for the UI rebuild). fs/child_process access lives only in
// src/main (LEI-134) - the renderer talks to it exclusively through the
// SmfApi contract in src/renderer/src/lib/ipc.ts, backed by preload's
// contextBridge-exposed `smf` object (never a raw window.fs/window.ipc).
// Embedded-core/game-directory-picker wiring (replacing the Deploy.exe
// subprocess spawn with the in-process framework core) is LEI-133.
//
// main/preload are fully bundled (no externalizeDepsPlugin, unlike this
// file's pre-LEI-133 version) rather than left as bare `require()`s of
// node_modules - matches what the old Mod Manager's own
// electron.vite.config.ts already did (see `main: {}` there). This is fully
// self-contained now that src/deploy.ts's worker pool is the hand-rolled
// node:worker_threads WorkerPool (see src/workerPool.ts, LEI-132) instead of
// Piscina - no package-specific node_modules layout to worry about at
// runtime, see electron-builder.yml's doc comment.
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          // The default single "index" entry only emits out/main/index.js.
          // src/deploy.ts's WorkerPool (see deployPipeline.ts, LEI-133) needs
          // a real, separately-loadable patchWorker.js sitting next to it at
          // runtime (`path.join(__dirname, "patchWorker.js")`) to hand to
          // `new Worker(...)` - a second entry here is what makes that file
          // actually exist in the bundled output.
          index: resolve(__dirname, "src/main/index.ts"),
          patchWorker: resolve(__dirname, "../src/patchWorker.ts")
        }
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src")
      }
    },
    plugins: [react()]
  }
})
