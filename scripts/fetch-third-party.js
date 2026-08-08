// Downloads the Third-Party tools that have a stable public release to pull
// from, so a fresh clone doesn't need them placed by hand:
//
//   - quickentity-rs.exe  <- github.com/atampy25/quickentity-rs (latest release)
//   - HMLanguageTools.exe, HMTextureTools.exe
//     <- extracted from TonyTools.zip, github.com/AnthonyFuller/TonyTools (latest release)
//     (TonyTools-LICENSE is NOT in that zip - TonyTools doesn't bundle a
//     license file in its releases, so that one is committed instead, in
//     extra/Third-Party/)
//   - 7z.exe
//     <- actually 7za.exe, extracted from the "Extra: standalone console
//     version" package, github.com/ip7z/7zip (latest release), and copied
//     to dest as "7z.exe" (the filename the rest of the codebase - Mod
//     Manager's archive extraction, scripts/fetch-hashes.js - expects). The
//     Extra package doesn't contain the full 7z.exe/7z.dll pair (that only
//     ships in 7-Zip's installer/msi); 7za.exe is its statically-linked
//     "alone" build, needing no companion DLL, with slightly narrower
//     format support (no RAR) that doesn't matter for the zip/7z archives
//     used here.
//     That package's filename embeds the version (e.g. 7z2602-extra.7z), so
//     unlike quickentity-rs.exe/TonyTools.zip above there's no fixed
//     "latest/download/<name>" URL for it - the GitHub API's releases/latest
//     endpoint is queried instead to find the matching asset by name
//     pattern. (This used to scrape https://www.7-zip.org/download.html for
//     the same link, but that page doesn't reliably serve a scriptable
//     response - the GitHub API is the more reliable source it should've
//     used from the start.) Extracting that "*-extra.7z" wrapper archive
//     itself needs a 7-Zip build: on Windows, 7zr.exe (7-Zip's own
//     dependency-free minimal extractor, published for exactly this
//     bootstrapping problem); on Linux, whatever native "7zz"/"7z"/"7za" is
//     already on PATH (see findNativeSevenZipCli() - `nix develop .#e2e`
//     provides 7zz for this, see flake.nix).
//     7za.exe itself is still a win32 PE binary - it can't be exec'd
//     directly on Linux, and this sandbox has no root to make the kernel
//     exec PE binaries via Wine directly (binfmt_misc) the way a real
//     desktop Wine install would. Unlike the old approach here (copying the
//     real binary to "7z-real.exe" and generating a `wine` shebang-script
//     wrapper named "7z.exe"), that's now handled at call time instead: this
//     script always just copies 7za.exe straight to "7z.exe" on every
//     platform, and src/main/archive.ts runs it through src/main/wineExec.ts
//     (which decides whether to prefix `wine`) rather than needing a
//     generated wrapper file - the same interop point every other bundled
//     Third-Party tool now goes through too, not just this one.
//     (7z-LICENSE isn't fetched here - unconfirmed whether the Extra
//     package bundles it, so it stays committed in extra/Third-Party/
//     either way.)
//
// These land in "extra/Third-Party/", alongside the tools committed straight
// to git (see .gitignore - each downloaded filename is ignored individually
// there, since the directory as a whole is not: nothing here is ever the
// only copy of a file, so there's nothing to lose by wiping one of these and
// re-running this script, unlike the committed tools sharing the same
// folder.
//
// Safe to re-run - skips anything already downloaded. Never throws: a
// network hiccup here shouldn't fail the "npm install" this runs from as
// part of postinstall (see scripts/setup.js), so failures are logged as
// warnings.
import fs from "fs"
import https from "https"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const root = path.join(__dirname, "..")
const dest = path.join(root, "extra", "Third-Party")
fs.mkdirSync(dest, { recursive: true })

// Set SMF_DEBUG=1 to log every HTTP request this script makes (status,
// rate-limit headers, a body snippet) - see download()/fetchJson() below.
const DEBUG = !!process.env.SMF_DEBUG

