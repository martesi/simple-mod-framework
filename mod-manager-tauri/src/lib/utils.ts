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

import * as native from "$lib/native"

export const FrameworkVersion = "2.33.40"

const validateManifest = new Ajv({ strict: false }).compile(manifestSchema)
const validateEntity = new Ajv({ strict: false }).compile(entitySchema)
const validateEntityPatch = new Ajv({ strict: false }).compile(entityPatchSchema)
const validateRepository = new Ajv({ strict: false }).compile(repositorySchema)
const validateUnlockables = new Ajv({ strict: false }).compile(unlockablesSchema)
const validateContract = new Ajv({ strict: false }).compile(contractSchema)
const validateJSONPatch = new Ajv({ strict: false }).compile(jsonPatchSchema)

// ─── mod-level caches (persisted to disk; kept in sync via write-through) ──
//
// These are populated by buildModIndex() — either from the persisted on-disk
// index below, or by a full walk of Mods/ — and are then kept in sync
// afterwards by the manager's own mutations (addModsToIndex /
// removeModFromIndex / setModManifest) instead of being wiped and rebuilt on
// every navigation.

let _modFolderCache = new Map<string, string>()
let _isFrameworkCache = new Map<string, boolean>()
let _manifestCache = new Map<string, Manifest>()
let _allModsCache: string[] | null = null

// Per-mod validateModFolder() results — see the "mod validation cache"
// section near the bottom of this file for how these get populated.
let _validationCache = new Map<string, [boolean, string]>()

// A single in-flight build of the mod index, shared by every lookup below.
// Without it, getModFolder/getManifestFromModID each re-walk the whole Mods
// folder, so resolving a load order of N mods costs O(N²) sequential native
// fs round-trips — painfully slow on a real install over a slow mount (e.g.
// WSL /mnt drvfs, ~45s to first render). buildModIndex() does one readdir,
// plus a manifest read for whatever entries the persisted cache below can't
// already vouch for, and populates all the caches above at once.
let _modIndex: Promise<void> | null = null

// ─── persistent mod index ──────────────────────────────────────────────────
//
// Re-deriving everything from disk on every start/navigation is the
// correctness-first default: disk is the source of truth, since users can
// drop a mod straight into Mods/ by extracting a zip there instead of using
// "Add a Mod" (that's what the knownMods / "Incorrectly installed mod"
// detection in modList exists to catch). But that means every user who never
// touches the folder by hand pays the re-scan cost to protect the minority
// who do.
//
// So the manifest data + folder map + framework/RPKG flag for every mod is
// persisted to MOD_INDEX_CACHE_FILE in the app dir. On startup we still do
// one top-level readdir of Mods/ (folder names only — a single round-trip,
// not N manifest reads) and diff it against the persisted folder names:
//   - nothing changed → trust the cache wholesale, zero manifest reads
//   - a folder appeared/disappeared → keep the cached entries for every
//     folder that's still there, and only read the manifest for the new ones
// The one case this can't catch is someone hand-editing files *inside* an
// existing mod folder without touching the folder set — that's what the
// manual "Rebuild cache" button (rebuildModIndex) is for.
const MOD_INDEX_CACHE_FILE = "mod-index-cache.json"
const MOD_INDEX_CACHE_VERSION = 2

interface ModIndexEntry {
	/** Folder name under Mods/ — not a full path, so the cache stays valid even if the install is later moved. */
	folder: string
	/** manifest.id for framework mods; the folder name itself for bare RPKG mods. */
	id: string
	isFramework: boolean
	manifest?: Manifest
	/**
	 * Cached validateModFolder() result for this mod, if it's been computed
	 * since the last time this entry's manifest was rewritten or the cache
	 * was force-rebuilt. Absent means "not yet validated" — getModValidation()
	 * fills it in lazily (see the mod validation cache section below), never
	 * eagerly during an index build, so building/loading the index itself
	 * never pays for a validation walk.
	 */
	validation?: [boolean, string]
}

