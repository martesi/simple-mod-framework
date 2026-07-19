// Downloads the Third-Party tools that have a stable public release to pull
// from, so a fresh clone doesn't need them placed by hand:
//
//   - quickentity-rs.exe  <- github.com/atampy25/quickentity-rs (latest release)
//   - HMLanguageTools.exe, HMTextureTools.exe
//     <- extracted from TonyTools.zip, github.com/AnthonyFuller/TonyTools (latest release)
//     (TonyTools-LICENSE is NOT in that zip - TonyTools doesn't bundle a
//     license file in its releases, so that one is committed instead, in
//     For Build/Third-Party/)
//   - 7z.exe, 7z.dll
//     <- extracted from the "Extra: standalone console version" package on
//     https://www.7-zip.org/download.html (mirrored on github.com/ip7z/7zip).
//     That package's filename embeds the version (e.g. 7z2602-extra.7z), so
//     there's no fixed URL for it - the download page is scraped for the
//     current one instead. Extracting it needs 7zr.exe, 7-Zip's own
//     dependency-free minimal extractor, published for exactly this
//     bootstrapping problem; Windows only, since that's the only platform
//     this repo ships 7z.exe/7z.dll for. (7z-LICENSE isn't fetched here -
//     unconfirmed whether the Extra package bundles it, so it stays
//     committed in For Build/Third-Party/ either way.)
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
// part of postinstall, so failures are logged as warnings, and
// scripts/link-third-party.js will just be short those files until this is
// re-run successfully (`npm run dev:fetch-third-party`) or they're placed by
// hand.
const fs = require("fs")
const https = require("https")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")

const root = path.join(__dirname, "..")
const dest = path.join(root, "For Build", "Fetched Third-Party")
fs.mkdirSync(dest, { recursive: true })

function download(url, destPath, redirectsLeft = 5) {
	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(destPath)
		https
			.get(url, { headers: { "User-Agent": "simple-mod-framework-setup" } }, (res) => {
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
				fs.rmSync(destPath, { force: true })
				reject(err)
			})
	})
}

function fetchText(url, redirectsLeft = 5) {
	return new Promise((resolve, reject) => {
		https
			.get(url, { headers: { "User-Agent": "simple-mod-framework-setup" } }, (res) => {
				if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
					if (redirectsLeft <= 0) return reject(new Error("Too many redirects"))
					return fetchText(res.headers.location, redirectsLeft - 1).then(resolve, reject)
				}
				if (res.statusCode !== 200) {
					return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
				}
				let data = ""
				res.setEncoding("utf8")
				res.on("data", (chunk) => (data += chunk))
				res.on("end", () => resolve(data))
			})
			.on("error", reject)
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
	const files = ["7z.exe", "7z.dll"]
	if (files.every((f) => fs.existsSync(path.join(dest, f)))) return "already downloaded"

	if (process.platform !== "win32") {
		throw new Error('automatic 7-Zip fetch is only implemented for Windows (extraction needs 7zr.exe, a Windows executable)')
	}

	const downloadPage = await fetchText("https://www.7-zip.org/download.html")
	const extraMatch = downloadPage.match(/https:\/\/github\.com\/ip7z\/7zip\/releases\/download\/[^/\s)]+\/7z\d+-extra\.7z/)
	if (!extraMatch) {
		throw new Error('Couldn\'t find the 7-Zip "Extra" package link on https://www.7-zip.org/download.html - the page layout may have changed.')
	}

	const archivePath = path.join(os.tmpdir(), "smf-7z-extra.7z")
	const bootstrapPath = path.join(os.tmpdir(), "smf-7zr.exe")
	const extractDir = path.join(os.tmpdir(), "smf-7z-extracted")
	try {
		// 7zr.exe is a dependency-free minimal extractor 7-Zip itself
		// publishes specifically so its own .7z-packaged releases can be
		// unpacked without already having 7-Zip installed - the exact
		// bootstrapping problem this function would otherwise have.
		await download("https://github.com/ip7z/7zip/releases/latest/download/7zr.exe", bootstrapPath)
		await download(extraMatch[0], archivePath)

		fs.rmSync(extractDir, { recursive: true, force: true })
		fs.mkdirSync(extractDir, { recursive: true })
		execFileSync(bootstrapPath, ["x", archivePath, `-o${extractDir}`, "-y"])

		for (const file of files) {
			const found = findFile(extractDir, file)
			if (!found) {
				throw new Error(`Couldn't find ${file} inside ${extraMatch[0]} - the package layout may have changed. Place it in "For Build/Fetched Third-Party/" yourself.`)
			}
			fs.copyFileSync(found, path.join(dest, file))
		}
	} finally {
		fs.rmSync(archivePath, { force: true })
		fs.rmSync(bootstrapPath, { force: true })
		fs.rmSync(extractDir, { recursive: true, force: true })
	}

	return "downloaded"
}

;(async () => {
	try {
		console.log(`For Build/Fetched Third-Party/quickentity-rs.exe: ${await ensureQuickEntityRs()}`)
	} catch (e) {
		console.warn(`Couldn't fetch quickentity-rs.exe automatically (${e.message}). Place it in "For Build/Fetched Third-Party/" by hand.`)
	}

	try {
		console.log(`For Build/Fetched Third-Party/{HMLanguageTools.exe, HMTextureTools.exe}: ${await ensureTonyTools()}`)
	} catch (e) {
		console.warn(`Couldn't fetch TonyTools automatically (${e.message}). Place HMLanguageTools.exe and HMTextureTools.exe in "For Build/Fetched Third-Party/" by hand.`)
	}

	try {
		console.log(`For Build/Fetched Third-Party/{7z.exe, 7z.dll}: ${await ensureSevenZip()}`)
	} catch (e) {
		console.warn(`Couldn't fetch 7-Zip automatically (${e.message}). Place 7z.exe and 7z.dll in "For Build/Fetched Third-Party/" by hand.`)
	}
})()
