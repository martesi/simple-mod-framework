// Standalone, dependency-free regression test for src/main/core/typescript.ts's compile()
// (LEI-139: swapped ts.createProgram/emit for esbuild's transform() - native
// `esbuild`, not `esbuild-wasm`, see src/main/core/typescript.ts's doc comment for why).
//
// This intentionally does NOT go through discover.ts/analyseMod.ts/deploy.ts,
// a real manifest, or a real mod install - all of that pulls in RPKG tooling,
// a game install, and a dozen other subsystems that have nothing to do with
// whether the transpiler itself still works. This isolates exactly the piece
// that changed: given mod script source files, does compile() still produce
// correct, runnable CommonJS, is the rootDir-escape guard still enforced, is
// the content-addressed cache still working, and is esbuild genuinely only
// loaded on a cache miss (not eagerly, not on every call)?
//
// Usage: node tests/typescript-compile/run.js
// Requires: `esbuild` (+ its platform binary, e.g. @esbuild/win32-x64)
// installed in the root node_modules (real dependency as of LEI-139) and the
// `typescript` devDependency already pinned in package.json (used here only
// to JIT-compile src/main/core/typescript.ts itself for the test run - nothing to
// do with the mod-script transpiler being tested).
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// compile()'s own output, and the tsc-compiled copy of typescript.ts below,
// are both plain CommonJS (esbuild --format cjs / tsc --module commonjs) -
// this repo's package.json says "type": "module", so a real `require` (not a
// bare import) is what's needed to load them, cache-busting included.
const require = createRequire(import.meta.url)