interface PersistedModIndex {
	version: number
	/** Cross-checked against FrameworkVersion so an upgrade that changes manifest handling can't silently trust a stale cache. */
	frameworkVersion: string
	entries: ModIndexEntry[]
}

/**
 * Read manifest.json (if any) for each named folder, in parallel. The only
 * part of an index build that touches per-mod files — called only for
 * folders the persisted cache can't already vouch for (or all of them, on a
 * full walk).
 */
async function readModEntries(folders: string[], modsDir: string): Promise<ModIndexEntry[]> {
	return Promise.all(
		folders.map(async (folder): Promise<ModIndexEntry> => {
			const fullPath = native.path.resolve(native.path.join(modsDir, folder))
			const manifestPath = native.path.join(fullPath, "manifest.json")
			if (await native.fs.existsSync(manifestPath)) {
				try {
					const manifest: Manifest = json5.parse(await native.fs.readFileSync(manifestPath, "utf8"))
					return { folder, id: manifest.id, isFramework: true, manifest }
				} catch {
					// malformed manifest — fall through and treat as a bare folder
				}
			}
			// no (valid) manifest: an RPKG / bare mod keyed by its folder name
			return { folder, id: folder, isFramework: false }
		})
	)
}

/** Populate the in-memory caches from a resolved entry list. */
function applyModEntries(entries: ModIndexEntry[], modsDir: string): void {
	_modFolderCache.clear()
	_isFrameworkCache.clear()
	_manifestCache.clear()
	_validationCache.clear()
	for (const entry of entries) {
		_modFolderCache.set(entry.id, native.path.resolve(native.path.join(modsDir, entry.folder)))
		_isFrameworkCache.set(entry.id, entry.isFramework)
		if (entry.manifest) _manifestCache.set(entry.id, entry.manifest)
		if (entry.validation) _validationCache.set(entry.id, entry.validation)
	}
	_allModsCache = entries.map((entry) => entry.id)
}

/**
 * Load the persisted index, or null if it's missing, unreadable, or from an
 * incompatible framework version — any of which just means "build it fresh",
 * never a hard failure.
 */
