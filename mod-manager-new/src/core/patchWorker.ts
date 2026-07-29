import * as LosslessJSON from "lossless-json"

import type { Config } from "./types"
import type { ResolvedCoreOptions } from "./core"
import { createCore } from "./core"
import { config, logger, paths, setCurrentCore } from "./core-singleton"
import { copyFromCache, copyToCache, getQuickEntityFromPatchVersion } from "./utils"

import RPKGInstance from "./rpkg"
import child_process from "child_process"
import fs from "fs-extra"
import path from "path"
import { parentPort } from "worker_threads"
import { xxhash3 } from "hash-wasm"

import "clarify"

const execCommand = function (command: string) {
	void logger.verbose(`Executing command ${command}`)
	return new Promise((resolve, reject) => {
		const x = child_process.exec(command)
		x.stdout?.pipe(process.stdout)
		x.stderr?.pipe(process.stderr)
		x.on("close", resolve)
	})
}

/**
 * The pool (see workerPool.ts) reuses each worker thread for many tasks, so this only needs to
 * happen once per thread - not once per patch. Guarded rather than done at module scope because it
 * depends on the config/options handed over by whichever call happens to be first, not on anything
 * knowable at import time.
 */
let workerCoreInitialised = false

function ensureWorkerCore(workerConfig: Config, coreOptions: ResolvedCoreOptions, workerPaths: { dataRoot: string; toolsRoot: string }) {
	if (workerCoreInitialised) {
		return
	}

	setCurrentCore(createCore(workerConfig, { ...coreOptions, paths: workerPaths }))
	workerCoreInitialised = true
}

type PatchTaskData = {
	tempHash: string
	tempRPKG: string
	tbluHash: string
	tbluRPKG: string
	chunkFolder: string
	assignedTemporaryDirectory: string
	patches: any[]
	invalidatedData: {
		filePath: string
		data: { hash: string; dependencies: string[]; affected: string[] }
	}[]
	cacheFolder: string
	config: Config
	coreOptions: ResolvedCoreOptions
	paths: { dataRoot: string; toolsRoot: string }
}

/**
 * The actual entity-patch work for one task - unchanged from the Piscina days apart from no
 * longer being the module's default export (see the parentPort wiring at the bottom of this file,
 * which is what actually receives tasks now).
 */
