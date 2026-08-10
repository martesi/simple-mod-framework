import { copyFile } from "node:fs/promises"
import { join } from "node:path"
import { pipe } from "fp-ts/function"
import * as TE from "fp-ts/TaskEither"
import { downloadFile, type FetchOptions } from "./download"
import { copyFileAtomically, ensureDirectory, findFile, pathExists } from "./files"
import { scriptError, tryScript, type ScriptError } from "./effects"
import { findExecutable, runProcess } from "./process"
import { withTemporaryDirectory } from "./temp"

export type ArchiveFormat = "zip" | "sevenZip"
export interface ArchiveFileSpecification { sourceName: string; destinationName?: string }
export interface ArchiveSpecification { archiveName: string; archiveUrl: string; format: ArchiveFormat; files: readonly ArchiveFileSpecification[]; missingFileMessage: (fileName: string) => string }
export type EnsureResult = "already downloaded" | "downloaded"

const quotePowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`

export function extractArchive(archivePath: string, destinationDirectory: string, format: ArchiveFormat, sevenZip?: string): TE.TaskEither<ScriptError, void> {
	return pipe(
		ensureDirectory(destinationDirectory),
		TE.chain(() => {
			if (format === "sevenZip") return sevenZip ? runProcess(sevenZip, ["x", archivePath, `-o${destinationDirectory}`, "-y"]) : TE.left(scriptError("extract archive", "A 7-Zip executable is required to extract this archive", { path: archivePath }))
			if (process.platform === "win32") return runProcess("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${quotePowerShellLiteral(archivePath)} -DestinationPath ${quotePowerShellLiteral(destinationDirectory)} -Force`])
				return pipe(findExecutable(["unzip"], ["-v"]), TE.chain(unzip => {
					if (unzip) return runProcess(unzip, ["-o", archivePath, "-d", destinationDirectory])
					return pipe(findExecutable(["7zz", "7z", "7za"], ["i"]), TE.chain(native => native
						? runProcess(native, ["x", archivePath, `-o${destinationDirectory}`, "-y"])
						: TE.left(scriptError("extract archive", 'no "unzip", "7zz", "7z", or "7za" found on PATH to extract an upstream release archive - install one or run this from `nix develop .#e2e`', { path: archivePath }))))
				}))
		})
	)
}

export const extractSevenZipArchive = (archivePath: string, destinationDirectory: string, sevenZip: string) => extractArchive(archivePath, destinationDirectory, "sevenZip", sevenZip)

export function ensureArchiveFiles(specification: ArchiveSpecification, destinationDirectory: string, options: FetchOptions = {}): TE.TaskEither<ScriptError, EnsureResult> {
	const destinations = specification.files.map(file => join(destinationDirectory, file.destinationName ?? file.sourceName))
	const stageMember = (temporaryDirectory: string, extractionDirectory: string, file: ArchiveFileSpecification) => pipe(
		findFile(extractionDirectory, file.sourceName),
		TE.chain(found => found
			? pipe(tryScript("stage archive member", () => copyFile(found, join(temporaryDirectory, file.destinationName ?? file.sourceName)), { path: found }), TE.map(() => join(temporaryDirectory, file.destinationName ?? file.sourceName)))
			: TE.left(scriptError("stage archive member", specification.missingFileMessage(file.sourceName), { path: extractionDirectory })))
	)
	return pipe(
		TE.sequenceArray(destinations.map(pathExists)),
		TE.chain(present => present.every(Boolean) ? TE.right<ScriptError, EnsureResult>("already downloaded") : withTemporaryDirectory("smf-archive", temporaryDirectory => {
			const archivePath = join(temporaryDirectory, specification.archiveName)
			const extractionDirectory = join(temporaryDirectory, "extracted")
			const stagedDirectory = join(temporaryDirectory, "staged")
			return pipe(
				downloadFile(specification.archiveUrl, archivePath, options),
				TE.chain(() => extractArchive(archivePath, extractionDirectory, specification.format)),
				TE.chain(() => ensureDirectory(stagedDirectory)),
				TE.chain(() => TE.sequenceArray(specification.files.map(file => stageMember(stagedDirectory, extractionDirectory, file)))),
				TE.chain(stagedFiles => TE.sequenceArray(stagedFiles.map((stagedFile, index) => copyFileAtomically(stagedFile, destinations[index])))),
				TE.map(() => "downloaded" as EnsureResult)
			)
		}))
	)
}
