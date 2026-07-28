import type { Config } from "../renderer/src/lib/manifest-types"
import type { AppSettings } from "./settings"

/**
 * Translates between `settings.ts`'s on-disk `AppSettings` shape (compatible with the framework
 * core's real `Config` in `src/types.ts` - see `deployPipeline.ts`'s `buildFrameworkConfig()`) and
 * the UI-facing `Config` shape the renderer already codes against (`manifest-types.ts`, pinned
 * down in LEI-137).
 *
 * `gamePath` is a straight passthrough now (LEI-133): both sides mean "the folder containing the
 * game's Retail executable" - `retailPath` is just `gamePath` resolved to an absolute path (see
 * `gameDetect.ts`'s `deriveGamePathInfo()`), so the UI never needs to know that name at all.
 * `runtimePath`/`platform` are derived the same way and are UI-invisible (deploy-only concerns).
 */
export function toUiConfig(settings: AppSettings): Config {
	return {
		loadOrder: settings.loadOrder,
		modOrder: settings.modOrder?.length ? settings.modOrder : settings.knownMods,
		knownMods: settings.knownMods,
		modOptions: settings.modOptions,
		developerMode: settings.developerMode,
		reportErrors: settings.reportErrors,
		themeMode: settings.themeMode ?? "system",
		accent: settings.accent ?? "neutral",
		gamePath: settings.gamePath,
		cachePath: settings.cachePath ?? "",
		modPath: settings.modsPath,
		language: settings.language ?? "en-US"
	}
}

/** Inverse of {@link toUiConfig} for a `Partial<Config>` patch coming from `config:merge`. */
export function fromUiPatch(patch: Partial<Config>): Partial<AppSettings> {
	const out: Partial<AppSettings> = {}

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

	// `gamePath` itself always round-trips as typed - `ipcHandlers.ts`'s `config:merge` handler is
	// the one that additionally tries to re-derive retailPath/runtimePath/platform from it (via
	// gameDetect.ts) whenever it changes, the same way `config:pickGameDirectory` does for a picked
	// folder. Kept out of this pure mapping function since deriving needs filesystem access
	// (AppPaths) that this module deliberately doesn't have.
	if (patch.gamePath !== undefined) out.gamePath = patch.gamePath

	if (patch.modPath !== undefined) out.modsPath = patch.modPath

	return out
}
