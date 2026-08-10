// Single Bun entry point for making a fresh clone runnable. It downloads Electron's platform
// binary and the release-backed tools in parallel, then hitman-hashes.
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { errorMessage } from "./lib/errors"
import { requireTask } from "./lib/effects"
import { pathExists } from "./lib/files"
import { runProcess } from "./lib/process"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = join(scriptDirectory, "..")
const electronInstallScript = join(repositoryRoot, "node_modules", "electron", "install.js")
const thirdPartyDirectory = join(repositoryRoot, "extra", "Third-Party")
const setupArtifacts = [
	"7z.exe",
	"HMLanguageTools.exe",
	"HMTextureTools.exe",
	"quickentity-3.exe",
	"quickentity-rs.exe",
	"rpkg-cli.exe",
	"quickentity_ffi.dll",
	"assimp.dll",
	"hash_list.hmla",
	"hash_list.txt",
	"ResourceTool.exe",
	"ResourceLib_HM2.dll",
	"ResourceLib_HM2016.dll",
	"ResourceLib_HM3.dll",
	"xdelta3.exe"
] as const

async function runScript(scriptName: string): Promise<void> {
	await requireTask(runProcess(process.execPath, [join(scriptDirectory, scriptName)], { stdin: "inherit" }))
}

async function runStep(label: string, operation: () => Promise<void>, warning: string): Promise<void> {
	try {
		await operation()
	} catch (error) {
		console.warn(`${label} (${errorMessage(error)}). ${warning}`)
	}
}

async function main(): Promise<void> {
	const alreadyFetched = (await Promise.all(setupArtifacts.map((artifact) => requireTask(pathExists(join(thirdPartyDirectory, artifact)))))).every(Boolean)
	if (process.argv.includes("--postinstall") && alreadyFetched) {
		console.log("extra/Third-Party/ already looks populated, skipping postinstall setup. Run 'bun run setup' to force.")
		return
	}

	await Promise.all([
		(async () => {
			if (await pathExists(electronInstallScript)) {
				await runStep(
					"Couldn't download the Electron binary automatically",
					() => requireTask(runProcess(process.execPath, [electronInstallScript], { stdin: "inherit" })),
					"Re-run `bun run setup` later, or run `bun node_modules/electron/install.js` by hand."
				)
			} else {
				console.warn('"electron" not found in node_modules - skipping its binary download. Run `bun install` first.')
			}
		})(),
		runStep(
			"Couldn't fetch third-party tools automatically",
			() => runScript("fetch-third-party.ts"),
			'Place the release-backed files in "extra/Third-Party/" by hand and re-run `bun run setup` later.'
		)
	])

	await runStep(
		"Couldn't fetch hitman-hashes automatically",
		() => runScript("fetch-hashes.ts"),
		'Re-run `bun run setup` later, or place hash_list.txt in "extra/Third-Party/" by hand.'
	)
}

try {
	await main()
} catch (error) {
	console.warn(`Setup encountered an unexpected failure (${errorMessage(error)}). Re-run \`bun run setup\` later.`)
}