function download(url, destPath, redirectsLeft = 5) {
	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(destPath)
		https
			.get(url, { headers: { "User-Agent": "simple-mod-framework-setup" } }, (res) => {
				if (DEBUG) console.error(`[debug] GET ${url} -> ${res.statusCode}`)
				if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
					file.close()
					fs.rmSync(destPath, { force: true })
					if (redirectsLeft <= 0) return reject(new Error("Too many redirects"))
					return download(res.headers.location, destPath, redirectsLeft - 1).then(resolve, reject)
				}
				if (res.statusCode !== 200) {
					file.close()
					fs.rmSync(destPath, { force: true })
					return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
				}
				res.pipe(file)
				file.on("finish", () => file.close(resolve))
			})
			.on("error", (err) => {
				if (DEBUG) console.error(`[debug] GET ${url} -> network error: ${err.code ?? err.message}`)
				fs.rmSync(destPath, { force: true })
				reject(err)
			})
	})
}

// Set SMF_DEBUG=1 to log every request's status/headers/body snippet before
// the usual success/failure handling - useful for diagnosing "can't
// download" reports (e.g. distinguishing a rate limit from a network/proxy
// block from an API shape change) without having to add one-off
// console.logs each time. GitHub also requires a User-Agent on API requests
// (unlike plain release-asset downloads via `download()` above, which don't
// hit the API at all).
function fetchJson(url, redirectsLeft = 5) {
	return new Promise((resolve, reject) => {
		https
			.get(url, { headers: { "User-Agent": "simple-mod-framework-setup", Accept: "application/vnd.github+json" } }, (res) => {
				if (DEBUG) {
					console.error(`[debug] GET ${url} -> ${res.statusCode}`)
					console.error(`[debug]   x-ratelimit-remaining: ${res.headers["x-ratelimit-remaining"]}`)
					console.error(`[debug]   x-ratelimit-reset: ${res.headers["x-ratelimit-reset"]}`)
				}
				if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
					if (redirectsLeft <= 0) return reject(new Error("Too many redirects"))
					return fetchJson(res.headers.location, redirectsLeft - 1).then(resolve, reject)
				}
				let data = ""
				res.setEncoding("utf8")
				res.on("data", (chunk) => (data += chunk))
				res.on("end", () => {
					if (DEBUG) console.error(`[debug]   body: ${data.slice(0, 500)}`)
					if (res.statusCode !== 200) {
						let ghMessage = ""
						try {
							ghMessage = JSON.parse(data).message ?? ""
						} catch {
							// body wasn't JSON (e.g. an HTML error page from a proxy) - fall through with no extra detail
						}
						const rateLimited = res.statusCode === 403 && res.headers["x-ratelimit-remaining"] === "0"
						return reject(
							new Error(
								`HTTP ${res.statusCode} fetching ${url}` +
									(ghMessage ? ` - ${ghMessage}` : "") +
									(rateLimited ? ` (unauthenticated GitHub API rate limit hit - resets ${new Date(Number(res.headers["x-ratelimit-reset"]) * 1000).toLocaleString()})` : "")
							)
						)
					}
					try {
						resolve(JSON.parse(data))
					} catch (e) {
						reject(new Error(`Couldn't parse JSON from ${url}: ${e.message} - body started with: ${data.slice(0, 200)}`))
					}
				})
			})
			.on("error", (err) => {
				if (DEBUG) console.error(`[debug] GET ${url} -> network error: ${err.code ?? err.message}`)
				reject(err)
			})
	})
}