async function processPatch({
	tempHash,
	tempRPKG,
	tbluHash,
	tbluRPKG,
	chunkFolder,
	assignedTemporaryDirectory,
	patches,
	invalidatedData,
	cacheFolder,
	config: workerConfig,
	coreOptions,
	paths: workerPaths
}: PatchTaskData) {
	ensureWorkerCore(workerConfig, coreOptions, workerPaths)

	fs.ensureDirSync(path.join(paths.dataRoot, assignedTemporaryDirectory))

	if (
		!(
			patches.every((patch) => !invalidatedData.some((a) => a.filePath === patch.path)) &&
			(await copyFromCache(cacheFolder, path.join(chunkFolder, await xxhash3(patches[patches.length - 1].path)), path.join(paths.dataRoot, assignedTemporaryDirectory)))
		)
	) {
		const rpkgInstance = new RPKGInstance(path.join(paths.toolsRoot, "Third-Party", "rpkg-cli"))

		await rpkgInstance.waitForInitialised()

		const callRPKGFunction = async function (command: string) {
			await logger.verbose(`Executing RPKG function ${command}`)
			return await rpkgInstance.callFunction(command)
		}

		/* ---------------------------------------- Extract TEMP ---------------------------------------- */
		if (!fs.existsSync(path.join(paths.dataRoot, "staging", chunkFolder, `${tempHash}.TEMP`))) {
			await callRPKGFunction(`-extract_from_rpkg "${path.join(config.runtimePath, `${tempRPKG}.rpkg`)}" -filter "${tempHash}" -output_path "${path.join(paths.dataRoot, assignedTemporaryDirectory)}"`)
		} else {
			try {
				fs.ensureDirSync(path.join(paths.dataRoot, assignedTemporaryDirectory, tempRPKG, "TEMP"))
			} catch {}
			await Promise.all([
				fs.copyFile(path.join(paths.dataRoot, "staging", chunkFolder, `${tempHash}.TEMP`), path.join(paths.dataRoot, assignedTemporaryDirectory, tempRPKG, "TEMP", `${tempHash}.TEMP`)), // Use the staging one (for mod compat - one mod can extract, patch and build, then the next can patch that one instead)
				fs.copyFile(path.join(paths.dataRoot, "staging", chunkFolder, `${tempHash}.TEMP.meta`), path.join(paths.dataRoot, assignedTemporaryDirectory, tempRPKG, "TEMP", `${tempHash}.TEMP.meta`))
			])
		}

		/* ---------------------------------------- Extract TBLU ---------------------------------------- */
		if (!fs.existsSync(path.join(paths.dataRoot, "staging", chunkFolder, `${tbluHash}.TBLU`))) {
			await callRPKGFunction(`-extract_from_rpkg "${path.join(config.runtimePath, `${tbluRPKG}.rpkg`)}" -filter "${tbluHash}" -output_path "${path.join(paths.dataRoot, assignedTemporaryDirectory)}"`)
		} else {
			try {
				fs.ensureDirSync(path.join(paths.dataRoot, assignedTemporaryDirectory, tbluRPKG, "TBLU"))
			} catch {}
			await Promise.all([
				fs.copyFile(path.join(paths.dataRoot, "staging", chunkFolder, `${tbluHash}.TBLU`), path.join(paths.dataRoot, assignedTemporaryDirectory, tbluRPKG, "TBLU", `${tbluHash}.TBLU`)), // Use the staging one (for mod compat - one mod can extract, patch and build, then the next can patch that one instead)
				fs.copyFile(path.join(paths.dataRoot, "staging", chunkFolder, `${tbluHash}.TBLU.meta`), path.join(paths.dataRoot, assignedTemporaryDirectory, tbluRPKG, "TBLU", `${tbluHash}.TBLU.meta`))
			])
		}

		/* ------------------------------------ Convert to RT Source ------------------------------------ */
		await Promise.all([
			execCommand(
				`"${path.join(paths.toolsRoot, "Third-Party", "ResourceTool.exe")}" HM3 convert TEMP "${path.join(paths.dataRoot, assignedTemporaryDirectory, tempRPKG, "TEMP", `${tempHash}.TEMP`)}" "${path.join(
					paths.dataRoot,
					assignedTemporaryDirectory,
					tempRPKG,
					"TEMP",
					`${tempHash}.TEMP`
				)}.json" --simple`
			),
			execCommand(
				`"${path.join(paths.toolsRoot, "Third-Party", "ResourceTool.exe")}" HM3 convert TBLU "${path.join(paths.dataRoot, assignedTemporaryDirectory, tbluRPKG, "TBLU", `${tbluHash}.TBLU`)}" "${path.join(
					paths.dataRoot,
					assignedTemporaryDirectory,
					tbluRPKG,
					"TBLU",
					`${tbluHash}.TBLU`
				)}.json" --simple`
			)
		])
		await callRPKGFunction(`-hash_meta_to_json "${path.join(paths.dataRoot, assignedTemporaryDirectory, tempRPKG, "TEMP", `${tempHash}.TEMP.meta`)}"`)
		await callRPKGFunction(`-hash_meta_to_json "${path.join(paths.dataRoot, assignedTemporaryDirectory, tbluRPKG, "TBLU", `${tbluHash}.TBLU.meta`)}"`) // Generate the RT files from the binary files

		/* ---------------------------------------- Convert to QN --------------------------------------- */
		if (Number(patches[0].patchVersion.value) < 3) {
			await getQuickEntityFromPatchVersion(patches[0].patchVersion.value).convert(
				"HM3",
				"ids",
				path.join(paths.dataRoot, assignedTemporaryDirectory, tempRPKG, "TEMP", `${tempHash}.TEMP.json`),
				path.join(paths.dataRoot, assignedTemporaryDirectory, tempRPKG, "TEMP", `${tempHash}.TEMP.meta.JSON`),
				path.join(paths.dataRoot, assignedTemporaryDirectory, tbluRPKG, "TBLU", `${tbluHash}.TBLU.json`),
				path.join(paths.dataRoot, assignedTemporaryDirectory, tbluRPKG, "TBLU", `${tbluHash}.TBLU.meta.JSON`),
				// @ts-expect-error Two different versions of the same function; TypeScript doesn't have a way of overloading a "type-only" function
				path.join(paths.dataRoot, assignedTemporaryDirectory, "QuickEntityJSON.json")
			) // Generate the QN json from the RT files
		} else {
			await getQuickEntityFromPatchVersion(patches[0].patchVersion.value).convert(
				"HM3",
				path.join(paths.dataRoot, assignedTemporaryDirectory, tempRPKG, "TEMP", `${tempHash}.TEMP.json`),
				path.join(paths.dataRoot, assignedTemporaryDirectory, tempRPKG, "TEMP", `${tempHash}.TEMP.meta.JSON`),
				path.join(paths.dataRoot, assignedTemporaryDirectory, tbluRPKG, "TBLU", `${tbluHash}.TBLU.json`),
				path.join(paths.dataRoot, assignedTemporaryDirectory, tbluRPKG, "TBLU", `${tbluHash}.TBLU.meta.JSON`),
				path.join(paths.dataRoot, assignedTemporaryDirectory, "QuickEntityJSON.json")
			) // Generate the QN json from the RT files
		}

		for (const patch of patches) {
			await logger.debug(`Applying patch ${patch.path}`)

			if (!getQuickEntityFromPatchVersion(patch.patchVersion.value)) {
				rpkgInstance.exit()
				fs.removeSync(path.join(paths.dataRoot, assignedTemporaryDirectory))

				await logger.error(`Could not find matching QuickEntity version for patch version ${Number(patch.patchVersion.value)}!`)
			}

			fs.writeFileSync(path.join(paths.dataRoot, assignedTemporaryDirectory, "patch.json"), LosslessJSON.stringify(patch))

			/* ----------------------------------------- Apply patch ---------------------------------------- */
			await getQuickEntityFromPatchVersion(patch.patchVersion.value).applyPatchJSON(
				path.join(paths.dataRoot, assignedTemporaryDirectory, "QuickEntityJSON.json"),
				path.join(paths.dataRoot, assignedTemporaryDirectory, "patch.json"),
				path.join(paths.dataRoot, assignedTemporaryDirectory, "PatchedQuickEntityJSON.json")
			) // Patch the QN json
			fs.copySync(path.join(paths.dataRoot, assignedTemporaryDirectory, "PatchedQuickEntityJSON.json"), path.join(paths.dataRoot, assignedTemporaryDirectory, "QuickEntityJSON.json"))
		}

		/* ------------------------------------ Convert to RT Source ------------------------------------ */
		await getQuickEntityFromPatchVersion(patches[0].patchVersion.value).generate(
			"HM3",
			path.join(paths.dataRoot, assignedTemporaryDirectory, "QuickEntityJSON.json"),
			path.join(paths.dataRoot, assignedTemporaryDirectory, "temp.TEMP.json"),
			path.join(paths.dataRoot, assignedTemporaryDirectory, `${tempHash}.TEMP.meta.JSON`),
			path.join(paths.dataRoot, assignedTemporaryDirectory, "temp.TBLU.json"),
			path.join(paths.dataRoot, assignedTemporaryDirectory, `${tbluHash}.TBLU.meta.JSON`)
		) // Generate the RT files from the QN json

		/* -------------------------------------- Convert to binary ------------------------------------- */
		await Promise.all([
			execCommand(
				`"${path.join(paths.toolsRoot, "Third-Party", "ResourceTool.exe")}" HM3 generate TEMP "${path.join(paths.dataRoot, assignedTemporaryDirectory, "temp.TEMP.json")}" "${path.join(
					paths.dataRoot,
					assignedTemporaryDirectory,
					`${tempHash}.TEMP`
				)}" --simple`
			),
			execCommand(
				`"${path.join(paths.toolsRoot, "Third-Party", "ResourceTool.exe")}" HM3 generate TBLU "${path.join(paths.dataRoot, assignedTemporaryDirectory, "temp.TBLU.json")}" "${path.join(
					paths.dataRoot,
					assignedTemporaryDirectory,
					`${tbluHash}.TBLU`
				)}" --simple`
			)
		])
		await callRPKGFunction(`-json_to_hash_meta "${path.join(paths.dataRoot, assignedTemporaryDirectory, `${tempHash}.TEMP.meta.JSON`)}"`)
		await callRPKGFunction(`-json_to_hash_meta "${path.join(paths.dataRoot, assignedTemporaryDirectory, `${tbluHash}.TBLU.meta.JSON`)}"`) // Generate the binary files from the RT json

		await Promise.all([
			fs.rm(path.join(paths.dataRoot, assignedTemporaryDirectory, "QuickEntityJSON.json")),
			fs.rm(path.join(paths.dataRoot, assignedTemporaryDirectory, "temp.TEMP.json")),
			fs.rm(path.join(paths.dataRoot, assignedTemporaryDirectory, `${tempHash}.TEMP.meta.JSON`)),
			fs.rm(path.join(paths.dataRoot, assignedTemporaryDirectory, "temp.TBLU.json")),
			fs.rm(path.join(paths.dataRoot, assignedTemporaryDirectory, `${tbluHash}.TBLU.meta.JSON`))
		])

		rpkgInstance.exit()

		await copyToCache(cacheFolder, path.join(paths.dataRoot, assignedTemporaryDirectory), path.join(chunkFolder, await xxhash3(patches[patches.length - 1].path)))
	} else {
		await logger.debug(`Restored patch chain ending in ${patches[patches.length - 1].path} from cache`)
	}

	/* ------------------------------------- Stage binary files ------------------------------------- */
	await Promise.all([
		fs.copyFile(path.join(paths.dataRoot, assignedTemporaryDirectory, `${tempHash}.TEMP`), path.join(paths.dataRoot, "staging", chunkFolder, `${tempHash}.TEMP`)),
		fs.copyFile(path.join(paths.dataRoot, assignedTemporaryDirectory, `${tempHash}.TEMP.meta`), path.join(paths.dataRoot, "staging", chunkFolder, `${tempHash}.TEMP.meta`)),
		fs.copyFile(path.join(paths.dataRoot, assignedTemporaryDirectory, `${tbluHash}.TBLU`), path.join(paths.dataRoot, "staging", chunkFolder, `${tbluHash}.TBLU`)),
		fs.copyFile(path.join(paths.dataRoot, assignedTemporaryDirectory, `${tbluHash}.TBLU.meta`), path.join(paths.dataRoot, "staging", chunkFolder, `${tbluHash}.TBLU.meta`)) // Copy the binary files to the staging directory
	])

	fs.removeSync(path.join(paths.dataRoot, assignedTemporaryDirectory))

	return
}

/**
 * Wire this file up to the pool in workerPool.ts: receive `{ id, data }` over parentPort, run the
 * patch, and reply with `{ id, ok: true, result }` or `{ id, ok: false, error }` on the same
 * channel. Replaces Piscina's `module.exports = async (data) => ...` convention - the actual patch
 * logic in processPatch() above is unchanged.
 *
 * `parentPort` is only ever null when this file is imported outside a worker thread (it isn't -
 * nothing else imports patchWorker.ts, see workerPool.ts's doc comment), so this throws rather than
 * silently doing nothing.
 */
if (!parentPort) {
	throw new Error("patchWorker.ts must be run inside a worker thread - no parentPort available")
}

const workerParentPort = parentPort

workerParentPort.on("message", async ({ id, data }: { id: number; data: PatchTaskData }) => {
	try {
		const result = await processPatch(data)
		workerParentPort.postMessage({ id, ok: true, result })
	} catch (error) {
		workerParentPort.postMessage({
			id,
			ok: false,
			error:
				error instanceof Error
					? { name: error.name, message: error.message, stack: error.stack }
					: { name: "Error", message: String(error), stack: undefined }
		})
	}
})
