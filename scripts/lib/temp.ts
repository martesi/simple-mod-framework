import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupTemporaryPath } from "./files"
import * as TE from "fp-ts/TaskEither"
import { tryScript, type ScriptError } from "./effects"

export function createTemporaryDirectory(prefix: string, parentDirectory = tmpdir()): TE.TaskEither<ScriptError, string> {
	return tryScript("create temporary directory", async () => {
		await mkdir(parentDirectory, { recursive: true })
		return mkdtemp(join(parentDirectory, `${prefix}-${randomUUID()}-`))
	}, { path: parentDirectory })
}

export function withTemporaryDirectory<T>(
	prefix: string,
	action: (directory: string) => TE.TaskEither<ScriptError, T> | Promise<T>,
	parentDirectory = tmpdir()
): TE.TaskEither<ScriptError, T> {
	return TE.bracket(createTemporaryDirectory(prefix, parentDirectory), directory => {
		const result = action(directory)
		return typeof result === "function" ? result : tryScript("temporary directory action", () => result, { path: directory })
	}, cleanupTemporaryPath)
}
