// Downloads the Third-Party tools that have a stable public release to pull
// from, so a fresh clone doesn't need them placed by hand:
//
//   - quickentity-rs.exe  <- github.com/atampy25/quickentity-rs (latest release)
//   - HMLanguageTools.exe, HMTextureTools.exe
//     <- extracted from TonyTools.zip, github.com/AnthonyFuller/TonyTools (latest release)
//     (TonyTools-LICENSE is NOT in that zip - TonyTools doesn't bundle a
//     license file in its releases, so that one is committed instead, in
//     For Build/Third-Party/)
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
//     used from the start.) Extracting it needs 7zr.exe, 7-Zip's own
//     dependency-free minimal extractor, published for exactly this
//     bootstrapping problem; Windows only, since that's the only platform
//     this repo ships 7z.exe for.
//     (7z-LICENSE isn't fetched here - unconfirmed whether the Extra
//     package bundles it, so it stays committed in For Build/Third-Party/
//     either way.)
//
// These land in "For Build/Fetched Third-Party/", which is gitignored -
// nothing here is ever the only copy of a file, so there's nothing to lose
// by wiping it and re-running this script. Contrast with
// "For Build/Third-Party/", which holds the tools that DON'T have a source
// like this to fetch from, and so are committed to the repo instead, as
// regular (in a couple of cases multi-MB) git blobs - this repo is managed
// with jj, which doesn't support Git LFS, so there's no way around that. See
// .gitignore for the `jj config set --repo snapshot.max-new-file-size`
// needed to track them.
//
// Safe to re-run - skips anything already downloaded. Never throws: a
// network hiccup here shouldn't fail the "npm install" this runs from as
// part of postinstall (see scripts/setup.js), so failures are logged as
// warnings, and scripts/link-third-party.js will just be short those files
// until this is re-run successfully (`npm run setup`) or they're placed by
// hand.
const fs = require("fs")
const https = require("https")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")

const root = path.join(__dirname, "..")
const dest = path.join(root, "For Build", "Fetched Third-Party")
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
					`Couldn't find ${file} inside TonyTools.zip - the release layout may have changed. Check https://github.com/AnthonyFuller/TonyTools/releases/latest by hand and place it in "For Build/Fetched Third-Party/" yourself.`
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

async function ensureSevenZip() {
	if (fs.existsSync(path.join(dest, "7z.exe"))) return "already downloaded"

	if (process.platform !== "win32") {
		throw new Error('automatic 7-Zip fetch is only implemented for Windows (extraction needs 7zr.exe, a Windows executable)')
	}

	const archivePath = path.join(os.tmpdir(), "smf-7z-extra.7z")
	const bootstrapPath = path.join(os.tmpdir(), "smf-7zr.exe")
	const extractDir = path.join(os.tmpdir(), "smf-7z-extracted")

	// 7zr.exe is a dependency-free minimal extractor 7-Zip itself publishes
	// specifically so its own .7z-packaged releases can be unpacked without
	// already having 7-Zip installed - the exact bootstrapping problem this
	// function would otherwise have. It's a fixed URL with no dependency on
	// the release metadata below, so kick it off now and let it download
	// concurrently with everything else - only the extraction step at the
	// bottom genuinely needs it to be done.
	const bootstrapDownload = download("https://github.com/ip7z/7zip/releases/latest/download/7zr.exe", bootstrapPath)
	// Without this, a rejection here before the `await Promise.all([bootstrapDownload, ...])`
	// below reaches it would be an unhandled rejection (Node treats those as fatal) -
	// this no-op handler just marks it "observed"; the real error still propagates
	// normally when bootstrapDownload is awaited below.
	bootstrapDownload.catch(() => {})

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
		execFileSync(bootstrapPath, ["x", archivePath, `-o${extractDir}`, "-y"])

		// The "Extra" package doesn't actually contain 7z.exe/7z.dll (the
		// full command-line build, which needs 7z.dll for its codecs) -
		// it ships 7za.exe instead, the statically-linked "alone" build
		// that needs no companion DLL (fewer formats than 7z.exe - no RAR -
		// but zip/7z/gzip/bzip2/tar, which is all mod archives use here).
		// Copied to dest as "7z.exe" so nothing else in the codebase (Mod
		// Manager's archive extraction, scripts/fetch-hashes.js) needs to
		// know the difference.
		if (DEBUG) console.error(`[debug] extracted ${asset.name}, contents: ${fs.readdirSync(extractDir).join(", ")}`)
		const found = findFile(extractDir, "7za.exe")
		if (!found) {
			throw new Error(`Couldn't find 7za.exe inside ${asset.name} - the package layout may have changed. Place a 7-Zip build at "For Build/Fetched Third-Party/7z.exe" yourself.`)
		}
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

;(async () => {
	await Promise.all([
		task("For Build/Fetched Third-Party/quickentity-rs.exe", 'Place it in "For Build/Fetched Third-Party/" by hand.', ensureQuickEntityRs),
		task(
			"For Build/Fetched Third-Party/{HMLanguageTools.exe, HMTextureTools.exe}",
			'Place HMLanguageTools.exe and HMTextureTools.exe in "For Build/Fetched Third-Party/" by hand.',
			ensureTonyTools
		),
		task("For Build/Fetched Third-Party/7z.exe", 'Place a 7-Zip build at "For Build/Fetched Third-Party/7z.exe" by hand.', ensureSevenZip)
	])
})()
