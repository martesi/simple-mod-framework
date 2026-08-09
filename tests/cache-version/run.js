// Focused regression tests for cache-version invalidation and external URL validation. They compile
// only the small, dependency-free DB/URL modules needed for this run, so no Electron shell or game
// install is required.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const testDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(testDir, "..", "..")
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "smf-cache-version-test-build-"))
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "smf-cache-version-test-cache-"))
let failures = 0

function check(name, fn) {
  try {
    fn()
    console.log(`  ok - ${name}`)
  } catch (error) {
    failures++
    console.error(`  FAIL - ${name}`)
    console.error(`    ${error instanceof Error ? error.stack : String(error)}`)
  }
}

try {
  const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc")
  execFileSync(
    process.execPath,
    [
      tscBin,
      "--ignoreConfig",
      "--module",
      "commonjs",
      "--target",
      "es2022",
      "--moduleResolution",
      "bundler",
      "--skipLibCheck",
      "--rootDir",
      path.join(root, "src"),
      "--outDir",
      buildDir,
      path.join(root, "src", "main", "db.ts"),
      path.join(root, "src", "shared", "urls.ts")
    ],
    { stdio: "inherit" }
  )

  const db = require(path.join(buildDir, "main", "db.js"))
  const { toHttpsUrl } = require(path.join(buildDir, "shared", "urls.js"))
  const dbPath = path.join(cacheDir, "cache.db")
  const artifactPath = path.join(cacheDir, "content_cache", "example.mod", "content", "artifact.bin")

  console.log("Running checks:")

  check("only canonical HTTPS URLs are accepted for external opening", () => {
    assert.equal(toHttpsUrl("https://example.com/updates"), "https://example.com/updates")
    assert.equal(toHttpsUrl("HTTPS://example.com/updates"), "https://example.com/updates")
    assert.equal(toHttpsUrl("http://example.com/updates"), undefined)
    assert.equal(toHttpsUrl("file:///tmp/update.json"), undefined)
    assert.equal(toHttpsUrl("javascript:alert(1)"), undefined)
    assert.equal(toHttpsUrl("not a URL"), undefined)
  })

  check("a cache-version mismatch invalidates derived DB state but retains content artifacts", () => {
    db.openDb(dbPath)
    assert.equal(db.getMeta("cacheVersion"), db.CACHE_VERSION)

    db.setMeta("modIndexBuilt", "1")
    db.setStoredGameInfo("/game", {
      retailPath: "/game/Retail",
      runtimePath: "/game/Runtime",
      platform: "steam"
    })
    db.upsertMod({
      id: "example.mod",
      folder: "Example Mod",
      isFrameworkMod: true,
      manifest: {
        id: "example.mod",
        name: "Example Mod",
        description: "test",
        authors: [],
        version: "1.0.0",
        frameworkVersion: "3.0.0"
      }
    })
    db.beginModBuild("example.mod")
    db.finishModBuildReady("example.mod", "3.0.0", '{"id":"example.mod"}')
    db.setRpkgHashCacheEntry("0123456789ABCDEF", "chunk0")
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
    fs.writeFileSync(artifactPath, "content-addressed artifact")

    // Simulate an app upgrade after it has written stale index/build/instruction state.
    db.setMeta("cacheVersion", "obsolete")
    db.closeDb()
    db.openDb(dbPath)

    assert.equal(db.getMeta("cacheVersion"), db.CACHE_VERSION)
    assert.equal(db.getMeta("modIndexBuilt"), undefined)
    assert.equal(db.getStoredGameInfo(), undefined)
    assert.equal(db.listMods().length, 0)
    assert.equal(db.getModBuild("example.mod"), undefined)
    assert.deepEqual(db.getRpkgHashCacheEntries(), {})
    assert.equal(fs.readFileSync(artifactPath, "utf8"), "content-addressed artifact")
  })

  check("matching cache versions preserve freshly persisted state", () => {
    db.upsertMod({ id: "current.mod", folder: "Current Mod", isFrameworkMod: false })
    db.closeDb()
    db.openDb(dbPath)
    assert.equal(db.getMod("current.mod")?.folder, "Current Mod")
  })
} finally {
  try {
    require(path.join(buildDir, "main", "db.js")).closeDb()
  } catch {
    // The module may not have compiled if setup failed.
  }
  fs.rmSync(buildDir, { recursive: true, force: true })
  fs.rmSync(cacheDir, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