function extractZip(zipPath, destDir) {
	fs.mkdirSync(destDir, { recursive: true })
	if (process.platform === "win32") {
		execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`])
	} else {
		execFileSync("unzip", ["-o", zipPath, "-d", destDir])
	}
}

// The exact folder layout inside a third-party zip isn't something this
// script controls, so search for each file by name (case-insensitive)
// instead of assuming a path.
function findFile(dir, name) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			const found = findFile(entryPath, name)
			if (found) return found
		} else if (entry.name.toLowerCase() === name.toLowerCase()) {
			return entryPath
		}
	}
	return null
}

async function ensureQuickEntityRs() {
	const target = path.join(dest, "quickentity-rs.exe")
	if (fs.existsSync(target)) return "already downloaded"

	await download("https://github.com/atampy25/quickentity-rs/releases/latest/download/quickentity-rs.exe", target)
	return "downloaded"
}

async function ensureTonyTools() {
	const files = ["HMLanguageTools.exe", "HMTextureTools.exe"]
	if (files.every((f) => fs.existsSync(path.join(dest, f)))) return "already downloaded"

	const zipPath = path.join(os.tmpdir(), "smf-TonyTools.zip")
	const extractDir = path.join(os.tmpdir(), "smf-TonyTools-extracted")
	try {
		await download("https://github.com/AnthonyFuller/TonyTools/releases/latest/download/TonyTools.zip", zipPath)

		fs.rmSync(extractDir, { recursive: true, force: true })
		extractZip(zipPath, extractDir)

		for (const file of files) {
			const found = findFile(extractDir, file)
			if (!found) {
				throw new Error(
					`Couldn't find ${file} inside TonyTools.zip - the release layout may have changed. Check https://github.com/AnthonyFuller/TonyTools/releases/latest by hand and place it in "extra/Third-Party/" yourself.`
				)
			}
			fs.copyFileSync(found, path.join(dest, file))
		}
	} finally {
		fs.rmSync(zipPath, { force: true })
		fs.rmSync(extractDir, { recursive: true, force: true })
	}

	return "downloaded"
}

// Finds a native (non-Windows) 7-Zip CLI on PATH to extract the "*-extra.7z" release asset
// below with - "7zz" is 7-Zip's own official Linux build (what `nix develop .#e2e` provides,
// see flake.nix), "7z"/"7za" cover a p7zip install. Tried in that order; returns null if none
// are on PATH.
function findNativeSevenZipCli() {
	for (const candidate of ["7zz", "7z", "7za"]) {
		try {
			execFileSync(candidate, ["i"], { stdio: "ignore" })
			return candidate
		} catch {
			// not on PATH (or not runnable) - try the next candidate
		}
	}
	return null
}

