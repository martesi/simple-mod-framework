import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, isAbsolute, join, resolve } from "node:path"
import JSON5 from "json5"
import type { AppPaths } from "./paths"

/**
 * This app's persisted settings - one JSON file in `app.getPath('userData')` (see paths.ts),
 * written only by main and never hand-edited (LEI-133's "userData settings model").
 *
 * LEI-141's config split trims this down to genuinely machine-level state only: which game install,
 * which Mods folder, which temp dir, and this-computer UI preferences (theme/language/dev mode).
 * `loadOrder`/`modOrder`/`modOptions` moved out to `Mods/config.json` (see `modsConfig.ts`) - they're
 * about *this collection of mods*, not *this machine*, and need to travel with the Mods folder if a
 * user moves/backs it up/shares it. `knownMods` is gone entirely - it was a redundant shadow of
 * whatever `cache.db`'s `mods` table already tracks (`db.ts`'s `listMods()`), now that the db is the
 * real mod index instead of a rebuild-from-disk-on-launch convenience cache.
 */
export interface AppSettings {
	/** The folder containing the game's Retail executable (or its parent - `deriveGamePathInfo()` self-heals that) - the one thing the user picks via `config:pickGameDirectory`, or types directly into Settings. */
	gamePath: string

	/** Where mods are stored. Defaults to a "Mods" folder under `dataRoot` (userData) if unset - resolved via `resolveModsDir()`. */
	modsPath: string

	/**
	 * Explicit override for the temp dir (cache.db + staging/ + Output/ + the ephemeral working
	 * folders - see `resolveTempDir()`'s doc comment). Unset means "use the computed default" -
	 * under the game root for a genuinely fresh install, or `dataRoot` itself if a legacy
	 * pre-LEI-141 cache is already sitting there (existing installs are never silently relocated).
	 */
	tempPath?: string

	skipIntro: boolean
	outputToSeparateDirectory: boolean
	outputConfigToAppDataOnDeploy: boolean
	reportErrors?: boolean
	errorReportingID?: string | null
	developerMode: boolean

	// ---- UI-only extensions (not part of the real framework Config, never touched by the deploy pipeline) ----
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
		themeMode: "system",
		accent: "neutral",
		language: "en-US"
	}
}

/**
 * In-memory copy of settings.json, populated by the first `loadSettings()` call and kept in sync
 * by `saveSettings()` from then on - see the pre-LEI-141 version of this doc comment for the full
 * rationale (repeated, blocking disk reads on every settings-touching IPC call). Still the only
 * writer of settings.json in the whole app.
 */
let cachedSettings: AppSettings | null = null

/**
 * Read settings.json, creating a default one (empty `gamePath` - the setup wizard's "game" step
 * is what first populates it) if it's missing entirely. Old (pre-LEI-141) settings.json files may
 * still have `loadOrder`/`modOptions`/`modOrder`/`knownMods` sitting in them from before the config
 * split - those keys are silently ignored here (never read onto `AppSettings`) and `mergeSettings()`
 * never writes them back, so they age out of the file the next time anything else is saved. See
 * `modsConfig.ts`'s `migrateFromLegacySettings()` for where their *values* actually go on upgrade.
 */
export function loadSettings(paths: AppPaths): AppSettings {
	if (cachedSettings) return cachedSettings

	const file = settingsPath(paths)

	if (!existsSync(file)) {
		const fresh = defaultSettings()
		writeFileSync(file, JSON5.stringify(fresh, undefined, "\t"))
		cachedSettings = fresh
		return fresh
	}

	const parsed = JSON5.parse(readFileSync(file, "utf8"))
	const settings: AppSettings = { ...defaultSettings(), ...parsed }
	cachedSettings = settings
	return settings
}

