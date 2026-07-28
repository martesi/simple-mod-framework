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
// electron.vite.config.ts already did (see `main: {}` there). Note this
// alone doesn't make electron-builder.yml's packaged output self-contained:
// Piscina (src/deploy.ts's worker pool, pulled in via deployPipeline.ts)
// locates its own internal worker bootstrap file relative to its
// node_modules install location at runtime, so node_modules still has to be
// shipped alongside out/**/* regardless of bundling - see
// electron-builder.yml's doc comment. LEI-132's hand-rolled worker_threads
// pool is expected to remove this wrinkle entirely.
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          // The default single "index" entry only emits out/main/index.js.
          // src/deploy.ts's Piscina pool (see deployPipeline.ts, LEI-133)
          // needs a real, separately-loadable patchWorker.js sitting next to
          // it at runtime (`path.join(__dirname, "patchWorker.js")`) to hand
          // to `new Worker(...)` - a second entry here is what makes that
          // file actually exist in the bundled output. Piscina's own
          // file-resolution assumptions predate bundler-based builds like
          // this one; LEI-132's hand-rolled worker_threads pool is expected
          // to remove the need for this entirely.
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
