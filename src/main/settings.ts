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
 * In-memory copy of settings.json, populated by the first `loadSettings()` call and kept in sync
 * by `saveSettings()` from then on. Safe to cache indefinitely (no TTL, no re-read-just-in-case)
 * because this module is the *only* writer of settings.json in the whole app - `saveSettings()`/
 * `mergeSettings()` here are the one place a write happens (see this file's top doc comment: "never
 * hand-edited"). Nothing else in this process, and no other process, can change the file out from
 * under this cache.
 *
 * Before this, `loadSettings()` did a fresh `existsSync` + `readFileSync` + `JSON5.parse` on every
 * single call - and it's called *a lot* more often than "the user changed a setting": every
 * `config:get`, every `mods:list`'s `getModsDir()`, and worst of all every single `smf-mod://`
 * image request (`modImages.ts`'s `currentModsRoot()`), since that closure is exactly
 * `resolveModsDir(paths, loadSettings(paths))`. Opening the settings drawer fires one of those per
 * visible thumbnail; switching a radio option fires another for the new preview image. All of it
 * synchronous, all of it on the one thread that also pumps Electron's window/input messages - a
 * burst of a few dozen blocking disk reads in a row is exactly what made the drawer, option
 * switching, and even an unrelated dialog's close button all feel laggy at the same time. Caching
 * removes the repeated I/O entirely instead of just making it non-blocking.
 */
let cachedSettings: AppSettings | null = null

/**
 * Read settings.json, creating a default one (empty `gamePath` - the setup wizard's "game" step
 * is what first populates it) if it's missing entirely - a fresh install has no settings yet, and
 * the UI needs *something* to render before the wizard has run, not a thrown error.
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

/** Structural subset of both `ManifestOption` (manifest-types.ts) and `DiskManifestOption` (diskManifest.ts) - `addKnownMods()`'s callers pass either, and this file avoids importing either type to stay decoupled (see this file's top doc comment). */
interface OptionLike {
	name: string
	type: string
	group?: string
	enabledByDefault?: boolean
}

/** What `addKnownMods()` needs from each mod to seed default options - just an id for RPKG-only mods (no manifest at all). */
export interface KnownModInput {
	id: string
	manifest?: { options?: OptionLike[] }
}

/**
 * Fills in `modOptions[mod.id]` for any mod that doesn't have an entry yet (`undefined` - a mod the
 * user has never opened the options drawer for, distinct from `[]`, which means they opened it and
 * deliberately left everything unchecked). Never touches a mod that already has a real entry, so a
 * user's actual choices - including "nothing selected" - are never overwritten.
 *
 * Mirrors `Mod Manager/src/lib/utils.ts`'s old `getConfig()` validation block, which ran this same
 * seeding on every single config read. That block got dropped when config validation was split out
 * of a single monolithic `getConfig()` for this rewrite - mods with `manifest.options` were left with
 * `modOptions[id]` staying `undefined` forever, which `src/discover.ts`'s option-merging silently
 * treats as "no option content, base mod only" (no error, no warning - see the option-merge `if` at
 * `discover.ts:145`) - a deployed mod quietly missing whatever content lived behind the never-selected
 * option.
 *
 * For each select-type option group, prefers whichever option the manifest flags
 * `enabledByDefault` - falling back to the first-listed option in that group if none is flagged,
 * since `validateModFolder` only enforces "at most one `enabledByDefault` per group", not "at least
 * one", and a group with zero selections is exactly the same silent-gap bug either way. Checkboxes
 * only get pre-checked when the manifest explicitly flags them `enabledByDefault` - unlike select
 * groups, a checkbox has an "off" state that's already a valid, meaningful default.
 *
 * Returns `undefined` (rather than a same-as-before object) when nothing needed seeding, so
 * `addKnownMods()` can skip writing settings.json back out on the very common call where every mod
 * it's passed is already fully configured.
 */
function seedDefaultModOptions(modOptions: Record<string, string[]>, mods: KnownModInput[]): Record<string, string[]> | undefined {
	let changed = false
	const next = { ...modOptions }

	for (const mod of mods) {
		const options = mod.manifest?.options
		if (!options?.length || next[mod.id] !== undefined) continue

		const picks: string[] = []

		for (const o of options) {
			if (o.type === "checkbox" && o.enabledByDefault) picks.push(o.name)
		}

		const groups = new Map<string, OptionLike[]>()
		for (const o of options) {
			if (o.type === "select" && o.group) {
				const arr = groups.get(o.group) ?? []
				arr.push(o)
				groups.set(o.group, arr)
			}
		}
		for (const [group, groupOptions] of groups) {
			const chosen = groupOptions.find((o) => o.enabledByDefault) ?? groupOptions[0]
			picks.push(`${group}:${chosen.name}`)
		}

		next[mod.id] = picks
		changed = true
	}

	return changed ? next : undefined
}

/**
 * Write-through for mods the `ModIndex` just learned about (a fresh install via `mods:beginAdd`,
 * or ones turned up by `mods:rebuildIndex`) - registers them in `knownMods` and, critically, in
 * `modOrder` too, not just the former. Also seeds default `modOptions` for any of them that don't
 * have a selection yet (see `seedDefaultModOptions()`) - the same "mod just became known" moment is
 * also the right moment to give it a sane default option, so both self-heals live in one write-through
 * instead of two separate ones that could drift out of sync.
 *
 * Without the `knownMods`/`modOrder` half, a newly-installed mod's ID exists only in the in-memory
 * `ModIndex` (see `modIndex.ts`'s `addFolders()`) and never reaches `settings.json` at all.
 * `configMapping.ts`'s `toUiConfig()` only falls back to `knownMods` for `modOrder` while `modOrder`
 * is still empty; the first drag-reorder (`app-store.ts`'s `reorderMods()`) persists a *complete*
 * `modOrder` snapshot of every mod loaded at that moment, and from then on new mods are permanently
 * absent from it. Since `toggleMod()`'s enable branch (`app-store.ts`) builds the new `loadOrder` by
 * filtering `config.modOrder` down to "this mod or already-enabled ones", a mod missing from
 * `modOrder` can never be filtered *in* - flipping its switch silently produces the same `loadOrder`
 * it started with. Keeping `modOrder` populated incrementally, right alongside `knownMods`, closes
 * that gap instead of only patching the fallback case.
 */
export function addKnownMods(paths: AppPaths, mods: KnownModInput[]): AppSettings {
	const current = loadSettings(paths)
	const newIds = mods.map((m) => m.id).filter((id) => !current.knownMods.includes(id))
	const seededModOptions = seedDefaultModOptions(current.modOptions, mods)

	if (newIds.length === 0 && !seededModOptions) return current

	const knownMods = [...current.knownMods, ...newIds]
	const existingOrder = current.modOrder ?? []
	// Only append IDs actually missing from modOrder - existingOrder may already contain some of
	// `newIds` to knownMods if a previous rebuild partially caught up (rebuildIndex passes every
	// currently-indexed ID, not just newly-added ones).
	const modOrder = [...existingOrder, ...newIds.filter((id) => !existingOrder.includes(id))]

	return mergeSettings(paths, { knownMods, modOrder, ...(seededModOptions ? { modOptions: seededModOptions } : {}) })
}

/** Where Mods/ actually is, resolved against dataRoot if `modsPath` isn't already absolute - mirrors `src/core.ts`'s `createCore()`. */
export function resolveModsDir(paths: AppPaths, settings: AppSettings): string {
	return isAbsolute(settings.modsPath) ? settings.modsPath : resolve(paths.dataRoot, settings.modsPath)
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
	/** Where this app would actually put its cache if the user leaves the field untouched - a real, valid path under `dataRoot` (which is `app.getPath('userData')`, so it already carries the real logged-in username), not a placeholder made up to merely look plausible. */
	cachePath: string
	/** Same idea as `cachePath` - mirrors `resolveModsDir()`'s own default ("Mods" under `dataRoot`) when `modsPath` is unset. */
	modPath: string
}

/**
 * Computes the example paths the UI shows as placeholder text (Settings' Paths card, the setup
 * wizard) - previously three strings hardcoded twice over in the renderer (SettingsScreen.tsx and
 * SetupWizard.tsx), including a `cachePath`/`modPath` placeholder ("C:\Users\you\...") that was
 * never a real path on the user's machine. `cachePath`/`modPath` here are the actual paths this app
 * would use by default, so they're both valid and already carry the real Windows username baked
 * into `dataRoot` - `gamePath` can't be known ahead of time, so it stays an illustrative guess, just
 * without the "\Retail" suffix (see `DefaultUiPaths.gamePath`'s doc comment).
 */
export function resolveDefaultUiPaths(paths: AppPaths): DefaultUiPaths {
	const programFiles = process.env["ProgramFiles(x86)"] ?? process.env["ProgramFiles"] ?? "C:\\Program Files (x86)"
	return {
		gamePath: join(programFiles, "Steam", "steamapps", "common", "HITMAN3"),
		cachePath: resolve(paths.dataRoot, "cache"),
		modPath: resolve(paths.dataRoot, "Mods")
	}
}
