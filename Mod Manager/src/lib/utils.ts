import { OptionType, type Config, type Manifest } from "../../../src/types"
import { compileExpression, useDotAccessOperatorAndOptionalChaining } from "filtrex"

import Ajv from "ajv"
import json5 from "json5"
import manifestSchema from "$lib/manifest-schema.json"
import entitySchema from "$lib/entity-schema.json"
import entityPatchSchema from "$lib/entity-patch-schema.json"
import repositorySchema from "$lib/repository-schema.json"
import unlockablesSchema from "$lib/unlockables-schema.json"
import contractSchema from "$lib/contract-schema.json"
import jsonPatchSchema from "$lib/json-patch-schema.json"
import merge from "lodash.mergewith"
import semver from "semver"

export const FrameworkVersion = "2.33.40"

// ─── mod storage location ──────────────────────────────────────────────────
//
// Historically every "Mods" lookup in this file just hardcoded
// window.path.join("..", "Mods") - the same process.cwd()-style bug the
// framework core had (see LEI-130), just one layer up (relative to whatever
// main/index.ts pinned this Electron process's cwd to). Config now carries an
// explicit modsPath (src/types.ts), so mod storage can be moved independent
// of where Mod Manager itself is installed.
//
// getModsDir() can't just call getConfig() - getConfig() itself resolves
// getModFolder()/buildModIndex() while validating loadOrder, which need to
// know the mods directory *before* getConfig() has finished running. So this
// does its own minimal, unvalidated read of config.json for modsPath alone,
// and caches the result (invalidated whenever setConfig() writes a new one)
// instead of hitting disk on every mod lookup.
const DEFAULT_MODS_PATH = window.path.join("..", "Mods")

let _modsDirCache: string | undefined

function resolveModsDir(modsPath: string | undefined): string {
	return modsPath ? window.path.resolve(modsPath) : DEFAULT_MODS_PATH
}

export function getModsDir(): string {
	if (_modsDirCache) return _modsDirCache

	let modsPath: string | undefined
	try {
		modsPath = json5.parse(String(window.fs.readFileSync("../config.json", "utf8")))?.modsPath
	} catch {
		// missing/corrupt config.json - fall back to the historical default; getConfig() is what
		// surfaces a real error for this elsewhere
	}

	_modsDirCache = resolveModsDir(modsPath)
	return _modsDirCache
}

const validateManifest = new Ajv({ strict: false }).compile(manifestSchema)

const validateEntity = new Ajv({ strict: false }).compile(entitySchema)
const validateEntityPatch = new Ajv({ strict: false }).compile(entityPatchSchema)
const validateRepository = new Ajv({ strict: false }).compile(repositorySchema)
const validateUnlockables = new Ajv({ strict: false }).compile(unlockablesSchema)
const validateContract = new Ajv({ strict: false }).compile(contractSchema)
const validateJSONPatch = new Ajv({ strict: false }).compile(jsonPatchSchema)

