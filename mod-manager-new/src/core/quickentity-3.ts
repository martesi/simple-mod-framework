import child_process from "child_process"
import path from "path"
import { logger, paths } from "./core-singleton"

// Shim for QuickEntity 3.0 executable

// Computed lazily (not at module scope) - paths.toolsRoot isn't set until createCore() runs (see
// LEI-130), which may well be after this module is first imported.
const qnExe = () => path.join(paths.toolsRoot, "Third-Party", "quickentity-3.exe")

const execCommand = function (command: string) {
	void logger.verbose(`Executing QN 3.0 command ${command}`)
	child_process.execSync(command, { stdio: [ "pipe", "pipe", "inherit" ] })
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

export async function applyPatchJSON(original: string, patch: string, output: string) {
	execCommand(`"${qnExe()}" patch apply --input "${original}" --patch "${patch}" --output "${output}"`)
}