async function loadPersistedModIndex(): Promise<ModIndexEntry[] | null> {
	try {
		if (!(await native.fs.existsSync(MOD_INDEX_CACHE_FILE))) return null
		const parsed: PersistedModIndex = JSON.parse(await native.fs.readFileSync(MOD_INDEX_CACHE_FILE, "utf8"))
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
async function persistModIndex(): Promise<void> {
	const entries: ModIndexEntry[] = (_allModsCache ?? []).map((id) => ({
		folder: native.path.basename(_modFolderCache.get(id) ?? id),
		id,
		isFramework: _isFrameworkCache.get(id) ?? false,
		manifest: _manifestCache.get(id),
		validation: _validationCache.get(id)
	}))
	const payload: PersistedModIndex = { version: MOD_INDEX_CACHE_VERSION, frameworkVersion: FrameworkVersion, entries }
	try {
		await native.fs.writeFileSync(MOD_INDEX_CACHE_FILE, JSON.stringify(payload))
	} catch {
		// best-effort — see doc comment above
	}
}

function buildModIndex(forceFull = false): Promise<void> {
	if (_modIndex) return _modIndex
	_modIndex = buildModIndexUncached(forceFull)
	return _modIndex
}

async function buildModIndexUncached(forceFull: boolean): Promise<void> {
	const modsDir = native.path.join("..", "Mods")
	const rawEntries = await native.fs.readdirSync(modsDir)
	const folders = rawEntries.filter((entry) => entry !== "Managed by SMF, do not touch")

	const persisted = forceFull ? null : await loadPersistedModIndex()

	if (persisted) {
		const persistedFolders = new Set(persisted.map((entry) => entry.folder))
		const currentFolders = new Set(folders)
		const unchanged = persistedFolders.size === currentFolders.size && folders.every((folder) => persistedFolders.has(folder))

		if (unchanged) {
			// nothing appeared or disappeared in Mods/ since last run — trust the
			// persisted cache wholesale: no manifest reads, no validation walks
			applyModEntries(persisted, modsDir)
			return
		}

		// a folder appeared or disappeared: keep the cached entry for every
		// folder that's still there, and only read manifests for the new ones
		const kept = persisted.filter((entry) => currentFolders.has(entry.folder))
		const addedFolders = folders.filter((folder) => !persistedFolders.has(folder))
		const addedEntries = await readModEntries(addedFolders, modsDir)
		const byFolder = new Map([...kept, ...addedEntries].map((entry) => [entry.folder, entry]))
		const merged = folders.map((folder) => byFolder.get(folder)).filter((entry): entry is ModIndexEntry => entry !== undefined)

		applyModEntries(merged, modsDir)
		await persistModIndex()
		return
	}

	// no usable persisted cache (missing, corrupt, stale framework version, or
	// a forced rebuild) — fall back to the full walk and persist a fresh cache
	const entries = await readModEntries(folders, modsDir)
	applyModEntries(entries, modsDir)
	await persistModIndex()
}

export function clearModCache(): void {
	_modFolderCache.clear()
	_isFrameworkCache.clear()
	_manifestCache.clear()
	_validationCache.clear()
	_allModsCache = null
	_modIndex = null
}

/**
 * Force a full re-derive of the mod index from disk, bypassing (and then
 * overwriting) the persisted cache. This is the one case the readdir diff
 * can't cover on its own: someone hand-edited files inside an existing mod
 * folder without adding/removing/renaming it, so there's no folder-name
 * change to notice. Wired up to the "Rebuild cache" button.
 */
export async function rebuildModIndex(): Promise<void> {
	clearModCache()
	await buildModIndex(true)
}

/**
 * Write-through for mods the manager just installed itself (Add a Mod, an
 * RPKG install, or a mod auto-update) — we already know exactly which
 * folders under Mods/ changed, so there's no need to touch anything else in
 * the index, let alone re-walk it.
 */
export async function addModsToIndex(folderNames: string[]): Promise<void> {
	await buildModIndex()
	const modsDir = native.path.join("..", "Mods")
	const newEntries = await readModEntries(folderNames, modsDir)
	for (const entry of newEntries) {
		_modFolderCache.set(entry.id, native.path.resolve(native.path.join(modsDir, entry.folder)))
		_isFrameworkCache.set(entry.id, entry.isFramework)
		if (entry.manifest) _manifestCache.set(entry.id, entry.manifest)
		// freshly (re)installed content — any stale validation result for this
		// id no longer applies; let getModValidation() recompute it lazily
		_validationCache.delete(entry.id)
	}
	const existingIds = new Set(_allModsCache ?? [])
	const newIds = newEntries.map((entry) => entry.id).filter((id) => !existingIds.has(id))
	_allModsCache = [...(_allModsCache ?? []), ...newIds]
	await persistModIndex()
}

/** Write-through for a mod the manager just deleted itself. */
export async function removeModFromIndex(id: string): Promise<void> {
	await buildModIndex()
	_modFolderCache.delete(id)
	_isFrameworkCache.delete(id)
	_manifestCache.delete(id)
	_validationCache.delete(id)
	_allModsCache = (_allModsCache ?? []).filter((a) => a !== id)
	await persistModIndex()
}

// ─── config ──────────────────────────────────────────────────────────────────

// The root layout and the page it renders both call getConfig() on startup,
// within a tick or two of each other. Without dedup that's two full reads +
// revalidation passes (including a getModFolder() lookup per load-order
// entry) racing each other for no reason. Cache the in-flight promise only —
// once it resolves the cache clears itself, so later calls (after mods are
// installed/uninstalled, or on a later navigation) still hit disk fresh.
let _configPromise: Promise<Config> | null = null

export async function getConfig(): Promise<Config> {
	if (_configPromise) return _configPromise
	_configPromise = getConfigUncached()
	try {
		return await _configPromise
	} finally {
		_configPromise = null
	}
}

async function getConfigUncached(): Promise<Config> {
	const raw = await native.fs.readFileSync("../config.json", "utf8")
	const config: Config = json5.parse(raw)

	// deduplicate load order
	config.loadOrder = config.loadOrder.filter((v, i, a) => a.indexOf(v) === i)

	// drop non-existent mods from load order
	const existing: string[] = []
	for (const id of config.loadOrder) {
		try {
			await getModFolder(id)
			existing.push(id)
		} catch {
			// mod folder not found — skip
		}
	}
	config.loadOrder = existing

	// validate and clean mod options
	for (const mod of config.loadOrder) {
		if (await modIsFramework(mod)) {
			const manifest = await getManifestFromModID(mod)
			if (!manifest.options) continue

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
					(orig: unknown, src: unknown) => (Array.isArray(orig) ? src : undefined)
				)
			}

			// fill in default select options
			config.modOptions[mod].push(
				...manifest.options
					.filter((a) => a.type === "select" && a.enabledByDefault && !config.modOptions[mod].some((b) => b.split(":").length > 1 && b.split(":")[0] !== a.name))
					.map((a) => (a.type === "select" ? `${a.group}:${a.name}` : a.name))
			)

			// remove unknown / old-format options
			for (let i = config.modOptions[mod].length - 1; i >= 0; i--) {
				if (!(
					manifest.options.some((a) => a.type === "checkbox" && a.name === config.modOptions[mod][i]) ||
					manifest.options.some((a) => a.type === "select" && `${a.group}:${a.name}` === config.modOptions[mod][i])
				)) {
					if (manifest.options.some((a) => a.type === "select" && a.name === config.modOptions[mod][i])) {
						const found = manifest.options.find((a) => a.type === "select" && a.name === config.modOptions[mod][i])!
						// @ts-expect-error select has group
						config.modOptions[mod][i] = `${found.group}:${found.name}`
					} else {
						config.modOptions[mod].splice(i, 1)
					}
				}
			}

			// remove options whose requirements aren't met
			for (let i = config.modOptions[manifest.id].length - 1; i >= 0; i--) {
				const opt = manifest.options.find(
					(a) => (a.type === "checkbox" && a.name === config.modOptions[manifest.id][i]) || (a.type === "select" && `${a.group}:${a.name}` === config.modOptions[manifest.id][i])
				)
				if (opt?.requirements) {
					if (!opt.requirements.every((r) => config.loadOrder.includes(r))) {
						config.modOptions[manifest.id].splice(i, 1)
					}
				}
			}

			merge(config, { modOptions: config.modOptions }, (orig: unknown, src: unknown) => (Array.isArray(orig) ? src : undefined))
		}
	}

	await setConfig(config)
	return config
}

