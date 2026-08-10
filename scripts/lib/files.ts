import { randomUUID } from "node:crypto"
import { copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { pipe } from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import { tryScript, type ScriptError } from "./effects"

export function pathExists(filePath: string): TE.TaskEither<ScriptError, boolean> {
	return tryScript("check path", () => Bun.file(filePath).exists(), { path: filePath })
}

export function ensureDirectory(directory: string): TE.TaskEither<ScriptError, void> {
	return tryScript("create directory", () => mkdir(directory, { recursive: true }).then(() => undefined), { path: directory })
}

export function removePath(filePath: string): TE.TaskEither<ScriptError, void> {
	return tryScript("remove path", () => rm(filePath, { recursive: true, force: true }), { path: filePath })
}

export function cleanupTemporaryPath(filePath: string): TE.TaskEither<never, void> {
	return async () => {
		try { await removePath(filePath)(); } catch { /* cleanup is best effort */ }
		return { _tag: "Right", right: undefined }
	}
}

export function createTemporaryPath(directory: string, prefix: string): TE.TaskEither<ScriptError, string> {
	return pipe(ensureDirectory(directory), TE.map(() => join(directory, `.${prefix}-${randomUUID()}.tmp`)))
}

export function moveFileAtomically(source: string, destination: string): TE.TaskEither<ScriptError, void> {
	return tryScript("atomically move file", async () => {
		try { await rename(source, destination) } catch (error) {
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined
			if (code !== "EEXIST" && code !== "EPERM") throw error
			await rm(destination, { recursive: true, force: true }); await rename(source, destination)
		}
	}, { path: destination })
}

export function copyFileAtomically(source: string, destination: string): TE.TaskEither<ScriptError, void> {
	return TE.bracket(
		createTemporaryPath(dirname(destination), basename(destination)),
		(temporaryPath) => pipe(tryScript("copy file", () => copyFile(source, temporaryPath), { path: source }), TE.chain(() => moveFileAtomically(temporaryPath, destination))),
		(temporaryPath) => cleanupTemporaryPath(temporaryPath)
	)
}

export function writeFileAtomically(destination: string, contents: string): TE.TaskEither<ScriptError, void> {
	return TE.bracket(
		createTemporaryPath(dirname(destination), basename(destination)),
		(temporaryPath) => pipe(tryScript("write file", () => writeFile(temporaryPath, contents), { path: destination }), TE.chain(() => moveFileAtomically(temporaryPath, destination))),
		(temporaryPath) => cleanupTemporaryPath(temporaryPath)
	)
}

/** Find a file by basename without depending on an upstream archive's folder layout. */
export function findFile(directory: string, name: string): TE.TaskEither<ScriptError, string | null> {
	return tryScript("find file", async () => {
		const entries = await readdir(directory, { withFileTypes: true })
		for (const entry of entries) {
			const entryPath = join(directory, entry.name)
			if (entry.isDirectory()) { const found = await findFile(entryPath, name)(); if (found._tag === "Right" && found.right) return found.right }
			else if (entry.name.toLowerCase() === name.toLowerCase()) return entryPath
		}
		return null
	}, { path: directory })
}
