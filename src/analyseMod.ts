import * as ts from "./typescript"

import type { DeployInstruction, Manifest, ManifestOptionData, ModScript } from "./types"
import { ModuleKind, ScriptTarget } from "typescript"
import { compileExpression, useDotAccessOperatorAndOptionalChaining } from "filtrex"
import { FrameworkVersion, config, logger, paths, rpkgInstance } from "./core-singleton"
import { extractOrCopyToTemp, getQuickEntityFromPatchVersion, getQuickEntityFromVersion, hexflip, winPathEscape } from "./utils"

import { OptionType } from "./types"
import child_process from "child_process"
import fs from "fs-extra"
import json5 from "json5"
import klaw from "klaw-sync"
import md5 from "md5"
import mergeWith from "lodash.mergewith"
import path from "path"

/* ---------------------------------------------------------------------------------------------- */
/*   Shared with deploy.ts's "Execute instructions" phase - single source of truth so that the     */
/*   in-memory RPKGHashCache stays one real singleton instead of two independent copies.           */
/* ---------------------------------------------------------------------------------------------- */

export const thirdParty = (exe: string) => path.join(paths.toolsRoot, "Third-Party", exe)

export const execCommand = function (command: string) {
	void logger.verbose(`Executing command ${command}`)
	child_process.execSync(command, { stdio: ["pipe", "pipe", "inherit"] })
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
			RPKGHashCache[hash] = [x, false]
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

/** Load the on-disk RPKG-of-hash cache into {@link RPKGHashCache}. Call once per process, before anything calls {@link getRPKGOfHash}. */
export function loadRPKGHashCache() {
	if (fs.existsSync(path.join(paths.dataRoot, "cache", "rpkgHashCache.json"))) {
		Object.assign(
			RPKGHashCache,
			Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(paths.dataRoot, "cache", "rpkgHashCache.json"), "utf8"))).map((a) => [a[0], [a[1], false]]))
		)
	}
}

/** Persist {@link RPKGHashCache} back to disk. Call once at the end of the process. */
export function saveRPKGHashCache() {
	fs.ensureDirSync(path.join(paths.dataRoot, "cache"))
	fs.writeFileSync(
		path.join(paths.dataRoot, "cache", "rpkgHashCache.json"),
		JSON.stringify(
			Object.fromEntries(
				Object.entries(RPKGHashCache)
					.filter((a) => !a[1][0])
					.map((a) => [a[0], a[1][0]])
			)
		)
	)
}

const deepMerge = function (x: any, y: any) {
	return mergeWith(x, y, (orig, src) => {
		if (Array.isArray(orig)) {
			return src
		}
	})
}

/* ---------------------------------------------------------------------------------------------- */
/*                                    Per-mod analysis cache                                       */
/* ---------------------------------------------------------------------------------------------- */

export interface AnalysisCacheEntry {
	frameworkVersion: string
	manifestHash: string
	optionsHash: string
	/** JSON-serialised DeployInstruction; virtual content/blobs' Blobs are base64-encoded (see {@link serialiseDeployInstruction}). */
	deployInstruction: string
}

export function analysisCacheDir(): string {
	return path.join(paths.dataRoot, "cache", "analysis")
}

export function analysisCachePath(modId: string): string {
	return path.join(analysisCacheDir(), `${winPathEscape(modId)}.json`)
}

export function loadAnalysisCache(modId: string): AnalysisCacheEntry | undefined {
	const cachePath = analysisCachePath(modId)

	if (!fs.existsSync(cachePath)) {
		return undefined
	}

	try {
		return JSON.parse(fs.readFileSync(cachePath, "utf8"))
	} catch {
		return undefined
	}
}

export function saveAnalysisCache(modId: string, entry: AnalysisCacheEntry) {
	fs.ensureDirSync(analysisCacheDir())
	fs.writeFileSync(analysisCachePath(modId), JSON.stringify(entry))
}

/**
 * Hash of everything selected-options-related that could change what {@link analyseMod} produces
 * for this mod - the "resolved options hash" half of the cache key.
 */
export function computeOptionsHash(manifest: Manifest): string {
	const hasConditionalOption = (manifest.options || []).some((option) => option.type === OptionType.conditional)

	if (hasConditionalOption) {
		// Conditional options are evaluated against the *entire* effective config via a filtrex
		// expression string (e.g. `config.loadOrder.includes(...)`, `config.modOptions.SomeMod`),
		// so we can't know in general which slice of config a given condition depends on - be
		// conservative and key on the whole config when a mod uses this feature.
		return md5(JSON.stringify(config))
	}

	return md5(JSON.stringify([...(config.modOptions[manifest.id] || [])].sort()))
}