export function getConfig() {
	const config: Config = json5.parse(String(window.fs.readFileSync("../config.json", "utf8")))

	// Remove duplicate items in load order
	config.loadOrder = config.loadOrder.filter((value, index, array) => array.indexOf(value) === index)

	// Remove non-existent mods from load order
	config.loadOrder = config.loadOrder.filter((value) => {
		try {
			getModFolder(value)
			return true
		} catch {
			return false
		}
	})

	// Validate mod options
	config.loadOrder.forEach((mod) => {
		if (modIsFramework(mod)) {
			const manifest = getManifestFromModID(mod)!

			if (manifest.options) {
				if (!config.modOptions[mod]) {
					merge(
						config,
						{
							modOptions: {
								[mod]: [
									...manifest.options
										.filter((a) => (a.type === "checkbox" || a.type === "select" ? a.enabledByDefault : false))
										.map((a) => (a.type === "select" ? `${a.group}:${a.name}` : a.name))
								]
							}
						},
						(orig, src) => {
							if (Array.isArray(orig)) {
								return src
							}
						}
					)
				} // Select default options when a mod has no options set

				config.modOptions[mod].push(
					...manifest.options
						.filter((a) => a.type === "select" && a.enabledByDefault)
						.filter((a) => !config.modOptions[mod].some((b) => b.split(":").length > 1 && b.split(":")[0] !== a.name))
						.map((a) => (a.type === "select" ? `${a.group}:${a.name}` : a.name))
				) // Select default options in select type IF there is no selected option

				for (let i = config.modOptions[mod].length - 1; i >= 0; i--) {
					if (
						!(
							manifest.options.some((a) => a.type === "checkbox" && a.name === config.modOptions[mod][i]) ||
							manifest.options.some((a) => a.type === "select" && `${a.group}:${a.name}` === config.modOptions[mod][i])
						)
					) {
						if (manifest.options.some((a) => a.type === "select" && a.name === config.modOptions[mod][i])) {
							// There's a select and it's using the old name format (just the name), change it to the new format (group:name)
							// @ts-ignore
							config.modOptions[mod][i] = `${
								// @ts-ignore
								manifest.options.find((a) => a.type === "select" && a.name === config.modOptions[mod][i])!.group
							}:${manifest.options.find((a) => a.type === "select" && a.name === config.modOptions[mod][i])!.name}`
						} else {
							// Remove it, it doesn't exist
							config.modOptions[mod].splice(i, 1)
						}
					}
				} // Remove non-existent options and update from the old name format in select options

				for (let i = config.modOptions[manifest.id].length - 1; i >= 0; i--) {
					if (
						manifest.options.find(
							(a) => (a.type === "checkbox" && a.name === config.modOptions[manifest.id][i]) || (a.type === "select" && `${(a as any).group}:${a.name}` === config.modOptions[manifest.id][i])
						)?.requirements
					) {
						if (
							!manifest.options
								.find(
									(a) =>
										(a.type === "checkbox" && a.name === config.modOptions[manifest.id][i]) || (a.type === "select" && `${(a as any).group}:${a.name}` === config.modOptions[manifest.id][i])
								)!
								.requirements!.every((a: any) => config.loadOrder.includes(typeof a === "string" ? a : a[0]))
						) {
							config.modOptions[manifest.id].splice(i, 1)
						}
					}
				} // Disable mod options that require non-present mods

				merge(
					config,
					{
						modOptions: config.modOptions
					},
					(orig, src) => {
						if (Array.isArray(orig)) {
							return src
						}
					}
				)
			}
		}
	})

	setConfig(config)
	return config
}

export function setConfig(config: Config) {
	window.fs.writeFileSync("../config.json", json5.stringify(config))
	_modsDirCache = resolveModsDir(config.modsPath)
}

export function mergeConfig(configToMerge: Partial<Config>) {
	const config = getConfig()
	setConfig(
		merge(config, configToMerge, (orig, src) => {
			if (Array.isArray(orig)) {
				return src
			}
		})
	)
}

