import * as ts from "./typescript"

import type { DeployInstruction, Manifest, ManifestOptionData, ModScript } from "./types"
import { compileExpression, useDotAccessOperatorAndOptionalChaining } from "filtrex"
import { FrameworkVersion, config, logger, paths, rpkgInstance } from "./core-singleton"
import { extractOrCopyToTemp, getQuickEntityFromPatchVersion, getQuickEntityFromVersion, hexflip } from "./utils"
import { resolveModFolder } from "./resolveModFolder"
import { beginModBuild, finishModBuildFailed, finishModBuildReady, getModBuild, getRpkgHashCacheEntries, setRpkgHashCacheEntries } from "../db"

import { OptionType } from "./types"
import { walk } from "./fsWalk"
import child_process from "child_process"
import fs from "fs-extra"
import json5 from "json5"
import md5 from "md5"
import mergeWith from "lodash.mergewith"
import path from "path"

import { wineCommand } from "../wineExec"
import { mergeDeployCompatibilityOptionData } from "../deployCompatibility"
import { normalizeManifest } from "../manifestCompatibility"
import { mergeLocalisationOverrides, parseLocalisationPatch } from "../localisationPatch"

/* ---------------------------------------------------------------------------------------------- */
/*   Shared with deploy.ts's "Execute instructions" phase - single source of truth so that the     */
/*   in-memory RPKGHashCache stays one real singleton instead of two independent copies.           */
/* ---------------------------------------------------------------------------------------------- */

export const thirdParty = (exe: string) => path.join(paths.toolsRoot, "Third-Party", exe)

/**
 * Also exposed to mod scripts as `utils.execCommand` (see types.ts) - on non-win32 this
 * transparently runs the command under Wine (see wineExec.ts), since every realistic command a
 * mod script or the deploy pipeline shells out to here is one of the bundled Windows tools.
 */
export const execCommand = function (command: string) {
	void logger.verbose(`Executing command ${command}`)
	const { command: wrapped, env } = wineCommand(command, paths.toolsRoot)
	// cwd is pinned to dataRoot rather than left to default to process.cwd() - on Windows,
	// execSync shells out through cmd.exe, which refuses to start at all if its cwd is a UNC path
	// (e.g. \\wsl.localhost\... when this app/repo is running from a WSL-hosted checkout).
	// dataRoot is never UNC in normal operation (userData, or a folder next to the game install -
	// see settings.ts's resolveTempDir()), so pinning it here sidesteps that regardless of where
	// the process itself was launched from.
	child_process.execSync(wrapped, { stdio: ["pipe", "pipe", "inherit"], cwd: paths.dataRoot, windowsHide: true, env })
}

export const callRPKGFunction = async function (command: string) {
	await logger.verbose(`Executing RPKG function ${command}`)
	return await rpkgInstance.callFunction(command)
}

export const RPKGHashCache: Record<string, [string, boolean]> = {}

export const getRPKGOfHash = async function (hash: string): Promise<string> {
	await logger.verbose(`Getting RPKG of hash ${hash}`)

	if (RPKGHashCache[hash]) {
		await logger.verbose(`Returning RPKG of hash ${hash} from cache`)
		return RPKGHashCache[hash][0]
	} else {
		try {
			const x = await rpkgInstance.getRPKGOfHash(config.runtimePath, hash)
			RPKGHashCache[hash] = [x, true] // true = newly discovered this session, not yet persisted
			return x
		} catch {
			const message = `Couldn't find ${hash} in the game files! Make sure your game is up-to-date and you've installed the framework in the right place.`
			await logger.error(message)

			// logger.error() above throws in the overwhelmingly common case (exitAfter defaults to
			// true), but stays a no-op if the "error" log level has been filtered out - throw here
			// too so a missing hash is always fatal regardless of logLevel configuration.
			throw new Error(message)
		}
	}
}

/** Load the db-backed RPKG-of-hash cache (`cache.db`'s `rpkg_hash_cache` table) into {@link RPKGHashCache}. Call once per process, before anything calls {@link getRPKGOfHash}. */
export function loadRPKGHashCache() {
	Object.assign(RPKGHashCache, Object.fromEntries(Object.entries(getRpkgHashCacheEntries()).map((a) => [a[0], [a[1], false]])))
}

