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
// preload is always fully bundled (externalizeDepsPlugin disabled
// unconditionally, see its own comment below - the sandboxed preload loader
// can never resolve a bare node_modules require, dev or build). main is
// fully bundled too, but - unlike this file's pre-LEI-133 version, and
// unlike preload - only when actually building/packaging; `electron-vite
// dev` leaves it externalized (matches what the old Mod Manager's own
// electron.vite.config.ts did unconditionally, see `main: {}` there). This
// is fully self-contained at build time now that src/deploy.ts's worker
// pool is the hand-rolled node:worker_threads WorkerPool (see
// src/workerPool.ts, LEI-132) instead of Piscina - no package-specific
// node_modules layout to worry about at runtime, see electron-builder.yml's
// doc comment.
export default defineConfig(({ command }) => ({
  main: {
    build: {
      // Same fix as preload below, applied preemptively here rather than
      // after the fact: electron-vite's build.externalizeDeps defaults to
      // true, which leaves every package.json "dependencies" entry (as
      // opposed to devDependencies - typescript is why that one already
      // ends up bundled, see the output.format comment below) as a bare
      // require("pkg-name") in out/main/index.cjs instead of inlining it.
      // That's invisible in `npm run dev` because a real node_modules folder
      // happens to be sitting on disk next to the project - but
      // electron-builder.yml ships only `out/**/*` with no node_modules in
      // the packaged app, so main's own fs-extra/json5/chalk/semver/etc.
      // requires (all "dependencies") would 404 the same way
      // @electron-toolkit/preload just did in preload, the first time this
      // actually gets packaged rather than run from source. Disabling it
      // bundles all of it into index.cjs, matching what electron-builder.yml's
      // own doc comment already assumes is true ("no node_modules carried
      // into app.asar because main/preload are fully bundled").
      //
      // Only disabled for `command === 'build'` though - `electron-vite dev`
      // also goes through this same config but runs main straight out of
      // out/main next to a real node_modules folder (see above), so there's
      // no packaging step to protect against and every dev restart isn't
      // worth paying the "bundle all of typescript's ~50k lines into
      // index.cjs again" cost for. Left at the default (true) there instead.
      externalizeDeps: command !== "build",
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
  preload: {
    build: {
      // electron-vite's build.externalizeDeps defaults to true regardless of
      // this file's top-of-file "fully bundled, no externalizeDepsPlugin"
      // comment - that comment was only ever made true for main by the CJS
      // format override below, which is unrelated. Left at its default here,
      // every package.json "dependencies" entry (as opposed to devDependencies
      // like typescript, which is why main already bundles that one) gets
      // turned into a bare `require("pkg-name")` in the output - which is how
      // @electron-toolkit/preload ended up as an unbundled require() in
      // index.cjs. That's fine in main (a real Node process with node_modules
      // on disk) but fatal in a sandboxed preload script, whose polyfilled
      // require only resolves a small builtin allowlist (see the crypto fix
      // above) and 'electron' itself - never arbitrary node_modules packages.
      // Disabling it here bundles @electron-toolkit/preload's source directly
      // into index.cjs instead of leaving a require() for it.
      externalizeDeps: false,
      rollupOptions: {
        output: {
          // Same fix as main above: this package.json's "type": "module" makes
          // electron-vite default preload output to ESM (out/preload/index.mjs).
          // Electron's sandboxed preload loader (webPreferences.sandbox: true,
          // set in src/main/index.ts) runs preload scripts through a bespoke,
          // synchronous CommonJS-only loader - it chokes on a bare top-level
          // `import` statement with "Cannot use import statement outside a
          // module" even though the file is correctly named .mjs and Node
          // itself would happily treat it as ESM. Forcing cjs here (renamed to
          // index.cjs, same as main/index.cjs) sidesteps that loader entirely.
          format: "cjs"
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src")
      }
    },
    plugins: [react()]
  }
}))