export async function setConfig(config: Config): Promise<void> {
	await native.fs.writeFileSync("../config.json", json5.stringify(config))
}

export async function mergeConfig(partial: Partial<Config>): Promise<Config> {
	const config = await getConfig()
	const merged = merge(config, partial, (orig: unknown, src: unknown) => (Array.isArray(orig) ? src : undefined)) as Config
	await setConfig(merged)
	return merged
}

// ─── mod helpers ─────────────────────────────────────────────────────────────

export async function modIsFramework(id: string): Promise<boolean> {
	if (_isFrameworkCache.has(id)) return _isFrameworkCache.get(id)!
	await buildModIndex()
	if (_isFrameworkCache.has(id)) return _isFrameworkCache.get(id)!
	// id isn't a folder in Mods/ — fall back to per-id detection
	const modsDir = native.path.join("..", "Mods")
	const modDir = native.path.join(modsDir, id)
	// An RPKG mod: the folder exists, has no manifest, and contains *.rpkg files
	const isRpkg =
		(await native.fs.existsSync(modDir)) &&
		!(await native.fs.existsSync(native.path.join(modDir, "manifest.json"))) &&
		(await native.klaw(modDir, { nodir: true })).some((f) => f.path.endsWith(".rpkg"))
	const result = !isRpkg
	_isFrameworkCache.set(id, result)
	return result
}

