import { resolve } from "node:path"
import { defineConfig } from "electron-vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"

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
        // esbuild (the embedded core's mod-script transpiler as of LEI-139,
        // replacing the old `typescript` package - see src/typescript.ts;
        // native `esbuild` rather than `esbuild-wasm` because this app only
        // ships for Windows anyway, so WASM's cross-platform story bought
        // nothing, and native is both smaller installed and avoids the
        // "10x slower" WASM performance hit - see src/typescript.ts's doc
        // comment) is the one dependency that must stay external even though
        // externalizeDeps is off for build: esbuild's own runtime code
        // checks that __filename/__dirname still point at its own unmodified
        // lib/main.js and throws "The esbuild JavaScript API cannot be
        // bundled" if it detects it's been inlined by a bundler - it also
        // spawns a subprocess pointed at a real on-disk binary
        // (@esbuild/win32-x64's esbuild.exe), which has to resolve to an
        // actual path outside app.asar. See electron-builder.yml's
        // extraResources entries that ship node_modules/esbuild and
        // node_modules/@esbuild/win32-x64 alongside the packaged app so this
        // require() still resolves at runtime once out/main/index.cjs lives
        // inside app.asar.
        external: ["esbuild"],
        input: {
          // The default single "index" entry only emits out/main/index.cjs.
          // src/deploy.ts's WorkerPool (see deployPipeline.ts, LEI-133) needs
          // a real, separately-loadable patchWorker file sitting next to it
          // at runtime (see resolvePatchWorkerPath() in deploy.ts, which
          // checks for both patchWorker.js and patchWorker.cjs since this
          // build and the CLI's own bun build name it differently) to hand
          // to `new Worker(...)` - a second entry here is what makes that
          // file actually exist in the bundled output.
          //
          // deployWorker/indexWorker follow the same pattern: each is a
          // self-contained worker_threads script that needs to be a
          // separately-loadable file next to index.cjs at runtime so
          // DeployManager/ModIndex can hand their path to `new Worker(...)`.
          // Without separate entries here those files would never exist in
          // out/main/ and Worker construction would fail silently at runtime.
          index: resolve(__dirname, "src/main/index.ts"),
          patchWorker: resolve(__dirname, "src/main/core/patchWorker.ts"),
          deployWorker: resolve(__dirname, "src/main/deployWorker.ts"),
          indexWorker: resolve(__dirname, "src/main/indexWorker.ts")
        },
        output: {
          // Force CJS instead of electron-vite's ESM default (this
          // package.json has "type": "module", which is otherwise auto
          // upgraded to "es"). Originally forced because the embedded
          // framework core (src/main/core) used to pull in the full `typescript`
          // package at runtime (ts.createProgram, used to compile mod
          // scripts - see analyseMod.ts/deploy.ts/discover.ts), which got
          // fully bundled into this same chunk (LEI-133's "no
          // externalizeDepsPlugin") - electron-vite's ESM output path runs
          // an esmShimPlugin that regex-scans the *entire* bundled chunk
          // for the last `import ... from "..."` text to decide where to
          // splice in a `__dirname`/`__filename`/`require` shim, and with
          // typescript.js's ~50k lines of source in the chunk (which
          // contained plenty of string literals/comments that read like
          // import statements, e.g. codefix diagnostic strings such as
          // "Convert named imports to default import"), that regex
          // reliably found a false-positive match *inside* a string
          // literal and spliced the shim there, truncating the string and
          // producing esbuild's "Unterminated string literal" transform
          // failure.
          //
          // `typescript` is gone now (LEI-139 replaced it with the external
          // esbuild above), so that specific false-positive is no
          // longer possible - but CJS is kept regardless: preload (below)
          // is forced to CJS for an unrelated, still-current reason
          // (Electron's sandboxed preload loader), and switching main back
          // to ESM would be a separate change nobody's asked for and hasn't
          // been tested against the worker entry points below. CJS output
          // skips esmShimPlugin entirely (it only runs `if (format ===
          // 'es')`) and needs no shim in the first place -
          // __dirname/__filename/require already work natively.
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
    plugins: [
      react(),
      // React Compiler (React 19's own reason for existing here - see package.json's doc comment)
      // via `reactCompilerPreset()` + `@rolldown/plugin-babel` - the combo React's own docs
      // recommend for `@vitejs/plugin-react >= 6.0.0` (that version removed the old inline
      // `babel.plugins` option outright). An earlier revision of this file reasoned that combo
      // didn't apply here because `@rolldown/plugin-babel` peer-depends on the Rolldown bundler
      // itself and this app "still runs on plain Rollup-based Vite" - that was wrong: Vite 8
      // (this project's `vite: ^8.1.5`) ships Rolldown as its one and only bundler
      // (rollupOptions above is kept purely as a compat alias for rolldownOptions), and `vite`
      // itself lists `rolldown` as a hard runtime dependency, not a peer left for the app to
      // provide. So this app has been on Rolldown since the vite@8 bump, and the Rolldown-native
      // plugin is the correct, officially-documented path - `vite-plugin-babel` was an unnecessary
      // bundler-agnostic detour based on a false premise.
      //
      // No `@babel/preset-typescript` needed either (unlike the old vite-plugin-babel setup):
      // `@rolldown/plugin-babel` already configures per-extension parserOpts internally
      // (`typescript`/`jsx` parser plugins for .ts/.tsx/.jsx) so it can parse this repo's TSX
      // without any extra preset wiring on our end.
      babel({ presets: [reactCompilerPreset()] })
    ]
  }
}))