export function sortMods() {
	const config = getConfig()

	config.loadOrder = config.loadOrder.sort((a, b) => {
		// RPKG mod sort order does not matter; they're always deployed before framework mods anyway
		if (!(modIsFramework(a) && modIsFramework(b))) {
			return 0
		}

		const manifestA = getManifestFromModID(a)
		const manifestB = getManifestFromModID(b)

		const modALoadBefore: (string | [string, string])[] = []

		if (manifestA.loadBefore) {
			modALoadBefore.push(...manifestA.loadBefore)
		}

		if (manifestA.options) {
			modALoadBefore.push(
				...(manifestA.options
					.filter(
						(x) =>
							config.modOptions[a].includes(x.name) ||
							config.modOptions[a].includes(`${(x as any).group}:${x.name}`) ||
							(x.type === OptionType.conditional &&
								compileExpression(x.condition, { customProp: useDotAccessOperatorAndOptionalChaining })({
									config
								}))
					)
					.map((a) => a.loadBefore)
					.filter((a) => a)
					.flat(1) as (string | [string, string])[])
			)
		}

		const modBLoadBefore: (string | [string, string])[] = []

		if (manifestB.loadBefore) {
			modBLoadBefore.push(...manifestB.loadBefore)
		}

		if (manifestB.options) {
			modBLoadBefore.push(
				...(manifestB.options
					.filter(
						(x) =>
							config.modOptions[b].includes(x.name) ||
							config.modOptions[b].includes(`${(x as any).group}:${x.name}`) ||
							(x.type === OptionType.conditional &&
								compileExpression(x.condition, { customProp: useDotAccessOperatorAndOptionalChaining })({
									config
								}))
					)
					.map((a) => a.loadBefore)
					.filter((a) => a!)
					.flat(1) as (string | [string, string])[])
			)
		}

		const modALoadAfter: (string | [string, string])[] = []

		if (manifestA.loadAfter) {
			modALoadAfter.push(...manifestA.loadAfter)
		}

		if (manifestA.options) {
			modALoadAfter.push(
				...(manifestA.options
					.filter(
						(x) =>
							config.modOptions[a].includes(x.name) ||
							config.modOptions[a].includes(`${(x as any).group}:${x.name}`) ||
							(x.type === OptionType.conditional &&
								compileExpression(x.condition, { customProp: useDotAccessOperatorAndOptionalChaining })({
									config
								}))
					)
					.map((a) => a.loadAfter)
					.filter((a) => a)
					.flat(1) as (string | [string, string])[])
			)
		}

		const modBLoadAfter: (string | [string, string])[] = []

		if (manifestB.loadAfter) {
			modBLoadAfter.push(...manifestB.loadAfter)
		}

		if (manifestB.options) {
			modBLoadAfter.push(
				...(manifestB.options
					.filter(
						(x) =>
							config.modOptions[b].includes(x.name) ||
							config.modOptions[b].includes(`${(x as any).group}:${x.name}`) ||
							(x.type === OptionType.conditional &&
								compileExpression(x.condition, { customProp: useDotAccessOperatorAndOptionalChaining })({
									config
								}))
					)
					.map((a) => a.loadAfter)
					.filter((a) => a!)
					.flat(1) as (string | [string, string])[])
			)
		}

		for (const loadBefore of modALoadBefore) {
			if (typeof loadBefore === "string") {
				if (loadBefore === b) {
					return -1
				}
			} else if (loadBefore[0] === b) {
				if (semver.satisfies(manifestB.version, loadBefore[1])) {
					return -1
				}
			}
		}

		for (const loadAfter of modALoadAfter) {
			if (typeof loadAfter === "string") {
				if (loadAfter === b) {
					return 1
				}
			} else if (loadAfter[0] === b) {
				if (semver.satisfies(manifestB.version, loadAfter[1])) {
					return 1
				}
			}
		}

		for (const loadBefore of modBLoadBefore) {
			if (typeof loadBefore === "string") {
				if (loadBefore === a) {
					return 1
				}
			} else if (loadBefore[0] === a) {
				if (semver.satisfies(manifestB.version, loadBefore[1])) {
					return 1
				}
			}
		}

		for (const loadAfter of modBLoadAfter) {
			if (typeof loadAfter === "string") {
				if (loadAfter === a) {
					return -1
				}
			} else if (loadAfter[0] === a) {
				if (semver.satisfies(manifestB.version, loadAfter[1])) {
					return -1
				}
			}
		}

		return 0
	})

	setConfig(config)
	return true
}

export function alterModManifest(modID: string, data: Partial<Manifest>) {
	const manifest = getManifestFromModID(modID)
	merge(manifest, data, (orig, src) => {
		if (Array.isArray(orig)) {
			return src
		}
	})
	setModManifest(modID, manifest)
}

// ─── mod-level caches (persisted to disk; kept in sync via write-through) ──
//
// These are populated by buildModIndex() — either from the persisted on-disk
// index below, or by a full walk of Mods/ — and are then kept in sync
// afterwards by the manager's own mutations (addModsToIndex /
// removeModFromIndex / setModManifest) instead of paying for a full re-walk
// every time this module gets a fresh start — which, in this Electron app,
// is every single navigation that reloads the page (modList's add/delete
// flows and the root page's startModUpdate/installRPKGMod all do a hard
// reload right after mutating Mods/).

let _modFolderCache = new Map<string, string>()
let _isFrameworkCache = new Map<string, boolean>()
let _manifestCache = new Map<string, Manifest>()
let _allModsCache: string[] | null = null
let _isIndexed = false

