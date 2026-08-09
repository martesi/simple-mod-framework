import { copyFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { downloadFile, type FetchOptions } from "./download"
import { copyFileAtomically, findFile, pathExists } from "./files"
import { findExecutable, runProcess } from "./process"
import { withTemporaryDirectory } from "./temp"

export type ArchiveFormat = "zip" | "sevenZip"

export interface ArchiveFileSpecification {
	sourceName: string
	destinationName?: string
}

export interface ArchiveSpecification {
	archiveName: string
	archiveUrl: string
	format: ArchiveFormat
	files: readonly ArchiveFileSpecification[]
	missingFileMessage: (fileName: string) => string
}

export type EnsureResult = "already downloaded" | "downloaded"

function quotePowerShellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

export async function extractArchive(archivePath: string, destinationDirectory: string, format: ArchiveFormat, sevenZip?: string): Promise<void> {
	await mkdir(destinationDirectory, { recursive: true })

	if (format === "sevenZip") {
		if (!sevenZip) throw new Error("A 7-Zip executable is required to extract this archive")
		await runProcess(sevenZip, ["x", archivePath, `-o${destinationDirectory}`, "-y"])
		return
	}

	if (process.platform === "win32") {
		await runProcess("powershell", [
			"-NoProfile",
			"-Command",
			`Expand-Archive -LiteralPath ${quotePowerShellLiteral(archivePath)} -DestinationPath ${quotePowerShellLiteral(destinationDirectory)} -Force`
		])
		return
	}

	const unzip = await findExecutable(["unzip"], ["-v"])
	if (unzip) {
		await runProcess(unzip, ["-o", archivePath, "-d", destinationDirectory])
		return
	}

	const nativeSevenZip = await findExecutable(["7zz", "7z", "7za"], ["i"])
	if (!nativeSevenZip) {
		throw new Error('no "unzip", "7zz", "7z", or "7za" found on PATH to extract an upstream release archive - install one or run this from `nix develop .#e2e`')
	}
	await runProcess(nativeSevenZip, ["x", archivePath, `-o${destinationDirectory}`, "-y"])
}

export async function extractSevenZipArchive(archivePath: string, destinationDirectory: string, sevenZip: string): Promise<void> {
	await extractArchive(archivePath, destinationDirectory, "sevenZip", sevenZip)
}

export async function ensureArchiveFiles(
	specification: ArchiveSpecification,
	destinationDirectory: string,
	options: FetchOptions = {}
): Promise<EnsureResult> {
	const destinations = specification.files.map((file) => join(destinationDirectory, file.destinationName ?? file.sourceName))
	const present = await Promise.all(destinations.map((destination) => pathExists(destination)))
	if (present.every(Boolean)) return "already downloaded"

	return withTemporaryDirectory("smf-archive", async (temporaryDirectory): Promise<EnsureResult> => {
		const archivePath = join(temporaryDirectory, specification.archiveName)
		const extractionDirectory = join(temporaryDirectory, "extracted")
		const stagedDirectory = join(temporaryDirectory, "staged")

		await downloadFile(specification.archiveUrl, archivePath, options)
		await extractArchive(archivePath, extractionDirectory, specification.format)
		await mkdir(stagedDirectory, { recursive: true })

		const stagedFiles: string[] = []
		for (const file of specification.files) {
			const found = await findFile(extractionDirectory, file.sourceName)
			if (!found) throw new Error(specification.missingFileMessage(file.sourceName))

			const stagedPath = join(stagedDirectory, file.destinationName ?? file.sourceName)
			await copyFile(found, stagedPath)
			stagedFiles.push(stagedPath)
		}

		// Extraction and discovery complete before any target is touched. Each final file is then
		// replaced from the staged copy so a failed download/extraction cannot leave a new partial file.
		for (let index = 0; index < stagedFiles.length; index += 1) {
			await copyFileAtomically(stagedFiles[index], destinations[index])
		}
		return "downloaded"
	})
}
