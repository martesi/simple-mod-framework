import child_process from "child_process"
import path from "path"
import { logger } from "./core-singleton"

// Shim for QuickEntity 3.1 executable

const qnExe = path.join(process.cwd(), "Third-Party", "quickentity-rs.exe")

const execCommand = function (command: string) {
	void logger.verbose(`Executing QN 3.1 command ${command}`)
	child_process.execSync(command, { stdio: [ "pipe", "inherit", "inherit" ] })
}

export async function convert(game: string, TEMP: string, TEMPmeta: string, TBLU: string, TBLUmeta: string, output: string) {
	execCommand(
		`"${qnExe}" entity convert --input-factory "${TEMP}" --input-factory-meta "${TEMPmeta}" --input-blueprint "${TBLU}" --input-blueprint-meta "${TBLUmeta}" --output "${output}" --lossless`
	)
}

export async function generate(game: string, input: string, TEMP: string, TEMPmeta: string, TBLU: string, TBLUmeta: string) {
	execCommand(
		`"${qnExe}" entity generate --input "${input}" --output-factory "${TEMP}" --output-factory-meta "${TEMPmeta}" --output-blueprint "${TBLU}" --output-blueprint-meta "${TBLUmeta}"`
	)
}

export async function createPatchJSON(original: string, modified: string, output: string) {
	execCommand(`"${qnExe}" patch generate --input1 "${original}" --input2 "${modified}" --output "${output}" --format-fix`)
}

export async function applyPatchJSON(original: string, patch: string, output: string) {
	execCommand(`"${qnExe}" patch apply --input "${original}" --patch "${patch}" --output "${output}" --permissive --format-fix`)
}