// ─── persistent mod index ──────────────────────────────────────────────────
//
// Re-deriving everything from disk on every start is the correctness-first
// default: disk is the source of truth, since users can drop a mod straight
// into Mods/ by extracting a zip there instead of using "Add a Mod" (that's
// what the knownMods / "Incorrectly installed mod" detection exists to
// catch). But that means every user who never touches the folder by hand
// pays the re-scan cost to protect the minority who do.
//
// So the manifest data + folder map + framework/RPKG flag for every mod is
// persisted to MOD_INDEX_CACHE_FILE in the app dir (relative paths here
// resolve against process.cwd(), which main/index.ts pins to the Mod
// Manager folder). On startup we still do one top-level readdir of Mods/
// (folder names only — a single round-trip, not N manifest reads) and diff
// it against the persisted folder names:
//   - nothing changed → trust the cache wholesale, zero manifest reads
//   - a folder appeared/disappeared → keep the cached entries for every
//     folder that's still there, and only read the manifest for the new ones
// The one case this can't catch is someone hand-editing files *inside* an
// existing mod folder without touching the folder set — that's what the
// manual "Rebuild cache" button (rebuildModIndex) is for.
const MOD_INDEX_CACHE_FILE = "mod-index-cache.json"
const MOD_INDEX_CACHE_VERSION = 1

interface ModIndexEntry {
	/** Folder name under Mods/ — not a full path, so the cache stays valid even if the install is later moved. */
	folder: string
	/** manifest.id for framework mods; the folder name itself for bare RPKG mods. */
	id: string
	isFramework: boolean
	manifest?: Manifest
}

interface PersistedModIndex {
	version: number
	/** Cross-checked against FrameworkVersion so an upgrade that changes manifest handling can't silently trust a stale cache. */
	frameworkVersion: string
	entries: ModIndexEntry[]
}

/**
 * Read manifest.json (if any) for each named folder. The only part of an
 * index build that touches per-mod files — called only for folders the
 * persisted cache can't already vouch for (or all of them, on a full walk).
 */
function readModEntries(folders: string[], modsDir: string): ModIndexEntry[] {
	return folders.map((folder): ModIndexEntry => {
		const fullPath = window.path.resolve(window.path.join(modsDir, folder))
		const manifestPath = window.path.join(fullPath, "manifest.json")
		if (window.fs.existsSync(manifestPath)) {
			try {
				const manifest: Manifest = json5.parse(String(window.fs.readFileSync(manifestPath, "utf8")))
				return { folder, id: manifest.id, isFramework: true, manifest }
			} catch {
				// malformed manifest — fall through and treat as a bare folder
			}
		}
		// no (valid) manifest: an RPKG / bare mod keyed by its folder name
		return { folder, id: folder, isFramework: false }
	})
}

/** Populate the four in-memory caches from a resolved entry list. */
function applyModEntries(entries: ModIndexEntry[], modsDir: string): void {
	_modFolderCache.clear()
	_isFrameworkCache.clear()
	_manifestCache.clear()
	for (const entry of entries) {
		_modFolderCache.set(entry.id, window.path.resolve(window.path.join(modsDir, entry.folder)))
		_isFrameworkCache.set(entry.id, entry.isFramework)
		if (entry.manifest) _manifestCache.set(entry.id, entry.manifest)
	}
	_allModsCache = entries.map((entry) => entry.id)
}

/**
 * Load the persisted index, or null if it's missing, unreadable, or from an
 * incompatible framework version — any of which just means "build it fresh",
 * never a hard failure.
 */
function loadPersistedModIndex(): ModIndexEntry[] | null {
	try {
		if (!window.fs.existsSync(MOD_INDEX_CACHE_FILE)) return null
		const parsed: PersistedModIndex = JSON.parse(String(window.fs.readFileSync(MOD_INDEX_CACHE_FILE, "utf8")))
		if (parsed.version !== MOD_INDEX_CACHE_VERSION || parsed.frameworkVersion !== FrameworkVersion || !Array.isArray(parsed.entries)) {
			return null
		}
		return parsed.entries
	} catch {
		return null
	}
}

