// Focused regression tests for game-layout normalization, unknown-build handling, and the
// explicit storefront choice persisted in cache.db. These compile only the dependency-light
// detection/database modules, so no Electron shell or real game install is required.
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
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "smf-game-detection-test-build-"))
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "smf-game-detection-test-"))
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
      path.join(root, "src", "main", "gameDetect.ts"),
      path.join(root, "src", "shared", "game.ts")
    ],
    { stdio: "inherit" }
  )

  const db = require(path.join(buildDir, "main", "db.js"))
  const gameDetect = require(path.join(buildDir, "main", "gameDetect.js"))
  const dataRoot = path.join(scratchDir, "data")
  const gameRoot = path.join(scratchDir, "game")
  const retail = path.join(gameRoot, "Retail")
  const runtime = path.join(gameRoot, "Runtime")
  fs.mkdirSync(path.join(retail, "Runtime"), { recursive: true })
  fs.mkdirSync(runtime, { recursive: true })
  fs.writeFileSync(path.join(retail, "HITMAN3.exe"), "a build updated after the bundled hash table")
  fs.writeFileSync(path.join(runtime, "chunk0.rpkg"), "runtime")

  db.openDb(path.join(dataRoot, "cache.db"))

  check("unknown Steam/Epic builds remain unresolved instead of defaulting to Steam", () => {
    const result = gameDetect.deriveGamePathInfoUncached(gameRoot, { dataRoot, toolsRoot: path.join(scratchDir, "tools") })
    assert.equal(result.ok, true)
    assert.equal(result.platform, undefined)
    assert.equal(result.unrecognisedBuild, true)
    assert.equal(result.retailPath, path.resolve(retail))
    assert.equal(result.runtimePath, path.resolve(runtime))
  })

  check("an explicit storefront choice is persisted and reused", () => {
    const first = gameDetect.deriveGamePathInfo(gameRoot, { dataRoot, toolsRoot: path.join(scratchDir, "tools") }, "epic")
    assert.equal(first.ok, true)
    assert.equal(first.platform, "epic")
    assert.equal(db.getStoredGameInfo().platform, "epic")

    const cached = gameDetect.deriveGamePathInfo(gameRoot, { dataRoot, toolsRoot: path.join(scratchDir, "tools") })
    assert.equal(cached.ok, true)
    assert.equal(cached.platform, "epic")
  })

  check("a Microsoft Store root is normalized to Retail before layout detection", () => {
    db.clearStoredGameInfo()
    const microsoftRoot = path.join(scratchDir, "microsoft")
    const microsoftRetail = path.join(microsoftRoot, "Retail")
    fs.mkdirSync(path.join(microsoftRetail, "Runtime"), { recursive: true })
    fs.writeFileSync(path.join(microsoftRetail, "Runtime", "chunk0.rpkg"), "runtime")
    fs.writeFileSync(path.join(microsoftRoot, "MicrosoftGame.Config"), "an updated Microsoft config")
    fs.writeFileSync(path.join(microsoftRetail, "thumbs.dat"), "thumbs")

    const result = gameDetect.deriveGamePathInfoUncached(microsoftRoot, { dataRoot, toolsRoot: path.join(scratchDir, "tools") })
    assert.equal(result.ok, true)
    assert.equal(result.platform, undefined)
    assert.equal(result.unrecognisedBuild, true)
    assert.equal(result.retailPath, path.resolve(microsoftRetail))
    assert.equal(result.runtimePath, path.resolve(microsoftRetail, "Runtime"))
  })
} finally {
  try {
    require(path.join(buildDir, "main", "db.js")).closeDb()
  } catch {
    // The module may not have compiled if setup failed.
  }
  fs.rmSync(buildDir, { recursive: true, force: true })
  fs.rmSync(scratchDir, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