export async function getModFolder(id: string): Promise<string> {
	if (_modFolderCache.has(id)) return _modFolderCache.get(id)!
	await buildModIndex()
	if (_modFolderCache.has(id)) return _modFolderCache.get(id)!
	// id isn't indexed — fall back to a per-id scan (also covers the throw case)
	const modsDir = native.path.join("..", "Mods")

	let folder: string | undefined
	if (await modIsFramework(id)) {
		const entries = await native.fs.readdirSync(modsDir)
		for (const entry of entries) {
			const manifestPath = native.path.join(modsDir, entry, "manifest.json")
			if (await native.fs.existsSync(manifestPath)) {
				try {
					const mf = json5.parse(await native.fs.readFileSync(manifestPath, "utf8"))
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
		throw new Error(`Couldn't find mod ${id}`)
	}

	const result = native.path.resolve(native.path.join(modsDir, folder))
	_modFolderCache.set(id, result)
	return result
}

export async function getManifestFromModID(id: string): Promise<Manifest> {
	if (_manifestCache.has(id)) return _manifestCache.get(id)!
	await buildModIndex()
	if (_manifestCache.has(id)) return _manifestCache.get(id)!
	if (!(await modIsFramework(id))) {
		throw new Error(`Mod ${id} is not a framework mod`)
	}
	const folder = await getModFolder(id)
	const manifest: Manifest = json5.parse(await native.fs.readFileSync(native.path.join(folder, "manifest.json"), "utf8"))
	_manifestCache.set(id, manifest)
	return manifest
}

export async function getAllMods(): Promise<string[]> {
	if (_allModsCache) return _allModsCache
	await buildModIndex()
	return _allModsCache!
}

export async function setModManifest(modID: string, manifest: Manifest): Promise<void> {
	const folder = await getModFolder(modID)
	await native.fs.writeFileSync(native.path.join(folder, "manifest.json"), JSON.stringify(manifest, undefined, "\t"))
	// write-through: we just wrote this manifest ourselves, so update (rather
	// than merely invalidate) the cache and persist it — no need to re-read
	// what we already have in hand, and no need for a full rescan
	_manifestCache.set(modID, manifest)
	// the manifest is what validateModFolder mostly validates against
	// (content/blobs folders, option groups, schema) — a rewritten manifest
	// invalidates any cached validation result for this mod, so the next
	// getModValidation() call recomputes it instead of serving a stale verdict
	_validationCache.delete(modID)
	await persistModIndex()
}

export async function alterModManifest(modID: string, data: Partial<Manifest>): Promise<void> {
	const manifest = await getManifestFromModID(modID)
	const merged = merge({ ...manifest }, data, (orig: unknown, src: unknown) => (Array.isArray(orig) ? src : undefined)) as Manifest
	await setModManifest(modID, merged)
}

// ─── sort load order ─────────────────────────────────────────────────────────

export async function sortMods(): Promise<boolean> {
	const config = await getConfig()

	const sorted = [...config.loadOrder].sort((a, b) => {
		// comparison must be synchronous here; manifests are already cached
		if (!(_isFrameworkCache.get(a) && _isFrameworkCache.get(b))) return 0

		const manifestA = _manifestCache.get(a)
		const manifestB = _manifestCache.get(b)
		if (!manifestA || !manifestB) return 0

		const loadBefore_A: (string | [string, string])[] = [
			...(manifestA.loadBefore ?? []),
			...(manifestA.options ?? [])
				.filter(
					(x) =>
						config.modOptions[a].includes(x.name) ||
						config.modOptions[a].includes(`${x.group}:${x.name}`) ||
						(x.type === OptionType.conditional &&
							compileExpression(x.condition, {
								customProp: useDotAccessOperatorAndOptionalChaining
							})({ config }))
				)
				.flatMap((o) => o.loadBefore ?? [])
		]

		const loadAfter_A: (string | [string, string])[] = [
			...(manifestA.loadAfter ?? []),
			...(manifestA.options ?? [])
				.filter(
					(x) =>
						config.modOptions[a].includes(x.name) ||
						config.modOptions[a].includes(`${x.group}:${x.name}`) ||
						(x.type === OptionType.conditional &&
							compileExpression(x.condition, {
								customProp: useDotAccessOperatorAndOptionalChaining
							})({ config }))
				)
				.flatMap((o) => o.loadAfter ?? [])
		]

		const loadBefore_B: (string | [string, string])[] = [
			...(manifestB.loadBefore ?? []),
			...(manifestB.options ?? [])
				.filter(
					(x) =>
						config.modOptions[b].includes(x.name) ||
						config.modOptions[b].includes(`${x.group}:${x.name}`) ||
						(x.type === OptionType.conditional &&
							compileExpression(x.condition, {
								customProp: useDotAccessOperatorAndOptionalChaining
							})({ config }))
				)
				.flatMap((o) => o.loadBefore ?? [])
		]

		const loadAfter_B: (string | [string, string])[] = [
			...(manifestB.loadAfter ?? []),
			...(manifestB.options ?? [])
				.filter(
					(x) =>
						config.modOptions[b].includes(x.name) ||
						config.modOptions[b].includes(`${x.group}:${x.name}`) ||
						(x.type === OptionType.conditional &&
							compileExpression(x.condition, {
								customProp: useDotAccessOperatorAndOptionalChaining
							})({ config }))
				)
				.flatMap((o) => o.loadAfter ?? [])
		]

		for (const lb of loadBefore_A) {
			if (typeof lb === "string") {
				if (lb === b) return -1
			} else if (lb[0] === b && semver.satisfies(manifestB.version, lb[1])) return -1
		}
		for (const la of loadAfter_A) {
			if (typeof la === "string") {
				if (la === b) return 1
			} else if (la[0] === b && semver.satisfies(manifestB.version, la[1])) return 1
		}
		for (const lb of loadBefore_B) {
			if (typeof lb === "string") {
				if (lb === a) return 1
			} else if (lb[0] === a && semver.satisfies(manifestA.version, lb[1])) return 1
		}
		for (const la of loadAfter_B) {
			if (typeof la === "string") {
				if (la === a) return -1
			} else if (la[0] === a && semver.satisfies(manifestA.version, la[1])) return -1
		}
		return 0
	})

	config.loadOrder = sorted
	await setConfig(config)
	return true
}

// ─── mod validation ───────────────────────────────────────────────────────────

export async function validateModFolder(modFolder: string): Promise<[boolean, string]> {
	const manifestPath = native.path.join(modFolder, "manifest.json")
	if (!(await native.fs.existsSync(manifestPath))) return [false, "No manifest"]

	let manifest: Manifest
	try {
		manifest = json5.parse(await native.fs.readFileSync(manifestPath, "utf8"))
	} catch {
		return [false, "Invalid manifest due to invalid JSON"]
	}

	if (!validateManifest(manifest)) {
		return [false, `Invalid manifest due to non-matching schema: ${new Ajv({ strict: false }).errorsText(validateManifest.errors)}`]
	}

	for (const contentFolder of [...(manifest.contentFolders ?? []), ...(manifest.options ?? []).flatMap((a) => a.contentFolders ?? [])]) {
		const cfPath = native.path.resolve(modFolder, contentFolder)
		if (!(await native.fs.existsSync(cfPath))) return [false, `Invalid content folder "${contentFolder}" due to nonexistent path`]

		const chunkFolders = await native.fs.readdirSync(cfPath)
		if (chunkFolders.length === 0) return [false, `Empty content folder "${contentFolder}"`]

		for (const chunkFolder of chunkFolders) {
			if (!chunkFolder.match(/chunk([0-9]*)/)) return [false, `Invalid chunk folder "${chunkFolder}" in "${contentFolder}"`]
		}
	}

	for (const blobsFolder of [...(manifest.blobsFolders ?? []), ...(manifest.options ?? []).flatMap((a) => a.blobsFolders ?? [])]) {
		const bfPath = native.path.resolve(modFolder, blobsFolder)
		if (!(await native.fs.existsSync(bfPath))) return [false, `Invalid blobs folder "${blobsFolder}" due to nonexistent path`]

		if ((await native.fs.readdirSync(bfPath)).length === 0) return [false, `Empty blobs folder "${blobsFolder}"`]
	}

	// validate select option groups
	const groups: Record<string, [number, number]> = {}
	for (const option of manifest.options ?? []) {
		if (option.type === OptionType.select) {
			groups[option.group] ??= [0, 0]
			groups[option.group][0]++
			if (option.enabledByDefault) groups[option.group][1]++
		}
	}
	for (const [group, [members, enabledByDefault]] of Object.entries(groups)) {
		if (members === 1) return [false, `Option group "${group}" has only one member`]
		if (enabledByDefault > 1) return [false, `Option group "${group}" has more than one member enabled by default`]
	}

	// validate JSON file schemas
	for (const { path: filePath } of await native.klaw(modFolder, { nodir: true })) {
		if (
			filePath.endsWith("entity.json") ||
			filePath.endsWith("entity.patch.json") ||
			filePath.endsWith("repository.json") ||
			filePath.endsWith("unlockables.json") ||
			filePath.endsWith("JSON.patch.json") ||
			filePath.endsWith("contract.json")
		) {
			let fileContents: unknown
			try {
				fileContents = JSON.parse(await native.fs.readFileSync(filePath, "utf8"))
			} catch {
				return [false, `Invalid file ${filePath} due to invalid JSON`]
			}

			const ext = filePath.split(".").slice(1).join(".")
			const ajv = new Ajv({ strict: false })
			if (ext === "entity.json") {
				const fc = fileContents as { quickEntityVersion?: number }
				if (fc.quickEntityVersion === 3.1 && !validateEntity(fileContents)) return [false, `Invalid file ${filePath}: ${ajv.errorsText(validateEntity.errors)}`]
			} else if (ext === "entity.patch.json") {
				const fc = fileContents as { patchVersion?: number }
				if (fc.patchVersion === 6 && !validateEntityPatch(fileContents)) return [false, `Invalid file ${filePath}: ${ajv.errorsText(validateEntityPatch.errors)}`]
			} else if (ext === "repository.json") {
				if (!validateRepository(fileContents)) return [false, `Invalid file ${filePath}: ${ajv.errorsText(validateRepository.errors)}`]
			} else if (ext === "unlockables.json") {
				if (!validateUnlockables(fileContents)) return [false, `Invalid file ${filePath}: ${ajv.errorsText(validateUnlockables.errors)}`]
			} else if (ext === "contract.json") {
				if (!validateContract(fileContents)) return [false, `Invalid file ${filePath}: ${ajv.errorsText(validateContract.errors)}`]
			} else if (ext === "JSON.patch.json") {
				if (!validateJSONPatch(fileContents)) return [false, `Invalid file ${filePath}: ${ajv.errorsText(validateJSONPatch.errors)}`]
			}
		}
	}

	return [true, ""]
}

// ─── mod validation cache ───────────────────────────────────────────────────
//
// validateModFolder() is the bigger remaining fs cost at list render: a full
// recursive klaw walk of a mod's folder, plus a readFileSync + Ajv schema
// validation for every entity.json / entity.patch.json / repository.json /
// unlockables.json / contract.json / JSON.patch.json it finds. Called
// per-card from Mod.svelte on mount, that's N visible cards each firing a
// walk + a pile of small reads, all in parallel, right on first paint.
//
// getModValidation() is the fix, in two parts:
//   - cache: results are kept in _validationCache, keyed by mod id, and
//     persisted alongside the rest of the mod index (see ModIndexEntry.validation
//     above) so a warm start never re-walks a mod whose content hasn't
//     changed *through the app itself*. Just like the manifest cache in
//     buildModIndex, this can't see hand-edits made directly inside a mod's
//     content folder without going through the app — that's what the manual
//     "Rebuild cache" button is for (it clears this cache too, via
//     clearModCache). What it does see: setModManifest (any edit made via the
//     authoring UI) and addModsToIndex (installs/updates) both invalidate the
//     entry for the mod they touched.
//   - defer + bound concurrency: a cold entry still has to pay for the walk,
//     but it yields a tick before starting (so the initial paint isn't
//     racing it) and only VALIDATION_CONCURRENCY walks run at once, so a
//     freshly-installed list of N mods doesn't fire N concurrent klaw walks
//     down the same invoke channel.
const VALIDATION_CONCURRENCY = 4
let _validationActive = 0
const _validationQueue: (() => void)[] = []

// A burst of cold cards resolving one after another would otherwise fire one
// full-index disk write per mod; coalesce them into a single write shortly
// after the last one lands.
let _persistDebounceTimer: ReturnType<typeof setTimeout> | null = null
function schedulePersistModIndex(): void {
	if (_persistDebounceTimer) clearTimeout(_persistDebounceTimer)
	_persistDebounceTimer = setTimeout(() => {
		_persistDebounceTimer = null
		void persistModIndex()
	}, 500)
}

async function withValidationSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (_validationActive >= VALIDATION_CONCURRENCY) {
		await new Promise<void>((resolve) => _validationQueue.push(resolve))
	}
	_validationActive++
	try {
		return await fn()
	} finally {
		_validationActive--
		_validationQueue.shift()?.()
	}
}

// A mod can be requested more than once before the first request resolves —
// e.g. the same mod appearing in a filtered list re-render, or Mod.svelte and
// the authoring page both mounting for it around the same time. Share the
// in-flight promise (same pattern as _configPromise above) so concurrent
// callers await one walk instead of each starting — and queuing for — their
// own redundant one.
const _validationInFlight = new Map<string, Promise<[boolean, string]>>()

/**
 * Cached, deferred, concurrency-limited wrapper around validateModFolder(),
 * keyed by mod id — this is what per-card UI (Mod.svelte, the authoring
 * page) should call instead of validateModFolder() directly. A warm cache
 * hit resolves immediately with no native calls at all; a cold entry is
 * queued behind VALIDATION_CONCURRENCY other walks and written back to the
 * persisted index once resolved.
 */
export async function getModValidation(id: string): Promise<[boolean, string]> {
	if (_validationCache.has(id)) return _validationCache.get(id)!
	if (_validationInFlight.has(id)) return _validationInFlight.get(id)!

	const promise = (async (): Promise<[boolean, string]> => {
		// yield to the render/paint pipeline before doing any native work, so a
		// page full of cold cards doesn't fire its walks in the same tick as layout
		await new Promise<void>((resolve) => setTimeout(resolve, 0))

		return withValidationSlot(async () => {
			const folder = await getModFolder(id)
			const result = await validateModFolder(folder)
			_validationCache.set(id, result)
			// best-effort write-through, same as the rest of the index — a failure
			// here just means the next start re-validates this mod once more
			schedulePersistModIndex()
			return result
		})
	})()

	_validationInFlight.set(id, promise)
	try {
		return await promise
	} finally {
		_validationInFlight.delete(id)
	}
}