/**
 * Persist newly-discovered entries in {@link RPKGHashCache} back to `cache.db`. Only saves entries
 * marked as new (the boolean second element, set `true` by {@link getRPKGOfHash} on discovery) -
 * entries loaded from DB via {@link loadRPKGHashCache} are `false` and are never written back.
 *
 * LEI-147: full-snapshot saves caused last-writer-wins data loss with concurrent build workers:
 * each worker loaded a snapshot at T0, discovered different new hashes, then saved its entire
 * in-memory object back - overwriting whatever the other workers wrote after T0. Writing only the
 * delta makes concurrent saves compose correctly (INSERT OR UPDATE on individual rows).
 */
export function saveRPKGHashCache() {
	const newEntries: Record<string, string> = {}
	for (const [hash, [rpkgName, isNew]] of Object.entries(RPKGHashCache)) {
		if (isNew) newEntries[hash] = rpkgName
	}
	if (Object.keys(newEntries).length > 0) {
		setRpkgHashCacheEntries(newEntries)
	}
}

const deepMerge = function (x: any, y: any) {
	return mergeWith(x, y, (orig, src) => {
		if (Array.isArray(orig)) {
			return src
		}
	})
}

/* ---------------------------------------------------------------------------------------------- */
/*                              Per-mod build cache (cache.db-backed)                              */
/* ---------------------------------------------------------------------------------------------- */

const BLOB_MARKER = "__smfBlob__"

async function blobToJSON(blob: Blob): Promise<any> {
	return {
		[BLOB_MARKER]: true,
		data: Buffer.from(await blob.arrayBuffer()).toString("base64"),
		type: blob.type
	}
}

function jsonToBlob(value: any): Blob {
	return new Blob([Buffer.from(value.data, "base64")], value.type ? { type: value.type } : undefined)
}

/**
 * DeployInstruction, but JSON-safe - virtual content/blobs' live `Blob`s (which a mod's analysis
 * script may have added) become base64 markers instead. Stored as-is in `cache.db`'s
 * `mod_build.deployInstructionJson` column.
 */
export async function serialiseDeployInstruction(deployInstruction: DeployInstruction): Promise<string> {
	const content = await Promise.all(deployInstruction.content.map(async (entry) => (entry.source === "virtual" ? { ...entry, content: await blobToJSON(entry.content) } : entry)))

	const blobs = await Promise.all(deployInstruction.blobs.map(async (entry) => (entry.source === "virtual" ? { ...entry, content: await blobToJSON(entry.content) } : entry)))

	const rpkgTypes: any = {}
	for (const [chunk, data] of Object.entries(deployInstruction.rpkgTypes)) {
		rpkgTypes[chunk] = data.type === "base" && data.chunkMeta instanceof Blob ? { type: "base", chunkMeta: await blobToJSON(data.chunkMeta) } : data
	}

	return JSON.stringify({ ...deployInstruction, content, blobs, rpkgTypes })
}

/** Inverse of {@link serialiseDeployInstruction}. */
export function deserialiseDeployInstruction(serialised: string): DeployInstruction {
	const parsed: any = JSON.parse(serialised)

	const restoreBlob = (value: any) => (value && typeof value === "object" && value[BLOB_MARKER] ? jsonToBlob(value) : value)

	parsed.content = parsed.content.map((entry: any) => (entry.source === "virtual" ? { ...entry, content: restoreBlob(entry.content) } : entry))
	parsed.blobs = parsed.blobs.map((entry: any) => (entry.source === "virtual" ? { ...entry, content: restoreBlob(entry.content) } : entry))

	for (const chunk of Object.keys(parsed.rpkgTypes)) {
		if (parsed.rpkgTypes[chunk].type === "base") {
			parsed.rpkgTypes[chunk].chunkMeta = restoreBlob(parsed.rpkgTypes[chunk].chunkMeta)
		}
	}

	return parsed as DeployInstruction
}

/** What `deploy.ts` actually reads at deploy time - the last successfully-built `DeployInstruction` for this mod, straight from `cache.db`, with no re-analysis. `undefined` if this mod has never been built, or its last build failed. */
export function loadReadyDeployInstruction(modId: string): DeployInstruction | undefined {
	const build = getModBuild(modId)
	if (!build || build.status !== "ready" || !build.deployInstructionJson) return undefined
	return deserialiseDeployInstruction(build.deployInstructionJson)
}

