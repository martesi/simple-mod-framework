import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import JSON5 from "json5"
import type { AppPaths } from "./paths"

/**
 * This app's persisted settings - one JSON file in `app.getPath('userData')` (see paths.ts),
 * written only by main and never hand-edited (LEI-133's "userData settings model").
 *
 * Replaces the old `config.json`-in-`dataRoot` convention this file used to implement (as
 * `DiskConfig`/`loadDiskConfig`/etc. - see git history), which mirrored the CLI's on-disk
 * config.json 1:1 so Deploy.exe could read it directly. Now that the framework core runs
 * in-process (`deployPipeline.ts` builds a `Config` object in memory from this file and passes it
 * straight to `createCore()`), there's no subprocess left that needs a config.json on disk -
 * "mod scripts already receive config as an in-memory object via `ModContext.config`, so there's
 * no file-based convention to preserve once truly embedded" (LEI-133's description).
 *
 * This is a superset of the real framework `Config` (`src/types.ts` at the repo root, see
 * `deployPipeline.ts`'s `buildFrameworkConfig()`) plus this app's own UI-only preferences (window
 * theme, manual mod shelf order, etc.), kept in the same file rather than a second one to keep in
 * sync - `gamePath` is the only thing about the game install persisted here (the one thing the
 * user actually picks, via `config:pickGameDirectory`, or types directly). `retailPath`/
 * `runtimePath`/`platform` are *not* stored - they're re-derived from `gamePath` on demand, every
 * time they're needed (picker validation, deploy start, analyseMod), by `gameDetect.ts`'s
 * `deriveGamePathInfo()`. This means a game update/reinstall that changes which of those a path
 * resolves to never leaves a stale derived value sitting in settings.json - there's only ever one
 * source of truth (`gamePath`) to keep in sync.
 */
export interface AppSettings {
	/** The folder containing the game's Retail executable (or its parent - `deriveGamePathInfo()` self-heals that) - the one thing the user picks via `config:pickGameDirectory`, or types directly into Settings. */
	gamePath: string

	/** Where mods are stored. Defaults to a "Mods" folder under `dataRoot` (userData) if unset - resolved via `resolveModsDir()`. */
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

	// ---- UI-only extensions (not part of the real framework Config, never touched by the deploy pipeline) ----
	/** Manual shelf order for every known mod, enabled or not - see manifest-types.ts's Config.modOrder doc comment. */
	modOrder?: string[]
	/** Where extracted RPKG data / intermediate build files should conceptually live. Not yet wired to a real dataRoot relocation. */
	cachePath?: string
	themeMode?: "light" | "dark" | "system"
	accent?: "neutral" | "blue" | "violet" | "green" | "red"
	language?: string
}

export function settingsPath(paths: AppPaths): string {
	return join(paths.dataRoot, "settings.json")
}

function defaultSettings(): AppSettings {
	return {
		gamePath: "",
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
 * Read settings.json, creating a default one (empty `gamePath` - the setup wizard's "game" step
 * is what first populates it) if it's missing entirely - a fresh install has no settings yet, and
 * the UI needs *something* to render before the wizard has run, not a thrown error.
 */
export function loadSettings(paths: AppPaths): AppSettings {
	const file = settingsPath(paths)

	if (!existsSync(file)) {
		const fresh = defaultSettings()
		writeFileSync(file, JSON5.stringify(fresh, undefined, "\t"))
		return fresh
	}

	const parsed = JSON5.parse(readFileSync(file, "utf8"))
	return { ...defaultSettings(), ...parsed }
}

export function saveSettings(paths: AppPaths, settings: AppSettings): void {
	writeFileSync(settingsPath(paths), JSON5.stringify(settings, undefined, "\t"))
}

/** Shallow-merge a patch into settings.json and return the resulting full settings - mirrors the old `mergeDiskConfig()`. */
export function mergeSettings(paths: AppPaths, patch: Partial<AppSettings>): AppSettings {
	const current = loadSettings(paths)
	const next: AppSettings = { ...current, ...patch }
	saveSettings(paths, next)
	return next
}

/** Where Mods/ actually is, resolved against dataRoot if `modsPath` isn't already absolute - mirrors `src/core.ts`'s `createCore()`. */
export function resolveModsDir(paths: AppPaths, settings: AppSettings): string {
	return isAbsolute(settings.modsPath) ? settings.modsPath : resolve(paths.dataRoot, settings.modsPath)
}