/**
 * Write the current in-memory index to disk. Best-effort: if this fails
 * (disk full, permissions, whatever) the in-memory index is still correct
 * for this run — it just means the next start re-walks Mods/ instead of
 * trusting a cache, never a hard failure.
 */
function persistModIndex(): void {
	const entries: ModIndexEntry[] = (_allModsCache ?? []).map((id) => ({
		folder: window.path.basename(_modFolderCache.get(id) ?? id),
		id,
		isFramework: _isFrameworkCache.get(id) ?? false,
		manifest: _manifestCache.get(id)
	}))
	const payload: PersistedModIndex = { version: MOD_INDEX_CACHE_VERSION, frameworkVersion: FrameworkVersion, entries }
	try {
		window.fs.writeFileSync(MOD_INDEX_CACHE_FILE, JSON.stringify(payload))
	} catch {
		// best-effort — see doc comment above
	}
}

function buildModIndex(forceFull = false): void {
	if (_isIndexed) return
	const modsDir = getModsDir()
	if (!window.fs.existsSync(modsDir)) {
		_allModsCache = []
		_isIndexed = true
		return
	}

	const rawEntries = window.fs.readdirSync(modsDir)
	const folders = rawEntries.filter((entry) => entry !== "Managed by SMF, do not touch")

	const persisted = forceFull ? null : loadPersistedModIndex()

	if (persisted) {
		const persistedFolders = new Set(persisted.map((entry) => entry.folder))
		const currentFolders = new Set(folders)
		const unchanged = persistedFolders.size === currentFolders.size && folders.every((folder) => persistedFolders.has(folder))

		if (unchanged) {
			// nothing appeared or disappeared in Mods/ since last run — trust the
			// persisted cache wholesale: no manifest reads, no validation walks
			applyModEntries(persisted, modsDir)
			_isIndexed = true
			return
		}

		// a folder appeared or disappeared: keep the cached entry for every
		// folder that's still there, and only read manifests for the new ones
		const kept = persisted.filter((entry) => currentFolders.has(entry.folder))
		const addedFolders = folders.filter((folder) => !persistedFolders.has(folder))
		const addedEntries = readModEntries(addedFolders, modsDir)
		const byFolder = new Map([...kept, ...addedEntries].map((entry) => [entry.folder, entry]))
		const merged = folders.map((folder) => byFolder.get(folder)).filter((entry): entry is ModIndexEntry => entry !== undefined)

		applyModEntries(merged, modsDir)
		_isIndexed = true
		persistModIndex()
		return
	}

	// no usable persisted cache (missing, corrupt, stale framework version, or
	// a forced rebuild) — fall back to the full walk and persist a fresh cache
	const entries = readModEntries(folders, modsDir)
	applyModEntries(entries, modsDir)
	_isIndexed = true
	persistModIndex()
}

export function clearModCache(): void {
	_modFolderCache.clear()
	_isFrameworkCache.clear()
	_manifestCache.clear()
	_allModsCache = null
	_isIndexed = false
}

/**
 * Force a full re-derive of the mod index from disk, bypassing (and then
 * overwriting) the persisted cache. This is the one case the readdir diff
 * can't cover on its own: someone hand-edited files inside an existing mod
 * folder without adding/removing/renaming it, so there's no folder-name
 * change to notice. Wired up to the "Rebuild cache" button.
 */
export function rebuildModIndex(): void {
	clearModCache()
	buildModIndex(true)
}

/**
 * Write-through for mods the manager just installed itself (Add a Mod, an
 * RPKG install, or a mod auto-update) — we already know exactly which
 * folders under Mods/ changed, so there's no need to touch anything else in
 * the index, let alone re-walk it.
 */
export function addModsToIndex(folderNames: string[]): void {
	buildModIndex()
	const modsDir = getModsDir()
	const newEntries = readModEntries(folderNames, modsDir)
	for (const entry of newEntries) {
		_modFolderCache.set(entry.id, window.path.resolve(window.path.join(modsDir, entry.folder)))
		_isFrameworkCache.set(entry.id, entry.isFramework)
		if (entry.manifest) _manifestCache.set(entry.id, entry.manifest)
	}
	const existingIds = new Set(_allModsCache ?? [])
	const newIds = newEntries.map((entry) => entry.id).filter((id) => !existingIds.has(id))
	_allModsCache = [...(_allModsCache ?? []), ...newIds]
	persistModIndex()
}

