import type { Config } from "../renderer/src/lib/manifest-types"
import type { DiskConfig } from "./diskConfig"

/**
 * Translates between the on-disk config.json shape (compatible with the
 * CLI/deployer's real `Config` in `src/types.ts`) and the UI-facing `Config`
 * shape the renderer already codes against (`manifest-types.ts`, pinned down
 * in LEI-137).
 *
 * `gamePath`/`modPath` <-> `retailPath`/`modsPath` are just renames - the UI
 * uses friendlier names than the CLI's historical ones. `cachePath` and
 * `runtimePath` are not yet reconciled with a real relocatable dataRoot
 * (that's LEI-133's "userData settings" scope); `cachePath` round-trips as a
 * plain string for now and `runtimePath` is derived from `retailPath` the
 * same way `src/core.ts`'s `createCore()` does for the historical default.
 */
export function toUiConfig(disk: DiskConfig): Config {
  return {
    loadOrder: disk.loadOrder,
    modOrder: disk.modOrder?.length ? disk.modOrder : disk.knownMods,
    knownMods: disk.knownMods,
    modOptions: disk.modOptions,
    developerMode: disk.developerMode,
    reportErrors: disk.reportErrors,
    themeMode: disk.themeMode ?? "system",
    accent: disk.accent ?? "neutral",
    gamePath: disk.retailPath,
    cachePath: disk.cachePath ?? "",
    modPath: disk.modsPath,
    language: disk.language ?? "en-US"
  }
}

/** Inverse of {@link toUiConfig} for a `Partial<Config>` patch coming from `config:merge`. */
export function fromUiPatch(patch: Partial<Config>): Partial<DiskConfig> {
  const out: Partial<DiskConfig> = {}

  if (patch.loadOrder !== undefined) out.loadOrder = patch.loadOrder
  if (patch.modOrder !== undefined) out.modOrder = patch.modOrder
  if (patch.knownMods !== undefined) out.knownMods = patch.knownMods
  if (patch.modOptions !== undefined) out.modOptions = patch.modOptions
  if (patch.developerMode !== undefined) out.developerMode = patch.developerMode
  if (patch.reportErrors !== undefined) out.reportErrors = patch.reportErrors
  if (patch.themeMode !== undefined) out.themeMode = patch.themeMode
  if (patch.accent !== undefined) out.accent = patch.accent
  if (patch.cachePath !== undefined) out.cachePath = patch.cachePath
  if (patch.language !== undefined) out.language = patch.language

  if (patch.gamePath !== undefined) {
    out.retailPath = patch.gamePath
    // Best-effort default, matching src/core.ts's historical "..\\Runtime"
    // convention - a real per-install Runtime detection is out of scope here
    // (see the doc comment on DiskConfig.cachePath / LEI-133).
    out.runtimePath = patch.gamePath ? `${patch.gamePath}\\Runtime` : "..\\Runtime"
  }

  if (patch.modPath !== undefined) out.modsPath = patch.modPath

  return out
}
