import child_process from "child_process"
import path from "path"
import { logger, paths } from "./core-singleton"

// Shim for QuickEntity 3.1 executable

// Computed lazily (not at module scope) - paths.toolsRoot isn't set until createCore() runs (see
// LEI-130), which may well be after this module is first imported.
const qnExe = () => path.join(paths.toolsRoot, "Third-Party", "quickentity-rs.exe")

const execCommand = function (command: string) {
	void logger.verbose(`Executing QN 3.1 command ${command}`)
	// See analyseMod.ts's execCommand for why cwd is pinned to dataRoot rather than left to
	// process.cwd() - cmd.exe (which execSync shells out through on Windows) refuses to start at
	// all with a UNC cwd.
	child_process.execSync(command, { stdio: [ "pipe", "inherit", "inherit" ], cwd: paths.dataRoot, windowsHide: true })
}

export async function convert(_game: string, TEMP: string, TEMPmeta: string, TBLU: string, TBLUmeta: string, output: string) {
	execCommand(
		`"${qnExe()}" entity convert --input-factory "${TEMP}" --input-factory-meta "${TEMPmeta}" --input-blueprint "${TBLU}" --input-blueprint-meta "${TBLUmeta}" --output "${output}" --lossless`
	)
}

export async function generate(_game: string, input: string, TEMP: string, TEMPmeta: string, TBLU: string, TBLUmeta: string) {
	execCommand(
		`"${qnExe()}" entity generate --input "${input}" --output-factory "${TEMP}" --output-factory-meta "${TEMPmeta}" --output-blueprint "${TBLU}" --output-blueprint-meta "${TBLUmeta}"`
	)
}

export async function createPatchJSON(original: string, modified: string, output: string) {
	execCommand(`"${qnExe()}" patch generate --input1 "${original}" --input2 "${modified}" --output "${output}" --format-fix`)
}

export async function applyPatchJSON(original: string, patch: string, output: string) {
	execCommand(`"${qnExe()}" patch apply --input "${original}" --patch "${patch}" --output "${output}" --permissive --format-fix`)
}