const BLOB_MARKER = "__smfBlob__"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function blobToJSON(blob: Blob): Promise<any> {
	return {
		[BLOB_MARKER]: true,
		data: Buffer.from(await blob.arrayBuffer()).toString("base64"),
		type: blob.type
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonToBlob(value: any): Blob {
	return new Blob([Buffer.from(value.data, "base64")], value.type ? { type: value.type } : undefined)
}

/**
 * DeployInstruction, but JSON-safe - virtual content/blobs' live `Blob`s (which a mod's analysis
 * script may have added) become base64 markers instead.
 */
export async function serialiseDeployInstruction(deployInstruction: DeployInstruction): Promise<string> {
	const content = await Promise.all(deployInstruction.content.map(async (entry) => (entry.source === "virtual" ? { ...entry, content: await blobToJSON(entry.content) } : entry)))

	const blobs = await Promise.all(deployInstruction.blobs.map(async (entry) => (entry.source === "virtual" ? { ...entry, content: await blobToJSON(entry.content) } : entry)))

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const rpkgTypes: any = {}
	for (const [chunk, data] of Object.entries(deployInstruction.rpkgTypes)) {
		rpkgTypes[chunk] = data.type === "base" && data.chunkMeta instanceof Blob ? { type: "base", chunkMeta: await blobToJSON(data.chunkMeta) } : data
	}

	return JSON.stringify({ ...deployInstruction, content, blobs, rpkgTypes })
}

/** Inverse of {@link serialiseDeployInstruction}. */
export function deserialiseDeployInstruction(serialised: string): DeployInstruction {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const parsed: any = JSON.parse(serialised)

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const restoreBlob = (value: any) => (value && typeof value === "object" && value[BLOB_MARKER] ? jsonToBlob(value) : value)

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	parsed.content = parsed.content.map((entry: any) => (entry.source === "virtual" ? { ...entry, content: restoreBlob(entry.content) } : entry))
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	parsed.blobs = parsed.blobs.map((entry: any) => (entry.source === "virtual" ? { ...entry, content: restoreBlob(entry.content) } : entry))

	for (const chunk of Object.keys(parsed.rpkgTypes)) {
		if (parsed.rpkgTypes[chunk].type === "base") {
			parsed.rpkgTypes[chunk].chunkMeta = restoreBlob(parsed.rpkgTypes[chunk].chunkMeta)
		}
	}

	return parsed as DeployInstruction
}

/* ---------------------------------------------------------------------------------------------- */
/*                                            analyseMod                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Analyse a single framework mod (disk walk, manifest/option resolution, analysis script) and
 * return its DeployInstruction, using the on-disk analysis cache when the mod's manifest/content
 * and its currently-selected options haven't changed since the cache entry was written.
 *
 * This is the extracted body of what used to be deploy()'s per-mod "Analyse mods" work for
 * framework mods (mods with a manifest.json). It's meant to be invoked out of band - via the
 * `--analyseMod <id>` CLI command, whenever a mod is added/updated or its selected options change
 * - so that deploy() can load a cached result instead of re-walking/re-parsing every mod on every
 * deploy. deploy() also falls back to calling this inline for any mod that has no valid cache
 * entry yet, so a cache miss just means "as slow as today," never a hard failure.
 *
 * `mod` may be either a mod ID (looked up against every Mods/* manifest.json) or an exact Mods/
 * folder name, matching the resolution deploy.ts's main loop and discover.ts both do.
 *
 * Returns `undefined` for RPKG-only mods (no manifest.json) - those are staged directly during
 * deploy and never produce a DeployInstruction, so there's nothing here to analyse or cache.
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
	// NOT Mod folder exists, mod has no manifest, mod has RPKGs (mod is an RPKG-only mod) - same
	// resolution deploy.ts's main loop and discover.ts both do: `mod` may be an ID rather than a
	// folder name, so find the folder whose manifest.json has this ID.
	if (
		!(
			fs.existsSync(path.join(config.modsPath, mod)) &&
			!fs.existsSync(path.join(config.modsPath, mod, "manifest.json")) &&
			klaw(path.join(config.modsPath, mod))
				.filter((a) => a.stats.isFile())
				.map((a) => a.path)
				.some((a) => a.endsWith(".rpkg"))
		)
	) {
		const foundMod = fs
			.readdirSync(config.modsPath)
			.find((a) => fs.existsSync(path.join(config.modsPath, a, "manifest.json")) && json5.parse(fs.readFileSync(path.join(config.modsPath, a, "manifest.json"), "utf8")).id === mod)

		if (!foundMod) {
			await logger.error(`Could not resolve mod ${mod} to its folder in Mods!`)
			return undefined
		}

		mod = foundMod
	}

	const manifestPath = path.join(config.modsPath, mod, "manifest.json")

	if (!fs.existsSync(manifestPath)) {
		await logger.warn(`"${mod}" is an RPKG-only mod (no manifest.json) - these are staged directly during deploy and have no analysis to cache.`)
		return undefined
	}

	const manifestRaw = fs.readFileSync(manifestPath, "utf8")
	const manifest: Manifest = json5.parse(manifestRaw)

	await logger.info(`Analysing framework mod: ${manifest.name}`)

	let contentFolders: string[] = []
	let blobsFolders: string[] = []

	const scripts: string[][] = []

	for (const contentFolder of manifest.contentFolders || []) {
		if (contentFolder?.length && fs.readdirSync(path.join(config.modsPath, mod, contentFolder)).length) {
			contentFolders.push(contentFolder)
		}
	}

	for (const blobsFolder of manifest.blobsFolders || []) {
		if (blobsFolder?.length && fs.readdirSync(path.join(config.modsPath, mod, blobsFolder)).length) {
			blobsFolders.push(blobsFolder)
		}
	}

	manifest.scripts && scripts.push(manifest.scripts)

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
				if (contentFolder?.length && fs.existsSync(path.join(config.modsPath, mod, contentFolder)) && fs.readdirSync(path.join(config.modsPath, mod, contentFolder)).length) {
					contentFolders.push(contentFolder)
				}
			}

			for (const blobsFolder of option.blobsFolders || []) {
				if (blobsFolder?.length && fs.existsSync(path.join(config.modsPath, mod, blobsFolder)) && fs.readdirSync(path.join(config.modsPath, mod, blobsFolder)).length) {
					blobsFolders.push(blobsFolder)
				}
			}

			manifest.localisation || (manifest.localisation = {} as ManifestOptionData["localisation"])
			option.localisation && deepMerge(manifest.localisation, option.localisation)

			manifest.localisationOverrides || (manifest.localisationOverrides = {})
			option.localisationOverrides && deepMerge(manifest.localisationOverrides, option.localisationOverrides)

			manifest.localisedLines || (manifest.localisedLines = {})
			option.localisedLines && deepMerge(manifest.localisedLines, option.localisedLines)

			manifest.dependencies || (manifest.dependencies = [])
			option.dependencies && manifest.dependencies.push(...option.dependencies)

			manifest.requirements || (manifest.requirements = [])
			option.requirements && manifest.requirements.push(...option.requirements)

			manifest.supportedPlatforms || (manifest.supportedPlatforms = [])
			option.supportedPlatforms && manifest.supportedPlatforms.push(...option.supportedPlatforms)

			manifest.packagedefinition || (manifest.packagedefinition = [])
			option.packagedefinition && manifest.packagedefinition.push(...option.packagedefinition)

			manifest.thumbs || (manifest.thumbs = [])
			option.thumbs && manifest.thumbs.push(...option.thumbs)

			manifest.peacockPlugins || (manifest.peacockPlugins = [])
			option.peacockPlugins && manifest.peacockPlugins.push(...option.peacockPlugins)

			option.scripts && scripts.push(option.scripts)
		}
	}

	contentFolders = [...new Set(contentFolders)]
	blobsFolders = [...new Set(blobsFolders)]

	const content: DeployInstruction["content"] = []
	const blobs: DeployInstruction["blobs"] = []
	const rpkgTypes: DeployInstruction["rpkgTypes"] = {}

	// Fingerprint of every file that can affect this mod's output - manifest.json, every file in
	// its resolved content/blobs folders, and its script files. This is the "manifest hash" half
	// of the cache key. Cheap: klaw-sync has already stat'd every entry for the walk below, so
	// this is just capturing data that's already in memory, not extra I/O.
	const fingerprint: { path: string; size: number; mtimeMs: number }[] = [{ path: "manifest.json", size: manifestRaw.length, mtimeMs: fs.statSync(manifestPath).mtimeMs }]

	for (const contentFolder of contentFolders) {
		for (const chunkFolder of fs.readdirSync(path.join(config.modsPath, mod, contentFolder))) {
			for (const contentFile of klaw(path.join(config.modsPath, mod, contentFolder, chunkFolder)).filter((a) => a.stats.isFile())) {
				const contentFilePath = contentFile.path
				const contentType = path.basename(contentFilePath).split(".").slice(1).join(".")

				await logger.verbose(`Registering ${contentType} file ${contentFilePath}`)

				fingerprint.push({ path: path.relative(path.join(config.modsPath, mod), contentFilePath), size: contentFile.stats.size, mtimeMs: contentFile.stats.mtimeMs })

				content.push({
					source: "disk",
					chunk: Number(chunkFolder.replace(/chunk/gi, "")),
					path: contentFilePath,
					type: contentType
				})
			}

			/* ------------------------------ Copy chunk meta to staging folder ----------------------------- */
			if (fs.existsSync(path.join(config.modsPath, mod, contentFolder, chunkFolder, `${chunkFolder}.meta`))) {
				rpkgTypes[chunkFolder] = {
					type: "base",
					chunkMeta: path.join(config.modsPath, mod, contentFolder, chunkFolder, `${chunkFolder}.meta`)
				}
			} else {
				rpkgTypes[chunkFolder] = {
					type: "patch"
				}
			}
		}
	}

	for (const blobsFolder of blobsFolders) {
		for (const blobFile of klaw(path.join(config.modsPath, mod, blobsFolder)).filter((a) => a.stats.isFile())) {
			const blob = blobFile.path
			const blobPath = blob.replace(path.join(config.modsPath, mod, blobsFolder), "").slice(1).split(path.sep).join("/").toLowerCase()

			fingerprint.push({ path: path.relative(path.join(config.modsPath, mod), blob), size: blobFile.stats.size, mtimeMs: blobFile.stats.mtimeMs })

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

	for (const files of scripts) {
		for (const file of files) {
			const scriptPath = path.join(config.modsPath, mod, file)
			if (fs.existsSync(scriptPath)) {
				const stats = fs.statSync(scriptPath)
				fingerprint.push({ path: file, size: stats.size, mtimeMs: stats.mtimeMs })
			}
		}
	}

	const deployInstruction: DeployInstruction = {
		id: manifest.id,
		name: manifest.name,
		cacheFolder: manifest.id,
		manifestSources: {
			localisation: manifest.localisation,
			localisationOverrides: manifest.localisationOverrides,
			localisedLines: manifest.localisedLines,
			dependencies: manifest.dependencies,
			requirements: manifest.requirements,
			supportedPlatforms: manifest.supportedPlatforms,
			packagedefinition: manifest.packagedefinition,
			thumbs: manifest.thumbs,
			peacockPlugins: (manifest.peacockPlugins || []).map((a) => path.join(config.modsPath, mod, a)),
			scripts
		},
		content,
		blobs,
		rpkgTypes
	}

	fingerprint.sort((a, b) => a.path.localeCompare(b.path))
	const manifestHash = md5(JSON.stringify(fingerprint))
	const optionsHash = computeOptionsHash(manifest)

	const cached = loadAnalysisCache(manifest.id)
	if (cached && cached.frameworkVersion === FrameworkVersion && cached.manifestHash === manifestHash && cached.optionsHash === optionsHash) {
		await logger.info(`${manifest.name} is unchanged since its last analysis - using the cached deploy instruction`)
		return deserialiseDeployInstruction(cached.deployInstruction)
	}

	if (deployInstruction.manifestSources.scripts.length) {
		for (const files of deployInstruction.manifestSources.scripts) {
			const compiledScriptPath = ts.compile(
				files.map((a) => path.join(config.modsPath, mod, a)),
				{
					esModuleInterop: true,
					allowJs: true,
					target: ScriptTarget.ES2019,
					module: ModuleKind.CommonJS,
					resolveJsonModule: true
				},
				path.join(config.modsPath, mod)
			)

			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const modScript = (await require(compiledScriptPath)) as ModScript

			fs.ensureDirSync(path.join(paths.dataRoot, "scriptTempFolder"))

			await modScript.analysis(
				{
					config,
					deployInstruction,
					modRoot: path.join(config.modsPath, mod),
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

	saveAnalysisCache(manifest.id, {
		frameworkVersion: FrameworkVersion,
		manifestHash,
		optionsHash,
		deployInstruction: await serialiseDeployInstruction(deployInstruction)
	})

	return deployInstruction
}
