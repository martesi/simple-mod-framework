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
          // The default single "index" entry only emits out/main/index.cjs.
          // src/deploy.ts's WorkerPool (see deployPipeline.ts, LEI-133) needs
          // a real, separately-loadable patchWorker file sitting next to it
          // at runtime (see resolvePatchWorkerPath() in deploy.ts, which
          // checks for both patchWorker.js and patchWorker.cjs since this
          // build and the CLI's own bun build name it differently) to hand
          // to `new Worker(...)` - a second entry here is what makes that
          // file actually exist in the bundled output.
          index: resolve(__dirname, "src/main/index.ts"),
          patchWorker: resolve(__dirname, "../src/patchWorker.ts")
        },
        output: {
          // Force CJS instead of electron-vite's ESM default (this
          // package.json has "type": "module", which is otherwise auto
          // upgraded to "es"). The embedded framework core (../src)
          // pulls in the full `typescript` package at runtime
          // (src/typescript.ts's ts.createProgram, used to compile mod
          // scripts - see analyseMod.ts/deploy.ts/discover.ts) which gets
          // fully bundled into this same chunk (LEI-133's "no
          // externalizeDepsPlugin"). electron-vite's ESM output path runs
          // an esmShimPlugin that regex-scans the *entire* bundled chunk
          // for the last `import ... from "..."` text to decide where to
          // splice in a `__dirname`/`__filename`/`require` shim - with
          // typescript.js's ~50k lines of source in the chunk (which
          // itself contains plenty of string literals/comments that read
          // like import statements, e.g. codefix diagnostic strings such
          // as "Convert named imports to default import"), that regex
          // reliably finds a false-positive match *inside* a string
          // literal and splices the shim there, truncating the string and
          // producing esbuild's "Unterminated string literal" transform
          // failure. CJS output skips esmShimPlugin entirely (it only
          // runs `if (format === 'es')`) and needs no shim in the first
          // place - __dirname/__filename/require already work natively.
          format: "cjs"
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
