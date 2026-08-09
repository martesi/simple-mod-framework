import { afterAll, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadSettings, mergeSettings, resolveModsDir, resolveTempDir } from "../src/main/settings"

const dataRoot = join(tmpdir(), `smf-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const paths = { dataRoot, toolsRoot: join(dataRoot, "tools") }
const gameRoot = join(dataRoot, "game")
mkdirSync(dataRoot, { recursive: true })

test("game-root defaults resolve consistently for root and Retail paths", () => {
  const settings = { ...loadSettings(paths), gamePath: gameRoot }
  expect(resolveTempDir(paths, settings)).toBe(join(gameRoot, ".smf", "tmp"))
  expect(resolveModsDir(paths, settings)).toBe(join(gameRoot, ".smf", "mods"))
  expect(resolveTempDir(paths, { ...settings, gamePath: join(gameRoot, "Retail") })).toBe(join(gameRoot, ".smf", "tmp"))
  expect(resolveModsDir(paths, { ...settings, gamePath: join(gameRoot, "Retail") })).toBe(join(gameRoot, ".smf", "mods"))
})

test("merging an undefined platform removes the explicit storefront choice", () => {
  mergeSettings(paths, { gamePlatform: "epic" })
  expect(loadSettings(paths).gamePlatform).toBe("epic")
  mergeSettings(paths, { gamePlatform: undefined })
  expect(loadSettings(paths).gamePlatform).toBeUndefined()
})

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})