/** Write-through for a mod the manager just deleted itself. */
export function removeModFromIndex(id: string): void {
	buildModIndex()
	_modFolderCache.delete(id)
	_isFrameworkCache.delete(id)
	_manifestCache.delete(id)
	_allModsCache = (_allModsCache ?? []).filter((a) => a !== id)
	persistModIndex()
}

export function setModManifest(modID: string, manifest: Manifest) {
	window.fs.writeFileSync(window.path.join(getModFolder(modID), "manifest.json"), JSON.stringify(manifest, undefined, "\t"))
	// write-through: we just wrote this manifest ourselves, so update (rather
	// than merely invalidate) the cache and persist it — no need to re-read
	// what we already have in hand, and no need for a full rescan
	_manifestCache.set(modID, manifest)
	persistModIndex()
}

export function getModFolder(id: string): string {
	if (_modFolderCache.has(id)) return _modFolderCache.get(id)!
	buildModIndex()
	if (_modFolderCache.has(id)) return _modFolderCache.get(id)!
	// id isn't indexed — fall back to a per-id scan (also covers the throw/alert case)
	const modsDir = getModsDir()

	let folder: string | undefined
	if (modIsFramework(id)) {
		const entries = window.fs.readdirSync(modsDir)
		for (const entry of entries) {
			const manifestPath = window.path.join(modsDir, entry, "manifest.json")
			if (window.fs.existsSync(manifestPath)) {
				try {
					const mf = json5.parse(String(window.fs.readFileSync(manifestPath, "utf8")))
					if (mf.id === id) {
						folder = entry
						break
					}
				} catch {
					// skip malformed manifest
				}
			}
		}
	} else {
		folder = id
	}

	if (!folder) {
		window.alert(`The mod ${id} couldn't be located! This will likely cause issues in parts of the framework. If you deleted a mod folder, use the Delete Mod option next time.`)

		if (getConfig().loadOrder.includes(id)) {
			mergeConfig({
				loadOrder: getConfig().loadOrder.filter((a) => a != id)
			})
		}

		throw new Error(`Couldn't find mod ${id}`)
	}

	const result = window.path.resolve(window.path.join(modsDir, folder))
	_modFolderCache.set(id, result)
	return result
}

export function modIsFramework(id: string): boolean {
	if (_isFrameworkCache.has(id)) return _isFrameworkCache.get(id)!
	buildModIndex()
	if (_isFrameworkCache.has(id)) return _isFrameworkCache.get(id)!
	// id isn't a folder in Mods/ — fall back to per-id detection
	const modsDir = getModsDir()
	const modDir = window.path.join(modsDir, id)
	// An RPKG mod: the folder exists, has no manifest, and contains *.rpkg files
	const isRpkg =
		window.fs.existsSync(modDir) &&
		!window.fs.existsSync(window.path.join(modDir, "manifest.json")) &&
		window.klaw(modDir, { nodir: true }).map((a) => a.path).some((a) => a.endsWith(".rpkg"))
	const result = !isRpkg
	_isFrameworkCache.set(id, result)
	return result
}

export function getManifestFromModID(id: string): Manifest {
	if (_manifestCache.has(id)) return _manifestCache.get(id)!
	buildModIndex()
	if (_manifestCache.has(id)) return _manifestCache.get(id)!
	if (!modIsFramework(id)) {
		throw new Error(`Mod ${id} is not a framework mod`)
	}
	const folder = getModFolder(id)
	const manifest: Manifest = json5.parse(String(window.fs.readFileSync(window.path.join(folder, "manifest.json"), "utf8")))
	_manifestCache.set(id, manifest)
	return manifest
}

export function getAllMods(): string[] {
	if (_allModsCache) return _allModsCache
	buildModIndex()
	return _allModsCache!
}

