import { randomUUID } from "node:crypto"
import { copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

export async function pathExists(filePath: string): Promise<boolean> {
	return Bun.file(filePath).exists()
}

export async function ensureDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true })
}

export async function removePath(filePath: string): Promise<void> {
	await rm(filePath, { recursive: true, force: true })
}

export async function cleanupTemporaryPath(filePath: string): Promise<void> {
	try {
		await removePath(filePath)
	} catch {
		// Temporary cleanup is best effort and must not hide the operation's real error.
	}
}

export async function createTemporaryPath(directory: string, prefix: string): Promise<string> {
	await ensureDirectory(directory)
	return join(directory, `.${prefix}-${randomUUID()}.tmp`)
}

export async function moveFileAtomically(source: string, destination: string): Promise<void> {
	try {
		await rename(source, destination)
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined
		if (code !== "EEXIST" && code !== "EPERM") throw error

		await removePath(destination)
		await rename(source, destination)
	}
}

export async function copyFileAtomically(source: string, destination: string): Promise<void> {
	const temporaryPath = await createTemporaryPath(dirname(destination), basename(destination))
	try {
		await copyFile(source, temporaryPath)
		await moveFileAtomically(temporaryPath, destination)
	} finally {
		await cleanupTemporaryPath(temporaryPath)
	}
}

export async function writeFileAtomically(destination: string, contents: string): Promise<void> {
	const temporaryPath = await createTemporaryPath(dirname(destination), basename(destination))
	try {
		await writeFile(temporaryPath, contents)
		await moveFileAtomically(temporaryPath, destination)
	} finally {
		await cleanupTemporaryPath(temporaryPath)
	}
}

/** Find a file by basename without depending on an upstream archive's folder layout. */
export async function findFile(directory: string, name: string): Promise<string | null> {
	const entries = await readdir(directory, { withFileTypes: true })
	for (const entry of entries) {
		const entryPath = join(directory, entry.name)
		if (entry.isDirectory()) {
			const found = await findFile(entryPath, name)
			if (found) return found
		} else if (entry.name.toLowerCase() === name.toLowerCase()) {
			return entryPath
		}
	}
	return null
}
