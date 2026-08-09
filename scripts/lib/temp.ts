import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupTemporaryPath } from "./files"

export async function createTemporaryDirectory(prefix: string, parentDirectory = tmpdir()): Promise<string> {
	await mkdir(parentDirectory, { recursive: true })
	return mkdtemp(join(parentDirectory, `${prefix}-${randomUUID()}-`))
}

export async function withTemporaryDirectory<T>(
	prefix: string,
	action: (directory: string) => Promise<T>,
	parentDirectory = tmpdir()
): Promise<T> {
	const directory = await createTemporaryDirectory(prefix, parentDirectory)
	try {
		return await action(directory)
	} finally {
		await cleanupTemporaryPath(directory)
	}
}
