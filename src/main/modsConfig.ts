import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import JSON5 from "json5"

/**
 * LEI-141's config split: load order + selected options live *inside the Mods folder itself*
 * (`Mods/config.json`), not in the machine-level `settings.json` (`settings.ts`). This is still
 * fully app-managed - the mod manager writes it every time load order/options/shelf order change,
 * same as it always wrote those fields to settings.json before - the difference is *where* it lives:
 * portable with the Mods folder, so picking a different Mods folder (or moving/backing up/sharing
 * this one) brings its own load order and options with it instead of falling back to whatever
 * defaults happen to be sitting in this machine's AppData.
 *
 * "Never auto-regenerated" (per the design doc) means: if `Mods/config.json` already exists, it's
 * loaded as-is and trusted - never blown away and refilled with defaults just because, say, a mod
 * referenced in `loadOrder` is temporarily missing. A brand new/empty Mods folder gets a fresh
 * `{ loadOrder: [], modOrder: [], modOptions: {} }` written once, the same way `settings.ts`'s
 * `loadSettings()` seeds a fresh settings.json.
 */
export interface ModsConfig {
	/** IDs of enabled mods only, in deploy order. */
	loadOrder: string[]
	/** Display/drag order for every known mod, enabled or not - see the old `Config.modOrder` doc comment (manifest-types.ts). */
	modOrder: string[]
	/** modId -> list of enabled option names ("optionName" for checkboxes, "group:optionName" for selects). */
	modOptions: Record<string, string[]>
}

function defaultModsConfig(): ModsConfig {
	return { loadOrder: [], modOrder: [], modOptions: {} }
}

export function modsConfigPath(modsDir: string): string {
	return join(modsDir, "config.json")
}

/**
 * Cached in-memory the same way `settings.ts` caches `AppSettings` - re-parsed only when the Mods
 * folder actually changes (tracked by `cachedForDir`) or `invalidateModsConfigCache()` is called
 * explicitly (a modPath switch - see `ipcHandlers.ts`'s `config:merge`).
 */
let cached: ModsConfig | null = null
let cachedForDir: string | null = null

export function invalidateModsConfigCache(): void {
	cached = null
	cachedForDir = null
}

export function loadModsConfig(modsDir: string): ModsConfig {
	if (cached && cachedForDir === modsDir) return cached

	const file = modsConfigPath(modsDir)

	if (!existsSync(file)) {
		const fresh = defaultModsConfig()
		try {
			mkdirSync(modsDir, { recursive: true })
			writeFileSync(file, JSON.stringify(fresh, undefined, "\t"))
		} catch {
			// Best-effort - a fresh Mods folder that isn't writable yet (e.g. picked but not created)
			// still gets an in-memory default so the UI has something to render.
		}
		cached = fresh
		cachedForDir = modsDir
		return fresh
	}

	let config: ModsConfig
	try {
		const parsed = JSON5.parse(readFileSync(file, "utf8"))
		config = { ...defaultModsConfig(), ...parsed }
	} catch {
		// Malformed config.json - fall back to defaults in memory rather than crash, but don't
		// overwrite the broken file on disk (a save only happens on an explicit merge/write below,
		// so the original bytes are still there for the user/support to recover if this was a fluke).
		config = defaultModsConfig()
	}

	cached = config
	cachedForDir = modsDir
	return config
}

export function saveModsConfig(modsDir: string, config: ModsConfig): void {
	mkdirSync(modsDir, { recursive: true })
	writeFileSync(modsConfigPath(modsDir), JSON.stringify(config, undefined, "\t"))
	cached = config
	cachedForDir = modsDir
}

export function mergeModsConfig(modsDir: string, patch: Partial<ModsConfig>): ModsConfig {
	const current = loadModsConfig(modsDir)
	const next: ModsConfig = { ...current, ...patch }
	saveModsConfig(modsDir, next)
	return next
}

/**
 * One-time upgrade path for installs that had `loadOrder`/`modOrder`/`modOptions` sitting in the old
 * `settings.json` (pre-LEI-141) - writes them into a fresh `Mods/config.json` exactly once. Never
 * runs if `Mods/config.json` already exists (that file, once present, is always the source of
 * truth - see this module's doc comment) or if the legacy settings had nothing worth migrating
 * (a fresh install with empty arrays/objects would otherwise "migrate" into an identical empty file,
 * which is harmless but pointless).
 */
export function migrateFromLegacySettings(modsDir: string, legacy: { loadOrder?: string[]; modOrder?: string[]; modOptions?: Record<string, string[]> }): void {
	if (existsSync(modsConfigPath(modsDir))) return

	const hasData = (legacy.loadOrder?.length ?? 0) > 0 || (legacy.modOrder?.length ?? 0) > 0 || Object.keys(legacy.modOptions ?? {}).length > 0
	if (!hasData) return

	saveModsConfig(modsDir, {
		loadOrder: legacy.loadOrder ?? [],
		modOrder: legacy.modOrder ?? [],
		modOptions: legacy.modOptions ?? {}
	})
}

/** Structural subset of `ManifestOption`/`DiskManifestOption` - mirrors the old `settings.ts`'s `OptionLike`. */
interface OptionLike {
	name: string
	type: string
	group?: string
	enabledByDefault?: boolean
}

export interface KnownModInput {
	id: string
	manifest?: { options?: OptionLike[] }
}

/**
 * Fills in `modOptions[mod.id]` for any mod that doesn't have an entry yet, and appends any newly-seen
 * mod id to `modOrder` - the `Mods/config.json` equivalent of the old `settings.ts`'s `addKnownMods()`.
 * The `knownMods` half of that old function is gone entirely (LEI-141: redundant now that `cache.db`'s
 * `mods` table - see `db.ts` - is the real membership list; `ModIndex` writes there directly).
 */
export function addNewlyKnownMods(modsDir: string, mods: KnownModInput[]): ModsConfig {
	const current = loadModsConfig(modsDir)

	const existingOrder = current.modOrder ?? []
	const newIds = mods.map((m) => m.id).filter((id) => !existingOrder.includes(id))
	const modOrder = [...existingOrder, ...newIds]

	let changed = newIds.length > 0
	const modOptions = { ...current.modOptions }

	for (const mod of mods) {
		const options = mod.manifest?.options
		if (!options?.length || modOptions[mod.id] !== undefined) continue

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

		modOptions[mod.id] = picks
		changed = true
	}

	if (!changed) return current

	return mergeModsConfig(modsDir, { modOrder, modOptions })
}
