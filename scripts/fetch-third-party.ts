// Fetches the release-backed tools used by the app. Operational and provenance notes live in
// [fetch-third-party.md](./fetch-third-party.md).
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { ensureArchiveFiles, type ArchiveSpecification, type EnsureResult, extractSevenZipArchive } from "./lib/archive"
import { errorMessage, errorStack } from "./lib/errors"
import { requireTask, tryScript } from "./lib/effects"
import { downloadFile, fetchJson, type FetchOptions } from "./lib/download"
import { copyFileAtomically, ensureDirectory, findFile, pathExists } from "./lib/files"
import { findExecutable } from "./lib/process"
import { withTemporaryDirectory } from "./lib/temp"

interface GitHubAsset {
	name: string
	browser_download_url: string
}

interface GitHubRelease {
	tag_name?: string
	assets?: GitHubAsset[]
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const destinationDirectory = join(scriptDirectory, "..", "extra", "Third-Party")
const debug = Boolean(process.env.SMF_DEBUG)

const debugLog = (message: string): void => {
	if (debug) console.error(`[debug] ${message}`)
}

const downloadOptions: FetchOptions = {
	headers: { "User-Agent": "simple-mod-framework-setup" },
	debug: debugLog
}

const githubApiOptions: FetchOptions = {
	headers: { "User-Agent": "simple-mod-framework-setup", Accept: "application/vnd.github+json" },
	debug: debugLog,
	onHttpError: (response) => {
		const remaining = response.headers.get("x-ratelimit-remaining")
		const reset = response.headers.get("x-ratelimit-reset")
		if (response.status === 403 && remaining === "0" && reset) {
			return ` (unauthenticated GitHub API rate limit hit - resets ${new Date(Number(reset) * 1000).toLocaleString()})`
		}
		return undefined
	}
}

const tonyToolsArchive: ArchiveSpecification = {
	archiveName: "TonyTools.zip",
	archiveUrl: "https://github.com/AnthonyFuller/TonyTools/releases/latest/download/TonyTools.zip",
	format: "zip",
	files: [{ sourceName: "HMLanguageTools.exe" }, { sourceName: "HMTextureTools.exe" }],
	missingFileMessage: (fileName) =>
		`Couldn't find ${fileName} inside TonyTools.zip - the release layout may have changed. Check https://github.com/AnthonyFuller/TonyTools/releases/latest by hand and place it in "extra/Third-Party/" yourself.`
}

const rpkgToolsArchive: ArchiveSpecification = {
	archiveName: "rpkg_v2.34.0-cli.zip",
	archiveUrl: "https://github.com/glacier-modding/RPKG-Tool/releases/download/v2.34.0/rpkg_v2.34.0-cli.zip",
	format: "zip",
	files: [
		{ sourceName: "rpkg-cli.exe" },
		{ sourceName: "quickentity_ffi.dll" },
		{ sourceName: "assimp.dll" },
		{ sourceName: "hash_list.hmla" }
	],
	missingFileMessage: (fileName) =>
		`Couldn't find ${fileName} inside rpkg_v2.34.0-cli.zip - the release layout may have changed. Check https://github.com/glacier-modding/RPKG-Tool/releases/tag/v2.34.0 by hand and place it in "extra/Third-Party/" yourself.`
}

const zhmToolsArchive: ArchiveSpecification = {
	archiveName: "ResourceTool-win-x64.zip",
	archiveUrl: "https://github.com/OrfeasZ/ZHMTools/releases/download/v4.1.0/ResourceTool-win-x64.zip",
	format: "zip",
	files: [
		{ sourceName: "ResourceTool.exe" },
		{ sourceName: "ResourceLib_HM2.dll" },
		{ sourceName: "ResourceLib_HM2016.dll" },
		{ sourceName: "ResourceLib_HM3.dll" }
	],
	missingFileMessage: (fileName) =>
		`Couldn't find ${fileName} inside ResourceTool-win-x64.zip - the release layout may have changed. Check https://github.com/OrfeasZ/ZHMTools/releases/tag/v4.1.0 by hand and place it in "extra/Third-Party/" yourself.`
}

const xdeltaArchive: ArchiveSpecification = {
	archiveName: "xdelta3-3.2.0-windows-x86_64.zip",
	archiveUrl: "https://github.com/jmacd/xdelta/releases/download/v3.2.0/xdelta3-3.2.0-windows-x86_64.zip",
	format: "zip",
	files: [{ sourceName: "xdelta3.exe" }],
	missingFileMessage: (fileName) =>
		`Couldn't find ${fileName} inside xdelta3-3.2.0-windows-x86_64.zip - the release layout may have changed. Check https://github.com/jmacd/xdelta/releases/tag/v3.2.0 by hand and place it in "extra/Third-Party/" yourself.`
}

async function ensureQuickEntityRs(): Promise<EnsureResult> {
	const target = join(destinationDirectory, "quickentity-rs.exe")
	if (await requireTask(pathExists(target))) return "already downloaded"

	await requireTask(downloadFile("https://github.com/atampy25/quickentity-rs/releases/latest/download/quickentity-rs.exe", target, downloadOptions))
	return "downloaded"
}

async function ensureQuickEntity3(): Promise<EnsureResult> {
	const target = join(destinationDirectory, "quickentity-3.exe")
	if (await requireTask(pathExists(target))) return "already downloaded"

	// The 3.0 release's executable is named quickentity-rs.exe upstream, but the app keeps a
	// separate filename because it selects the 3.0 and 3.1 command-line behaviors independently.
	await requireTask(downloadFile("https://github.com/atampy25/quickentity-rs/releases/download/3.0/quickentity-rs.exe", target, downloadOptions))
	return "downloaded"
}

async function ensureArchive(specification: ArchiveSpecification): Promise<EnsureResult> {
	return requireTask(ensureArchiveFiles(specification, destinationDirectory, downloadOptions))
}

async function findNativeSevenZipCli(): Promise<string | null> {
	return requireTask(findExecutable(["7zz", "7z", "7za"], ["i"]))
}

async function ensureSevenZip(): Promise<EnsureResult> {
	const target = join(destinationDirectory, "7z.exe")
	if (await requireTask(pathExists(target))) return "already downloaded"

	return requireTask(withTemporaryDirectory("smf-7z", (temporaryDirectory) => tryScript("ensure 7-Zip", async () => {
		const archivePath = join(temporaryDirectory, "7z-extra.7z")
		const bootstrapPath = join(temporaryDirectory, "7zr.exe")
		const extractionDirectory = join(temporaryDirectory, "extracted")
		const nativeSevenZip = process.platform !== "win32" ? await findNativeSevenZipCli() : null
		if (process.platform !== "win32" && !nativeSevenZip) {
			throw new Error('no "7zz"/"7z"/"7za" found on PATH to extract the upstream 7-Zip release - run this from `nix develop .#e2e` (provides 7zz) or install p7zip')
		}

		// Windows needs 7zr.exe to bootstrap extraction. Start it while release metadata is fetched;
		// Linux uses a native 7-Zip executable already on PATH instead.
		const bootstrapDownload =
			process.platform === "win32"
				? requireTask(downloadFile("https://github.com/ip7z/7zip/releases/latest/download/7zr.exe", bootstrapPath, downloadOptions))
				: Promise.resolve()
		const releasePromise = requireTask(fetchJson<GitHubRelease>("https://api.github.com/repos/ip7z/7zip/releases/latest", githubApiOptions))
		const release = await releasePromise
		const assets = release.assets ?? []
		const assetNames = assets.map((asset) => asset.name)
		if (debug) debugLog(`ip7z/7zip latest release ${release.tag_name}, assets: ${assetNames.join(", ")}`)
		const asset = assets.find((candidate) => /^7z\d+-extra\.7z$/i.test(candidate.name))
		if (!asset) {
			throw new Error(
				`Couldn't find a "*-extra.7z" asset on the latest github.com/ip7z/7zip release (${release.tag_name ?? "unknown tag"}) - the release layout may have changed. Assets found: [${assetNames.join(", ")}]`
			)
		}
		if (debug) debugLog(`matched asset ${asset.name} -> ${asset.browser_download_url}`)

		await Promise.all([bootstrapDownload, requireTask(downloadFile(asset.browser_download_url, archivePath, downloadOptions))])
		const extractor = process.platform === "win32" ? bootstrapPath : nativeSevenZip
		if (!extractor) throw new Error("No 7-Zip extractor is available")
		if (debug) debugLog(`extracting with ${process.platform === "win32" ? `bootstrap ${bootstrapPath}` : `native ${extractor}`}`)
		await requireTask(extractSevenZipArchive(archivePath, extractionDirectory, extractor))

		// The Extra package contains both a top-level 32-bit executable and x64/7za.exe. Native
		// Linux Wine installations may be 64-bit-only, so select x64 there.
		let found: string | null = null
		try {
			found = await requireTask(findFile(process.platform === "win32" ? extractionDirectory : join(extractionDirectory, "x64"), "7za.exe"))
		} catch {
			// A missing x64 directory is reported by the common layout error below.
		}
		if (!found) {
			throw new Error(`Couldn't find 7za.exe inside ${asset.name} - the package layout may have changed. Place a 7-Zip build at "extra/Third-Party/7z.exe" yourself.`)
		}

		// Always store the binary under the name expected by the application. On non-Windows the
		// app's Wine interop layer decides how to execute it later.
		await requireTask(copyFileAtomically(found, target))
		return "downloaded"
	}, { path: target }))).then(result => result as EnsureResult)
}

type SetupTask = () => Promise<EnsureResult>

async function task(label: string, placeHint: string, operation: SetupTask): Promise<void> {
	try {
		console.log(`${label}: ${await operation()}`)
	} catch (error) {
		console.warn(`Couldn't fetch ${label} automatically (${errorMessage(error)}). ${placeHint}`)
		if (debug) {
			const stack = errorStack(error)
			if (stack) console.error(stack)
		}
	}
}

async function main(): Promise<void> {
	await requireTask(ensureDirectory(destinationDirectory))
	if (debug) debugLog(`SMF_DEBUG on - platform=${process.platform}, bun=${Bun.version}`)

	// These release-backed tools have independent sources and destinations. Keep them concurrent;
	// only the archive download/extract/copy sequence inside an individual task is ordered.
	await Promise.all([
		task("extra/Third-Party/quickentity-3.exe", 'Place it in "extra/Third-Party/" by hand.', ensureQuickEntity3),
		task("extra/Third-Party/quickentity-rs.exe", 'Place it in "extra/Third-Party/" by hand.', ensureQuickEntityRs),
		task(
			"extra/Third-Party/{HMLanguageTools.exe, HMTextureTools.exe}",
			'Place HMLanguageTools.exe and HMTextureTools.exe in "extra/Third-Party/" by hand.',
			() => ensureArchive(tonyToolsArchive)
		),
		task(
			"extra/Third-Party/{rpkg-cli.exe, quickentity_ffi.dll, assimp.dll, hash_list.hmla}",
			'Place the RPKG CLI release files in "extra/Third-Party/" by hand.',
			() => ensureArchive(rpkgToolsArchive)
		),
		task(
			"extra/Third-Party/{ResourceTool.exe, ResourceLib_HM2.dll, ResourceLib_HM2016.dll, ResourceLib_HM3.dll}",
			'Place the ZHMTools ResourceTool release files in "extra/Third-Party/" by hand.',
			() => ensureArchive(zhmToolsArchive)
		),
		task("extra/Third-Party/xdelta3.exe", 'Place xdelta3.exe in "extra/Third-Party/" by hand.', () => ensureArchive(xdeltaArchive)),
		task("extra/Third-Party/7z.exe", 'Place a 7-Zip build at "extra/Third-Party/7z.exe" by hand.', ensureSevenZip)
	])
}

try {
	await main()
} catch (error) {
	console.error(`Third-party setup failed: ${errorMessage(error)}`)
	process.exitCode = 1
}
