// Fetches a Windows Electron build for WSL development and stages it atomically at
// .win-electron-dev. A valid version marker plus electron.exe is reused without downloading.
import { chmod, readFile, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { extractArchive } from "./lib/archive"
import { errorMessage } from "./lib/errors"
import { downloadFile } from "./lib/download"
import { ensureDirectory, pathExists, removePath, writeFileAtomically } from "./lib/files"
import { withTemporaryDirectory } from "./lib/temp"

interface ElectronPackageJson {
	version: string
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = join(scriptDirectory, "..")
const electronPackageJson = join(repositoryRoot, "node_modules", "electron", "package.json")
const destinationDirectory = join(repositoryRoot, ".win-electron-dev")
const versionMarker = join(destinationDirectory, ".version")
const electronExecutable = join(destinationDirectory, "electron.exe")

async function main(): Promise<void> {
	const packageInfo = JSON.parse(await readFile(electronPackageJson, "utf8")) as ElectronPackageJson
	const version = packageInfo.version
	if (!version) throw new Error(`Could not determine the installed Electron version from ${electronPackageJson}`)

	const [markerExists, executableExists] = await Promise.all([pathExists(versionMarker), pathExists(electronExecutable)])
	const markerVersion = markerExists ? (await readFile(versionMarker, "utf8")).trim() : undefined
	if (markerExists && markerVersion === version && executableExists) {
		console.log(`.win-electron-dev/ already has Electron v${version}, skipping.`)
		return
	}
	if (markerExists || executableExists) {
		console.log(
			`.win-electron-dev/ cache miss: version marker ${markerExists ? `present (v${markerVersion})` : "missing"}, electron.exe ${executableExists ? "present" : "missing"}, need v${version}. Re-fetching.`
		)
	}

	const zipName = `electron-v${version}-win32-x64.zip`
	const cachedZip = join(homedir(), ".cache", "electron", zipName)
	const downloadOptions = { headers: { "User-Agent": "simple-mod-framework-setup" } }

	await withTemporaryDirectory(".win-electron-dev", async (workDirectory) => {
		const zipPath = join(workDirectory, zipName)
		if (await pathExists(cachedZip)) {
			console.log(`Extracting cached ${zipName}...`)
			await extractArchive(cachedZip, join(workDirectory, "output"), "zip")
		} else {
			console.log(`Downloading ${zipName} (not in ~/.cache/electron/)...`)
			await downloadFile(`https://github.com/electron/electron/releases/download/v${version}/${zipName}`, zipPath, downloadOptions)
			await extractArchive(zipPath, join(workDirectory, "output"), "zip")
		}

		const stagedOutput = join(workDirectory, "output")
		const stagedExecutable = join(stagedOutput, "electron.exe")
		if (!(await pathExists(stagedExecutable))) {
			throw new Error(`Extracted ${zipName} did not contain electron.exe`)
		}
		await chmod(stagedExecutable, 0o755)
		await writeFileAtomically(join(stagedOutput, ".version"), version)

		// The complete directory is ready before the old cache is removed, so a failed fetch or
		// extraction leaves the previous cache available for a later retry.
		await removePath(destinationDirectory)
		await ensureDirectory(repositoryRoot)
		await rename(stagedOutput, destinationDirectory)
	}, repositoryRoot)
	console.log(`.win-electron-dev/ ready (Electron v${version})`)
}

try {
	await main()
} catch (error) {
	console.error("Windows Electron setup failed:", errorMessage(error))
	process.exitCode = 1
}
