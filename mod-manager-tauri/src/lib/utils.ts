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

// ─── mod-level caches (cleared after install/uninstall) ───────────────────

let _modFolderCache = new Map<string, string>()
let _isFrameworkCache = new Map<string, boolean>()
let _manifestCache = new Map<string, Manifest>()
let _allModsCache: string[] | null = null

// A single in-flight scan of the Mods directory shared by every lookup below.
// Without it, getModFolder/getManifestFromModID each re-walk the whole Mods
// folder, so resolving a load order of N mods costs O(N²) sequential native
// fs round-trips — painfully slow on a real install over a slow mount (e.g.
// WSL /mnt drvfs, ~45s to first render). Building the index does one readdir
// plus a parallel manifest read per entry, and populates all caches at once.
let _modIndex: Promise<void> | null = null

function buildModIndex(): Promise<void> {
	if (_modIndex) return _modIndex
	_modIndex = (async () => {
		const modsDir = native.path.join("..", "Mods")
		const entries = await native.fs.readdirSync(modsDir)
		// resolve every entry in parallel, but keep readdir order in the result
		const ids = await Promise.all(
			entries.map(async (entry) => {
				if (entry === "Managed by SMF, do not touch") return null
				const fullPath = native.path.resolve(native.path.join(modsDir, entry))
				const manifestPath = native.path.join(fullPath, "manifest.json")
				if (await native.fs.existsSync(manifestPath)) {
					try {
						const mf: Manifest = json5.parse(await native.fs.readFileSync(manifestPath, "utf8"))
						_modFolderCache.set(mf.id, fullPath)
						_manifestCache.set(mf.id, mf)
						_isFrameworkCache.set(mf.id, true)
						return mf.id
					} catch {
						// malformed manifest — fall through and treat as a bare folder
					}
				}
				// no (valid) manifest: an RPKG / bare mod keyed by its folder name
				_modFolderCache.set(entry, fullPath)
				_isFrameworkCache.set(entry, false)
				return entry
			})
		)
		_allModsCache = ids.filter((id): id is string => id !== null)
	})()
	return _modIndex
}

export function clearModCache(): void {
	_modFolderCache.clear()
	_isFrameworkCache.clear()
	_manifestCache.clear()
	_allModsCache = null
	_modIndex = null
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
	_manifestCache.delete(modID)
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