async function ensureSevenZip() {
	if (fs.existsSync(path.join(dest, "7z.exe"))) return "already downloaded"

	const archivePath = path.join(os.tmpdir(), "smf-7z-extra.7z")
	const bootstrapPath = path.join(os.tmpdir(), "smf-7zr.exe")
	const extractDir = path.join(os.tmpdir(), "smf-7z-extracted")

	// 7zr.exe is a dependency-free minimal extractor 7-Zip itself publishes specifically so its
	// own .7z-packaged releases can be unpacked without already having 7-Zip installed - the
	// exact bootstrapping problem this function would otherwise have. It's a fixed URL with no
	// dependency on the release metadata below, so kick it off now and let it download
	// concurrently with everything else. Windows only needs this: on Linux, extraction below
	// uses whatever native "7zz"/"7z" the dev shell already provides instead (see
	// findNativeSevenZipCli()), so don't even start this download there.
	const bootstrapDownload =
		process.platform === "win32" ? download("https://github.com/ip7z/7zip/releases/latest/download/7zr.exe", bootstrapPath) : Promise.resolve()
	// Without this, a rejection here before the `await Promise.all([bootstrapDownload, ...])`
	// below reaches it would be an unhandled rejection (Node treats those as fatal) -
	// this no-op handler just marks it "observed"; the real error still propagates
	// normally when bootstrapDownload is awaited below.
	bootstrapDownload.catch(() => {})

	const nativeSevenZip = process.platform !== "win32" ? findNativeSevenZipCli() : null
	if (process.platform !== "win32" && !nativeSevenZip) {
		throw new Error('no "7zz"/"7z"/"7za" found on PATH to extract the upstream 7-Zip release - run this from `nix develop .#e2e` (provides 7zz) or install p7zip')
	}

	try {
		const release = await fetchJson("https://api.github.com/repos/ip7z/7zip/releases/latest")
		const assetNames = (release.assets ?? []).map((a) => a.name)
		if (DEBUG) console.error(`[debug] ip7z/7zip latest release ${release.tag_name}, assets: ${assetNames.join(", ")}`)
		const asset = (release.assets ?? []).find((a) => /^7z\d+-extra\.7z$/i.test(a.name))
		if (!asset) {
			throw new Error(
				`Couldn't find a "*-extra.7z" asset on the latest github.com/ip7z/7zip release (${release.tag_name ?? "unknown tag"}) - the release layout may have changed. Assets found: [${assetNames.join(", ")}]`
			)
		}
		if (DEBUG) console.error(`[debug] matched asset ${asset.name} -> ${asset.browser_download_url}`)

		await Promise.all([bootstrapDownload, download(asset.browser_download_url, archivePath)])

		fs.rmSync(extractDir, { recursive: true, force: true })
		fs.mkdirSync(extractDir, { recursive: true })
		if (process.platform === "win32") {
			execFileSync(bootstrapPath, ["x", archivePath, `-o${extractDir}`, "-y"])
		} else {
			if (DEBUG) console.error(`[debug] extracting with native "${nativeSevenZip}"`)
			execFileSync(nativeSevenZip, ["x", archivePath, `-o${extractDir}`, "-y"])
		}

		// The "Extra" package doesn't actually contain 7z.exe/7z.dll (the
		// full command-line build, which needs 7z.dll for its codecs) -
		// it ships 7za.exe instead, the statically-linked "alone" build
		// that needs no companion DLL (fewer formats than 7z.exe - no RAR -
		// but zip/7z/gzip/bzip2/tar, which is all mod archives use here).
		if (DEBUG) console.error(`[debug] extracted ${asset.name}, contents: ${fs.readdirSync(extractDir).join(", ")}`)
		// The package roots both a 32-bit 7za.exe (top level) and a 64-bit one (x64/) - on
		// Windows either runs natively so it's never mattered which findFile() happened to hit
		// first (top level, alphabetically before "x64"). On Linux it matters: nixpkgs' `wine64`
		// is a 64-bit-only build with no WoW64/32-bit support, so handing it the 32-bit binary
		// fails opaquely (`wine: failed to load ntdll.dll error c0000135`) - search x64/ specifically.
		const found = process.platform === "win32" ? findFile(extractDir, "7za.exe") : findFile(path.join(extractDir, "x64"), "7za.exe")
		if (!found) {
			throw new Error(`Couldn't find 7za.exe inside ${asset.name} - the package layout may have changed. Place a 7-Zip build at "extra/Third-Party/7z.exe" yourself.`)
		}

		// Copied to dest as "7z.exe" regardless of platform - nothing else in the codebase (Mod
		// Manager's archive extraction, scripts/fetch-hashes.js) needs to know the difference. On
		// non-win32, src/main/archive.ts runs this under Wine itself at call time (see
		// src/main/wineExec.ts) rather than needing a generated wrapper script here - one interop
		// decision point instead of a per-binary file-renaming trick.
		fs.copyFileSync(found, path.join(dest, "7z.exe"))
	} finally {
		fs.rmSync(archivePath, { force: true })
		fs.rmSync(bootstrapPath, { force: true })
		fs.rmSync(extractDir, { recursive: true, force: true })
	}

	return "downloaded"
}

if (DEBUG) console.error(`[debug] SMF_DEBUG on - platform=${process.platform}, node=${process.version}`)

// The three tools below don't depend on each other at all (different
// sources, different destination files), so they fetch concurrently rather
// than one-after-another - only fetch/extraction steps *within* each one
// (see ensureTonyTools/ensureSevenZip above) have a real ordering
// dependency. Each task already contains its own try/catch (never throws -
// see the file-level comment above), so Promise.all here just waits for
// all three to finish without any of them being able to short-circuit it.
async function task(label, placeHint, fn) {
	try {
		console.log(`${label}: ${await fn()}`)
	} catch (e) {
		console.warn(`Couldn't fetch ${label} automatically (${e.message}). ${placeHint}`)
		if (DEBUG) console.error(e.stack)
	}
}

// Top-level await (native in ESM) replaces the old CommonJS `;(async () => { ... })()` IIFE.
await Promise.all([
	task("extra/Third-Party/quickentity-rs.exe", 'Place it in "extra/Third-Party/" by hand.', ensureQuickEntityRs),
	task(
		"extra/Third-Party/{HMLanguageTools.exe, HMTextureTools.exe}",
		'Place HMLanguageTools.exe and HMTextureTools.exe in "extra/Third-Party/" by hand.',
		ensureTonyTools
	),
	task("extra/Third-Party/7z.exe", 'Place a 7-Zip build at "extra/Third-Party/7z.exe" by hand.', ensureSevenZip)
])