/* ---------------------------------------------------------------------------------------------- */
/*                                            analyseMod                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Builds a single framework mod's `DeployInstruction` (disk walk, manifest/option resolution,
 * analysis script) and writes the result to `cache.db` as that mod's ready-to-deploy build.
 *
 * LEI-141: this is now the *only* place a mod's deploy instruction ever gets computed, and it only
 * ever runs when something that could change the result actually happened - a mod was added or
 * updated, its selected options changed, or the user explicitly asked for a rebuild (see
 * `ipcHandlers.ts`'s trigger points). There is no fingerprint/hash cache-hit check here anymore
 * (no `manifestHash`/`optionsHash`, no on-disk `cache/analysis/<id>.json`) - the old version of this
 * function recomputed a size+mtime fingerprint of every one of the mod's files on *every* call just
 * to decide whether it could skip the real work; now the decision of "does this need rebuilding" is
 * made once, by the caller, at the moment of the triggering event, not re-derived speculatively
 * inside this function on every invocation. Calling this function *is* the decision - it always
 * does the real work.
 *
 * `status` in `cache.db`'s `mod_build` table (`building` while this function is running, `ready`/
 * `failed` once it finishes) exists purely for crash-safety - if the process dies mid-build, the row
 * is left at `building` forever, which `deploy.ts`/the queue-aware deploy gate (`deployManager.ts`)
 * both treat as "not ready", the same as if it had never started. It is not a staleness signal.
 *
 * `mod` may be either a mod ID or an exact Mods/ folder name - resolved via `resolveModFolder()`
 * (a `cache.db` lookup, not a live directory scan - see that module's doc comment).
 *
 * Returns `undefined` for RPKG-only mods (no manifest.json) - those are staged directly during
 * deploy and never produce a DeployInstruction, so there's nothing here to build or cache.
 *
 * Caveat: this assumes a mod's `analysis` script is a pure function of its own manifest/context,
 * per the documented contract (docs/Scripts.md: "beforeDeploy" - not "analysis" - is where
 * load-order-sensitive work should happen). A script that reaches outside its own deployInstruction
 * (e.g. depends on another mod's state or load-order position at analysis time) would be
 * precomputed-and-cached in isolation here, which could change its behaviour. There are no shipped
 * mod scripts in this repo to audit against; this is enforced by documentation/convention only, not
 * by the type system.
 */
