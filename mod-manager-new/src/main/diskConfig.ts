import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import JSON5 from "json5"
import type { AppPaths } from "./paths"

/**
 * config.json, as read/written on disk. This is a superset of the real
 * framework Config (`src/types.ts` at the repo root) - the CLI/deployer only
 * knows about the fields it declares there, but config.json is parsed with
 * JSON5 and extra keys are harmless, so this manager's own UI-only settings
 * (window theme, manual mod shelf order, etc.) live in the same file instead
 * of a second one to keep in sync.
 *
 * Deliberately not importing `src/types.ts`'s `Config` directly - this
 * package is meant to build/typecheck standalone (see manifest-types.ts),
 * and this manager only ever touches a handful of these fields itself.
 */
export interface DiskConfig {
  runtimePath: string
  retailPath: string
  modsPath: string
  skipIntro: boolean
  outputToSeparateDirectory: boolean
  outputConfigToAppDataOnDeploy: boolean
  reportErrors?: boolean
  errorReportingID?: string | null
  developerMode: boolean
  knownMods: string[]
  loadOrder: string[]
  modOptions: Record<string, string[]>
  platform?: "steam" | "epic" | "microsoft"

  // ---- UI-only extensions (ignored by the CLI/deployer, never removed by it either) ----
  /** Manual shelf order for every known mod, enabled or not - see manifest-types.ts's Config.modOrder doc comment. */
  modOrder?: string[]
  /** Where extracted RPKG data / intermediate build files should conceptually live. Not yet wired to a real dataRoot relocation - see LEI-133. */
  cachePath?: string
  themeMode?: "light" | "dark" | "system"
  accent?: "neutral" | "blue" | "violet" | "green" | "red"
  language?: string
}

export function configPath(paths: AppPaths): string {
  return join(paths.dataRoot, "config.json")
}

function defaultConfig(): DiskConfig {
  return {
    runtimePath: "..\\Runtime",
    retailPath: "..\\Retail",
    modsPath: "Mods",
    skipIntro: false,
    outputToSeparateDirectory: false,
    outputConfigToAppDataOnDeploy: false,
    developerMode: false,
    knownMods: [],
    loadOrder: [],
    modOptions: {},
    modOrder: [],
    cachePath: "",
    themeMode: "system",
    accent: "neutral",
    language: "en-US"
  }
}

/**
 * Read config.json, creating a default one (matching the CLI's own historical
 * defaults) if it's missing entirely - a fresh install/dev checkout has no
 * config.json yet, and the UI needs *something* to render before the setup
 * wizard has run, not a thrown error.
 */
export function loadDiskConfig(paths: AppPaths): DiskConfig {
  const file = configPath(paths)

  if (!existsSync(file)) {
    const fresh = defaultConfig()
    writeFileSync(file, JSON5.stringify(fresh, undefined, "\t"))
    return fresh
  }

  const parsed = JSON5.parse(readFileSync(file, "utf8"))
  return { ...defaultConfig(), ...parsed }
}

export function saveDiskConfig(paths: AppPaths, config: DiskConfig): void {
  writeFileSync(configPath(paths), JSON5.stringify(config, undefined, "\t"))
}

/** Shallow-merge a patch into config.json and return the resulting full config - mirrors the old `mergeConfig()`. */
export function mergeDiskConfig(paths: AppPaths, patch: Partial<DiskConfig>): DiskConfig {
  const current = loadDiskConfig(paths)
  const next: DiskConfig = { ...current, ...patch }
  saveDiskConfig(paths, next)
  return next
}

/** Where Mods/ actually is, resolved against dataRoot if `modsPath` isn't already absolute - mirrors `src/core.ts`'s `createCore()`. */
export function resolveModsDir(paths: AppPaths, disk: DiskConfig): string {
  return isAbsolute(disk.modsPath) ? disk.modsPath : resolve(paths.dataRoot, disk.modsPath)
}