export function saveSettings(paths: AppPaths, settings: AppSettings): void {
	writeFileSync(settingsPath(paths), JSON5.stringify(settings, undefined, "\t"))
	cachedSettings = settings
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

/**
 * True if a pre-LEI-141 install already has real data sitting in the legacy AppData cache location
 * (`dataRoot/cache/...`) - the signal `resolveTempDir()` uses to decide "this is an existing install,
 * keep using `dataRoot` as the temp dir" rather than silently relocating it to the new game-root
 * default. A completely fresh install has none of these.
 */
export function legacyTempDirHasData(paths: AppPaths): boolean {
	return existsSync(join(paths.dataRoot, "cache.db")) || existsSync(join(paths.dataRoot, "cache", "modIndex.json")) || existsSync(join(paths.dataRoot, "cache", "analysis")) || existsSync(join(paths.dataRoot, "cache", "map.json"))
}

/** Best-effort guess at the game's root folder (the one containing "Retail" and "Runtime") from the raw, possibly-unvalidated `gamePath` string - used only for the temp dir's default location, computed without touching the filesystem beyond a basename check, since a full validated derivation (`gameDetect.ts`'s `deriveGamePathInfo()`) needs the db this very function helps place. */
function guessGameRoot(gamePath: string): string {
	const resolved = resolve(gamePath)
	return basename(resolved).toLowerCase() === "retail" ? resolve(resolved, "..") : resolved
}

/**
 * Where the temp dir (cache.db, staging/, Output/, temp/, temp2/, qn-update/, tmp/) actually is.
 *
 * Default resolution (LEI-141's config split): a genuinely fresh install defaults to a folder under
 * the game's root (more disk headroom near the game itself, and the whole modded setup - Mods/ +
 * this - can be moved as one unit more easily than when part of it lives buried in AppData). An
 * existing install is never silently relocated: if the legacy AppData location already has real
 * cache data (`legacyTempDirHasData()`), that stays the effective default. A user's own explicit
 * `tempPath` override always wins over either default.
 */
export function resolveTempDir(paths: AppPaths, settings: AppSettings): string {
	if (settings.tempPath) return isAbsolute(settings.tempPath) ? settings.tempPath : resolve(paths.dataRoot, settings.tempPath)

	if (legacyTempDirHasData(paths)) return paths.dataRoot

	if (settings.gamePath) return join(guessGameRoot(settings.gamePath), "SMF Data")

	// No game picked yet (first-ever launch, before the setup wizard) and no legacy data either -
	// dataRoot is the only folder guaranteed to exist/be writable at this point.
	return paths.dataRoot
}

export interface DefaultUiPaths {
	/**
	 * A plausible example game folder, for placeholder text only - never validated or persisted,
	 * picking a real one is still on the user. Deliberately doesn't end in "\Retail": `gameDetect.ts`'s
	 * `deriveGamePathInfo()` accepts either the game's root folder or its Retail subfolder (self-healing
	 * the latter from the former), so showing "...\Retail" here reads as "you must type this exact
	 * subfolder" - which isn't true, and is exactly the mistake that's confused people picking the
	 * wrong folder (see gameDetect.ts's self-heal comment).
	 */
	gamePath: string
	/** Where this app would actually put its temp dir (cache.db, staging, etc.) if the user leaves the field untouched - see `resolveTempDir()`. Named `cachePath` to match the renderer's existing `Config`/`DefaultPaths` field (manifest-types.ts) rather than introducing a rename across the IPC boundary in this same change. */
	cachePath: string
	/** Same idea as `cachePath` - mirrors `resolveModsDir()`'s own default ("Mods" under `dataRoot`) when `modsPath` is unset. */
	modPath: string
}

/**
 * Computes the example paths the UI shows as placeholder text (Settings' Paths card, the setup
 * wizard) - `tempPath`/`modPath` here are the actual paths this app would use by default, so
 * they're both valid and already carry the real Windows username baked into `dataRoot` where
 * relevant - `gamePath` can't be known ahead of time, so it stays an illustrative guess.
 */
/**
 * Reads whatever `loadOrder`/`modOrder`/`modOptions` (and the now-fully-retired `knownMods`) happen
 * to still be sitting in settings.json's raw JSON, for `modsConfig.ts`'s one-time
 * `migrateFromLegacySettings()` to pick up on a pre-LEI-141 install's first launch after upgrading.
 * Deliberately bypasses `loadSettings()`/the typed `AppSettings` shape (which no longer declares
 * these fields at all - see this file's top doc comment) and re-reads the file directly instead, so
 * this keeps working even after `AppSettings` itself has long since dropped them from its type.
 */
export function readLegacyModListFields(paths: AppPaths): { loadOrder?: string[]; modOrder?: string[]; modOptions?: Record<string, string[]> } {
	const file = settingsPath(paths)
	if (!existsSync(file)) return {}

	try {
		const raw = JSON5.parse(readFileSync(file, "utf8")) as Record<string, unknown>
		return {
			loadOrder: Array.isArray(raw.loadOrder) ? (raw.loadOrder as string[]) : undefined,
			modOrder: Array.isArray(raw.modOrder) ? (raw.modOrder as string[]) : undefined,
			modOptions: raw.modOptions && typeof raw.modOptions === "object" ? (raw.modOptions as Record<string, string[]>) : undefined
		}
	} catch {
		return {}
	}
}

export function resolveDefaultUiPaths(paths: AppPaths, settings?: AppSettings): DefaultUiPaths {
	const programFiles = process.env["ProgramFiles(x86)"] ?? process.env["ProgramFiles"] ?? "C:\\Program Files (x86)"
	const exampleGamePath = join(programFiles, "Steam", "steamapps", "common", "HITMAN3")
	return {
		gamePath: exampleGamePath,
		cachePath: settings ? resolveTempDir(paths, settings) : resolve(paths.dataRoot),
		modPath: resolve(paths.dataRoot, "Mods")
	}
}