export default async function analyseMod(mod: string): Promise<DeployInstruction | undefined> {
	const resolved = resolveModFolder(mod)

	if (!resolved) {
		await logger.error(`Could not resolve mod ${mod} to its folder in Mods! Try "Rebuild cache" if this mod was added/changed outside the Mod Manager.`)
		return undefined
	}

	if (!resolved.isFrameworkMod) {
		await logger.warn(`"${mod}" is an RPKG-only mod (no manifest.json) - these are staged directly during deploy and have no build to cache.`)
		return undefined
	}

	const modFolder = resolved.folder

	// `resolved.manifest` (from `cache.db`'s `mods.manifestJson`) was already parsed once by
	// `ModIndex` using json5 (manifest.json is authored as JSON5 - comments, trailing commas) -
	// prefer it over re-reading and re-parsing the file here. Only falls back to a fresh disk read
	// if the index somehow doesn't have a cached manifest for a mod it otherwise resolved (should
	// only happen right after a partial/interrupted index write).
	const manifest: Manifest = ((resolved.manifest as unknown as Manifest) ?? normalizeManifest(json5.parse(fs.readFileSync(path.join(config.modsPath, modFolder, "manifest.json"), "utf8")))) as unknown as Manifest

	beginModBuild(manifest.id)

	try {
		await logger.info(`Analysing framework mod: ${manifest.name}`)

		let contentFolders: string[] = []
		let blobsFolders: string[] = []

		const scripts: string[][] = []

		for (const contentFolder of manifest.contentFolders || []) {
			if (contentFolder?.length && fs.existsSync(path.join(config.modsPath, modFolder, contentFolder)) && fs.readdirSync(path.join(config.modsPath, modFolder, contentFolder)).length) {
				contentFolders.push(contentFolder)
			}
		}

		for (const blobsFolder of manifest.blobsFolders || []) {
			if (blobsFolder?.length && fs.existsSync(path.join(config.modsPath, modFolder, blobsFolder)) && fs.readdirSync(path.join(config.modsPath, modFolder, blobsFolder)).length) {
				blobsFolders.push(blobsFolder)
			}
		}

		if (manifest.scripts) scripts.push(manifest.scripts)

		if (config.modOptions[manifest.id] && manifest.options && manifest.options.length) {
			await logger.verbose("Merging mod options")

			for (const option of manifest.options.filter(
				(a) =>
					(a.type === OptionType.checkbox && config.modOptions[manifest.id].includes(a.name)) ||
					(a.type === OptionType.select && config.modOptions[manifest.id].includes(`${a.group}:${a.name}`)) ||
					(a.type === OptionType.conditional &&
						compileExpression(a.condition, {
							customProp: useDotAccessOperatorAndOptionalChaining
						})({
							config
						}))
			)) {
				for (const contentFolder of option.contentFolders || []) {
					if (contentFolder?.length && fs.existsSync(path.join(config.modsPath, modFolder, contentFolder)) && fs.readdirSync(path.join(config.modsPath, modFolder, contentFolder)).length) {
						contentFolders.push(contentFolder)
					}
				}

				for (const blobsFolder of option.blobsFolders || []) {
					if (blobsFolder?.length && fs.existsSync(path.join(config.modsPath, modFolder, blobsFolder)) && fs.readdirSync(path.join(config.modsPath, modFolder, blobsFolder)).length) {
						blobsFolders.push(blobsFolder)
					}
				}

				if (!manifest.localisation) manifest.localisation = {} as ManifestOptionData["localisation"]
				if (option.localisation) deepMerge(manifest.localisation, option.localisation)

				if (!manifest.localisationOverrides) manifest.localisationOverrides = {}
				if (option.localisationOverrides) deepMerge(manifest.localisationOverrides, option.localisationOverrides)

				if (!manifest.localisedLines) manifest.localisedLines = {}
				if (option.localisedLines) deepMerge(manifest.localisedLines, option.localisedLines)

				if (!manifest.dependencies) manifest.dependencies = []
				if (option.dependencies) manifest.dependencies.push(...option.dependencies)

				mergeDeployCompatibilityOptionData(manifest, option)

				if (!manifest.packagedefinition) manifest.packagedefinition = []
				if (option.packagedefinition) manifest.packagedefinition.push(...option.packagedefinition)

				if (!manifest.thumbs) manifest.thumbs = []
				if (option.thumbs) manifest.thumbs.push(...option.thumbs)

				if (!manifest.peacockPlugins) manifest.peacockPlugins = []
				if (option.peacockPlugins) manifest.peacockPlugins.push(...option.peacockPlugins)

				if (option.scripts) scripts.push(option.scripts)
			}
		}

		contentFolders = [...new Set(contentFolders)]
		blobsFolders = [...new Set(blobsFolders)]

		const content: DeployInstruction["content"] = []
		const blobs: DeployInstruction["blobs"] = []
		const rpkgTypes: DeployInstruction["rpkgTypes"] = {}

		for (const contentFolder of [...contentFolders].sort()) {
			for (const chunkFolder of fs.readdirSync(path.join(config.modsPath, modFolder, contentFolder)).sort()) {
				for (const contentFile of (await walk(path.join(config.modsPath, modFolder, contentFolder, chunkFolder))).filter((a) => a.stats.isFile()).sort((a, b) => a.path.localeCompare(b.path))) {
					const contentFilePath = contentFile.path
					if (path.basename(contentFilePath) === "localisation.patch.json") {
						const patch = parseLocalisationPatch(JSON.parse(fs.readFileSync(contentFilePath, "utf8")), contentFilePath)
						manifest.localisationOverrides ??= {}
						mergeLocalisationOverrides(manifest.localisationOverrides, patch)
						continue
					}
					const contentType = path.basename(contentFilePath).split(".").slice(1).join(".")

					await logger.verbose(`Registering ${contentType} file ${contentFilePath}`)

					content.push({
						source: "disk",
						chunk: Number(chunkFolder.replace(/chunk/gi, "")),
						path: contentFilePath,
						type: contentType
					})
				}

				/* ------------------------------ Copy chunk meta to staging folder ----------------------------- */
				if (fs.existsSync(path.join(config.modsPath, modFolder, contentFolder, chunkFolder, `${chunkFolder}.meta`))) {
					rpkgTypes[chunkFolder] = {
						type: "base",
						chunkMeta: path.join(config.modsPath, modFolder, contentFolder, chunkFolder, `${chunkFolder}.meta`)
					}
				} else {
					rpkgTypes[chunkFolder] = {
						type: "patch"
					}
				}
			}
		}

		for (const blobsFolder of blobsFolders) {
			for (const blobFile of (await walk(path.join(config.modsPath, modFolder, blobsFolder))).filter((a) => a.stats.isFile())) {
				const blob = blobFile.path
				const blobPath = blob.replace(path.join(config.modsPath, modFolder, blobsFolder), "").slice(1).split(path.sep).join("/").toLowerCase()

				let blobHash: string
				if (path.extname(blob).startsWith(".jp") || path.extname(blob) === ".png") {
					blobHash = `00${md5(`[assembly:/_pro/online/default/cloudstorage/resources/${blobPath}].pc_gfx`.toLowerCase()).slice(2, 16).toUpperCase()}`
				} else if (path.extname(blob) === ".json") {
					blobHash = `00${md5(`[assembly:/_pro/online/default/cloudstorage/resources/${blobPath}].pc_json`.toLowerCase()).slice(2, 16).toUpperCase()}`
				} else {
					blobHash = `00${md5(`[assembly:/_pro/online/default/cloudstorage/resources/${blobPath}].pc_${path.extname(blob).slice(1)}`.toLowerCase())
						.slice(2, 16)
						.toUpperCase()}`
				}

				blobs.push({
					source: "disk",
					filePath: blob,
					blobPath,
					blobHash
				})
			}
		}

		const deployInstruction: DeployInstruction = {
			id: manifest.id,
			name: manifest.name,
			version: manifest.version,
			cacheFolder: manifest.id,
			manifestSources: {
				localisation: manifest.localisation,
				localisationOverrides: manifest.localisationOverrides,
				localisedLines: manifest.localisedLines,
				dependencies: manifest.dependencies,
				requirements: manifest.requirements,
				incompatibilities: manifest.incompatibilities,
				loadBefore: manifest.loadBefore,
				loadAfter: manifest.loadAfter,
				supportedPlatforms: manifest.supportedPlatforms,
				packagedefinition: manifest.packagedefinition,
				thumbs: manifest.thumbs,
				peacockPlugins: (manifest.peacockPlugins || []).map((a) => path.join(config.modsPath, modFolder, a)),
				scripts
			},
			content,
			blobs,
			rpkgTypes
		}

		if (deployInstruction.manifestSources.scripts.length) {
			for (const files of deployInstruction.manifestSources.scripts) {
				const compiledScriptPath = await ts.compile(
					files.map((a) => path.join(config.modsPath, modFolder, a)),
					{ target: "es2019" },
					path.join(config.modsPath, modFolder)
				)

				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const modScript = (await require(compiledScriptPath)) as ModScript

				fs.ensureDirSync(path.join(paths.dataRoot, "scriptTempFolder"))

				await modScript.analysis(
					{
						config,
						deployInstruction,
						modRoot: path.join(config.modsPath, modFolder),
						tempFolder: path.join(paths.dataRoot, "scriptTempFolder")
					},
					{
						rpkg: {
							callRPKGFunction,
							getRPKGOfHash,
							async extractFileFromRPKG(hash: string, rpkg: string) {
								await logger.verbose(`Extracting ${hash} from ${rpkg}`)
								await rpkgInstance.callFunction(
									`-extract_from_rpkg "${path.join(config.runtimePath, `${rpkg}.rpkg`)}" -filter "${hash}" -output_path ${path.join(paths.dataRoot, "scriptTempFolder")}`
								)
							}
						},
						utils: {
							execCommand,
							extractOrCopyToTemp,
							getQuickEntityFromVersion,
							getQuickEntityFromPatchVersion,
							hexflip
						},
						logger: {
							verbose: (a) => logger.verbose(a, manifest.name),
							debug: (a) => logger.debug(a, manifest.name),
							info: (a) => logger.info(a, manifest.name),
							warn: (a) => logger.warn(a, manifest.name),
							error: (a, b) => logger.error(a, b, manifest.name)
						}
					}
				)

				fs.removeSync(path.join(paths.dataRoot, "scriptTempFolder"))
			}
		}

		finishModBuildReady(manifest.id, FrameworkVersion, await serialiseDeployInstruction(deployInstruction))

		return deployInstruction
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		finishModBuildFailed(manifest.id, message)
		throw err
	}
}