export function validateModFolder(modFolder: string): [boolean, string] {
	if (!window.fs.existsSync(window.path.join(modFolder, "manifest.json"))) {
		return [false, "No manifest"]
	}

	try {
		json5.parse(window.fs.readFileSync(window.path.join(modFolder, "manifest.json"), "utf8"))
	} catch {
		return [false, "Invalid manifest due to invalid JSON"]
	}

	if (!validateManifest(json5.parse(window.fs.readFileSync(window.path.join(modFolder, "manifest.json"), "utf8")))) {
		return [false, `Invalid manifest due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateManifest.errors)}`]
	}

	const manifest: Manifest = json5.parse(window.fs.readFileSync(window.path.join(modFolder, "manifest.json"), "utf8"))

	for (const contentFolder of [...(manifest.contentFolders || []), ...(manifest.options || []).flatMap((a) => a.contentFolders || [])]) {
		if (!window.fs.existsSync(window.path.resolve(modFolder, contentFolder))) {
			return [false, `Invalid content folder "${contentFolder}" due to nonexistent path`]
		}

		const chunkFolders = window.fs.readdirSync(window.path.resolve(modFolder, contentFolder))

		if (chunkFolders.length === 0) {
			return [false, `Empty content folder "${contentFolder}"`]
		}

		for (const chunkFolder of chunkFolders) {
			if (!chunkFolder.match(/chunk([0-9]*)/)) {
				return [false, `Invalid chunk folder "${chunkFolder}" in "${contentFolder}"`]
			}
		}
	}

	for (const blobsFolder of [...(manifest.blobsFolders || []), ...(manifest.options || []).flatMap((a) => a.blobsFolders || [])]) {
		if (!window.fs.existsSync(window.path.resolve(modFolder, blobsFolder))) {
			return [false, `Invalid blobs folder "${blobsFolder}" due to nonexistent path`]
		}

		if (window.fs.readdirSync(window.path.resolve(modFolder, blobsFolder)).length === 0) {
			return [false, `Empty blobs folder "${blobsFolder}"`]
		}
	}

	const groups: Record<string, [number, number]> = {}

	for (const option of manifest.options || []) {
		if (option.type === OptionType.select) {
			groups[option.group] ??= [0, 0]
			groups[option.group][0] = groups[option.group][0] + 1

			if (option.enabledByDefault) {
				groups[option.group][1] = groups[option.group][1] + 1
			}
		}
	}

	for (const [group, [members, enabledByDefault]] of Object.entries(groups)) {
		if (members === 1) {
			return [false, `Option group "${group}" has only one member`]
		}

		if (enabledByDefault > 1) {
			return [false, `Option group "${group}" has more than one member enabled by default`]
		}
	}

	for (const file of window.klaw(modFolder, { nodir: true }).map((a) => a.path)) {
		if (
			file.endsWith("entity.json") ||
			file.endsWith("entity.patch.json") ||
			file.endsWith("repository.json") ||
			file.endsWith("unlockables.json") ||
			file.endsWith("JSON.patch.json") ||
			file.endsWith("contract.json")
		) {
			try {
				const fileContents = window.fs.readJSONSync(file)

				switch (file.split(".").slice(1).join(".")) {
					case "entity.json":
						if (fileContents.quickEntityVersion === 3.1 && !validateEntity(fileContents))
							return [false, `Invalid file ${file} due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateEntity.errors)}`]
						break
					case "entity.patch.json":
						if (fileContents.patchVersion === 6 && !validateEntityPatch(fileContents))
							return [false, `Invalid file ${file} due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateEntityPatch.errors)}`]
						break
					case "repository.json":
						if (!validateRepository(fileContents)) return [false, `Invalid file ${file} due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateRepository.errors)}`]
						break
					case "unlockables.json":
						if (!validateUnlockables(fileContents)) return [false, `Invalid file ${file} due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateUnlockables.errors)}`]
						break
					case "contract.json":
						if (!validateContract(fileContents)) return [false, `Invalid file ${file} due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateContract.errors)}`]
						break
					case "JSON.patch.json":
						if (!validateJSONPatch(fileContents)) return [false, `Invalid file ${file} due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateJSONPatch.errors)}`]
						break
				}
			} catch {
				return [false, `Invalid file ${file} due to invalid JSON`]
			}
		}
	}

	return [true, ""]
}