const root = path.join(__dirname, '..', '..')
const fixturesDir = path.join(__dirname, 'fixtures')
const modDir = path.join(fixturesDir, 'mod')

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ok - ${name}`)
  } catch (e) {
    failures++
    console.error(`  FAIL - ${name}`)
    console.error(`    ${e?.stack ? e.stack.replace(/\n/g, '\n    ') : e}`)
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    console.log(`  ok - ${name}`)
  } catch (e) {
    failures++
    console.error(`  FAIL - ${name}`)
    console.error(`    ${e?.stack ? e.stack.replace(/\n/g, '\n    ') : e}`)
  }
}

async function main() {
  // --- Step 1: build src/main/core/typescript.ts with the project's own pinned
  // tsc, just scoped to this one file so the test doesn't need a full
  // project build first. ---
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smf-typescript-compile-test-'))
  const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')

  console.log('Compiling src/main/core/typescript.ts for the test run...')
  execFileSync(
    process.execPath,
    // --moduleResolution node (aka "node10") is deprecated-to-error as of TypeScript 6.0 - see
    // package.json's typescript devDependency doc comment. TS 6.0's own migration guidance is
    // "nodenext" for code targeting Node directly, or "bundler" for `--module commonjs`/esnext
    // output resolved by something other than Node's own resolver - this repo's `--module
    // commonjs` here is exactly that latter case (TS 6 quietly made "bundler" the resolution
    // --module commonjs gets by default now anyway), and "nodenext" would additionally require
    // `--module` to also be node16/nodenext, which would change this test's deliberately-CJS
    // output.
    [
      tscBin,
      '--ignoreConfig',
      '--module',
      'commonjs',
      '--target',
      'es2019',
      '--esModuleInterop',
      '--moduleResolution',
      'bundler',
      '--skipLibCheck',
      '--outDir',
      buildDir,
      path.join(root, 'src', 'main', 'core', 'typescript.ts'),
    ],
    { stdio: 'inherit' }
  )

  const builtPath = path.join(buildDir, 'typescript.js')
  assert.ok(
    fs.existsSync(builtPath),
    'expected src/main/core/typescript.ts to compile to typescript.js'
  )

  // esbuild resolves relative to the *compiled file's own location* via
  // normal node_modules upward search - buildDir is outside the project, so
  // point NODE_PATH at the real root node_modules for this process (same
  // trick used to manually verify this before committing the test).
  const Module = require('node:module')
  process.env.NODE_PATH =
    path.join(root, 'node_modules') +
    (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '')
  Module._initPaths()

  const { compile } = require(builtPath)

  // Fresh cache dir per test run so "cold" actually means cold.
  const cacheRoot = path.join(os.tmpdir(), 'simple-mod-framework', 'script-cache')
  fs.rmSync(cacheRoot, { recursive: true, force: true })

  console.log('\nRunning checks:')

  let entryPath
  await checkAsync(
    'compiles TS (types/interfaces stripped, enum + cross-file import/export intact) and produces runnable output',
    async () => {
      const fileNames = [path.join(modDir, 'main.ts'), path.join(modDir, 'helper.ts')]
      entryPath = await compile(fileNames, { target: 'es2019' }, modDir)
      assert.ok(fs.existsSync(entryPath), `expected compiled entry file to exist at ${entryPath}`)

      delete require.cache[require.resolve(entryPath)]
      const mod = require(entryPath)
      const result = await mod.analysis({ name: 'Roger', count: 3 })
      assert.strictEqual(
        result,
        'HELLO, ROGER (X3)!',
        'enum/import/export/type-stripping produced wrong runtime output'
      )
    }
  )

  check(
    'output was actually produced by esbuild (not some other transpiler silently matching behavior)',
    () => {
      const code = fs.readFileSync(entryPath, 'utf8')
      // __toCommonJS/__export are esbuild's own cjs-interop helper names - not
      // something ts.createProgram's output ever contained (it used
      // __importStar/__importDefault instead - see this test's own build step
      // above for what *that* looks like, for contrast).
      assert.ok(
        /__toCommonJS/.test(code) && /__export/.test(code),
        "expected esbuild's characteristic cjs interop helpers in the output"
      )
    }
  )

  await checkAsync(
    'cache hit: identical inputs return the same path without recompiling',
    async () => {
      const fileNames = [path.join(modDir, 'main.ts'), path.join(modDir, 'helper.ts')]
      const start = Date.now()
      const entryPath2 = await compile(fileNames, { target: 'es2019' }, modDir)
      const elapsedMs = Date.now() - start
      assert.strictEqual(
        entryPath2,
        entryPath,
        'cache hit returned a different path than the original compile'
      )
      // The cold compile above genuinely spawns esbuild's subprocess (hundreds
      // of ms). A cache hit does a content hash + fs.existsSync and returns -
      // if esbuild got reloaded/re-invoked here, this would be slow too.
      // Generous threshold to avoid sandbox-speed flakiness.
      assert.ok(
        elapsedMs < 100,
        `expected a cache hit to be near-instant, took ${elapsedMs}ms - esbuild may be getting re-invoked unnecessarily`
      )
    }
  )

  await checkAsync(
    'changing a source file invalidates the cache (different hash, different entry)',
    async () => {
      const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smf-typescript-compile-test-mod-'))
      const scratchFile = path.join(scratchDir, 'main.ts')
      fs.writeFileSync(scratchFile, `export async function analysis() { return "v1" }\n`)

      const pathV1 = await compile([scratchFile], { target: 'es2019' }, scratchDir)
      fs.writeFileSync(scratchFile, `export async function analysis() { return "v2" }\n`)
      const pathV2 = await compile([scratchFile], { target: 'es2019' }, scratchDir)

      assert.notStrictEqual(
        pathV1,
        pathV2,
        'expected changing source content to produce a different cache entry'
      )
      delete require.cache[require.resolve(pathV2)]
      const result = await require(pathV2).analysis()
      assert.strictEqual(result, 'v2', 'recompiled output did not reflect the updated source')
    }
  )

  await checkAsync(
    'rootDir-escape guard still rejects a script outside its mod folder',
    async () => {
      // Written under os.tmpdir(), not fixturesDir - a scratch file outside
      // rootDir that we then delete has nothing to do with the fixtures
      // checked into the repo, and keeps this test's cleanup off of whatever
      // filesystem the repo itself happens to be sitting on.
      const outsideDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'smf-typescript-compile-test-outside-')
      )
      const outsideFile = path.join(outsideDir, 'outside.ts')
      fs.writeFileSync(
        outsideFile,
        `export async function analysis() { return "should never run" }\n`
      )
      try {
        await compile([outsideFile], { target: 'es2019' }, modDir)
        assert.fail('expected compile() to throw for a fileName outside rootDir')
      } catch (e) {
        assert.ok(
          /escapes its mod folder/.test(e.message),
          `expected the escape-guard error, got: ${e.message}`
        )
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true })
      }
    }
  )

  fs.rmSync(buildDir, { recursive: true, force: true })
  fs.rmSync(cacheRoot, { recursive: true, force: true })

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('Test runner crashed:', e)
  process.exit(1)
})
