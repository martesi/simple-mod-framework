import type { Config } from "../renderer/src/lib/manifest-types"
import type { AppSettings } from "./settings"
import { resolveModsDir, resolveTempDir } from "./settings"
import type { AppPaths } from "./paths"
import type { ModsConfig } from "./modsConfig"

/**
 * Translates between this app's two on-disk config sources - `settings.ts`'s machine-level
 * `AppSettings` and `modsConfig.ts`'s portable, Mods-folder-local `ModsConfig` (LEI-141's config
 * split) - and the single UI-facing `Config` shape the renderer already codes against
 * (`manifest-types.ts`, pinned down in LEI-137). The renderer doesn't need to know its `loadOrder`
 * field actually lives in a different file on disk than its `themeMode` field - `toUiConfig()`/
 * `fromUiPatch()` are the only place that split is visible.
 *
 * `gamePath` is a straight passthrough (LEI-133): both sides mean "the folder containing the
 * game's Retail executable" - `retailPath` is just `gamePath` resolved to an absolute path (see
 * `gameDetect.ts`'s `deriveGamePathInfo()`), so the UI never needs to know that name at all.
 * `runtimePath`/`platform` are derived the same way and are UI-invisible (deploy-only concerns).
 */
export function toUiConfig(settings: AppSettings, modsConfig: ModsConfig, paths: AppPaths): Config {
	return {
		loadOrder: modsConfig.loadOrder,
		modOrder: modsConfig.modOrder,
		// `knownMods` is gone from both AppSettings and ModsConfig (LEI-141 - cache.db's `mods` table
		// is the real membership list now), but the renderer's `Config` shape still has the field
		// (LEI-137 predates this split) - derive it from modOrder, which every known mod (enabled or
		// not) ends up in via `modsConfig.ts`'s `addNewlyKnownMods()`.
		knownMods: modsConfig.modOrder,
		modOptions: modsConfig.modOptions,
		developerMode: settings.developerMode,
		reportErrors: settings.reportErrors,
		themeMode: settings.themeMode ?? "system",
		accent: settings.accent ?? "neutral",
		gamePath: settings.gamePath,
		// `cachePath` in the renderer's Config type now reflects the resolved temp dir (see
		// settings.ts's resolveTempDir()) rather than the old, never-actually-wired-up `cachePath`
		// setting - same field name for now to avoid a renderer-side rename in this same change.
		cachePath: resolveTempDir(paths, settings),
		// Resolved through resolveModsDir() rather than a straight passthrough of settings.modsPath -
		// see the pre-LEI-141 version of this comment for why (the on-disk default is the bare
		// relative string "Mods", which PathInputRow would otherwise render verbatim as literal text
		// instead of a real location).
		modPath: resolveModsDir(paths, settings),
		language: settings.language ?? "en-US"
	}
}

export interface ConfigPatchSplit {
	settingsPatch: Partial<AppSettings>
	modsConfigPatch: Partial<ModsConfig>
}

/** Inverse of {@link toUiConfig} for a `Partial<Config>` patch coming from `config:merge` - splits it into the two files it actually needs to be written to. */
export function fromUiPatch(patch: Partial<Config>): ConfigPatchSplit {
	const settingsPatch: Partial<AppSettings> = {}
	const modsConfigPatch: Partial<ModsConfig> = {}

	if (patch.loadOrder !== undefined) modsConfigPatch.loadOrder = patch.loadOrder
	if (patch.modOrder !== undefined) modsConfigPatch.modOrder = patch.modOrder
	if (patch.modOptions !== undefined) modsConfigPatch.modOptions = patch.modOptions
	// patch.knownMods is intentionally never written anywhere - see toUiConfig()'s doc comment, it's
	// derived from modOrder on the way out and has no independent existence to persist on the way in.

	if (patch.developerMode !== undefined) settingsPatch.developerMode = patch.developerMode
	if (patch.reportErrors !== undefined) settingsPatch.reportErrors = patch.reportErrors
	if (patch.themeMode !== undefined) settingsPatch.themeMode = patch.themeMode
	if (patch.accent !== undefined) settingsPatch.accent = patch.accent
	if (patch.cachePath !== undefined) settingsPatch.tempPath = patch.cachePath
	if (patch.language !== undefined) settingsPatch.language = patch.language

	// `gamePath` itself always round-trips as typed - `ipcHandlers.ts`'s `config:merge` handler is
	// the one that additionally triggers a (one-shot, cache.db-persisted) re-derive of
	// retailPath/runtimePath/platform from it whenever it changes, the same way
	// `config:pickGameDirectory` does for a picked folder. Kept out of this pure mapping function
	// since deriving needs filesystem/db access this module deliberately doesn't have.
	if (patch.gamePath !== undefined) settingsPatch.gamePath = patch.gamePath

	if (patch.modPath !== undefined) settingsPatch.modsPath = patch.modPath

	return { settingsPatch, modsConfigPatch }
}
