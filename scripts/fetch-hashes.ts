// Downloads the latest hitman-hashes release and stages hash_list.txt in extra/Third-Party.
// Run this after fetch-third-party.ts, which provides the Windows 7z.exe used on Windows.
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { extractSevenZipArchive } from "./lib/archive"
import { errorMessage } from "./lib/errors"
import { downloadFile } from "./lib/download"
import { copyFileAtomically, ensureDirectory, findFile, pathExists } from "./lib/files"
import { findExecutable } from "./lib/process"
import { withTemporaryDirectory } from "./lib/temp"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const destinationDirectory = join(scriptDirectory, "..", "extra", "Third-Party")
const archiveUrl = "https://github.com/glacier-modding/hitman-hashes/releases/latest/download/latest-hashes.7z"
const debug = Boolean(process.env.SMF_DEBUG)
const requestOptions = {
	headers: { "User-Agent": "simple-mod-framework-setup" },
	debug: (message: string): void => {
		if (debug) console.error(`[debug] ${message}`)
	}
}

async function main(): Promise<void> {
	await ensureDirectory(destinationDirectory)

	const sevenZip =
		process.platform === "win32"
			? join(destinationDirectory, "7z.exe")
			: await findExecutable(["7zz", "7z", "7za"], ["i"])
	if (!sevenZip || (process.platform === "win32" && !(await pathExists(sevenZip)))) {
		throw new Error('no "7zz", "7z", or "7za" found on PATH - run this from `nix develop .#e2e` or install a native 7-Zip CLI')
	}

	console.log("Fetching hitman-hashes...")
	await withTemporaryDirectory("smf-hashes", async (temporaryDirectory) => {
		const archivePath = join(temporaryDirectory, "latest-hashes.7z")
		const extractionDirectory = join(temporaryDirectory, "extracted")
		await downloadFile(archiveUrl, archivePath, requestOptions)
		await extractSevenZipArchive(archivePath, extractionDirectory, sevenZip)

		const found = await findFile(extractionDirectory, "hash_list.txt")
		if (!found) {
			throw new Error('Could not find hash_list.txt inside the hitman-hashes release')
		}
		await copyFileAtomically(found, join(destinationDirectory, "hash_list.txt"))
	})
	console.log(`Extracted hitman-hashes to ${destinationDirectory}`)
}

try {
	await main()
} catch (error) {
	console.error("Hitman-hashes setup failed:", errorMessage(error))
	process.exitCode = 1
}
