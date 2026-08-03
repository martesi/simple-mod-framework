// `npm run dev`/`npm run preview` launch whatever Electron binary node_modules/electron
// downloaded for the *host* platform - the actual Linux binary on a WSL host, which can
// only ever render through WSLg (or nothing, on a plain headless WSL setup) even though
// this is a win-only app (see electron-builder.yml's `win:` section) that only ever needs
// to run as the real Windows binary. `npm run dev:win` (see package.json) points
// electron-vite's own ELECTRON_EXEC_PATH override at a separate win32-x64 Electron this
// script fetches, so the *actual* Windows Electron process launches (via WSL's reverse
// interop for PE binaries) against the normal Vite dev server - hot reload, but against
// the real target platform instead of a Linux stand-in.
//
// Must be extracted somewhere WSL's reverse interop can resolve from the Windows side -
// that's anywhere under this repo (backed by the WSL2 VM's own ext4 disk, shared with
// Windows over \\wsl.localhost\), NOT os.tmpdir() (a sandboxed agent's /tmp may live on a
// mount Windows can't see at all, which fails opaquely - "Invalid argument" - rather than
// with a clear permissions/not-found error).
//
// Safe to re-run - skips extraction if a matching version is already present. Reuses
// node_modules/electron's own download cache (~/.cache/electron/) when possible, since
// `npm install`/electron-builder --win typically already populated it - falls back to
// downloading fresh from GitHub Releases otherwise.
import fs from "fs"
import os from "os"
import path from "path"
import { execFileSync } from "child_process"
import { fileURLToPath } from "url"
import https from "https"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, "..")

const { version } = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf-8"))

const destDir = path.join(root, ".win-electron-dev")
const versionMarker = path.join(destDir, ".version")
const exePath = path.join(destDir, "electron.exe")

const markerExists = fs.existsSync(versionMarker)
const markerVersion = markerExists ? fs.readFileSync(versionMarker, "utf-8").trim() : undefined
const exeExists = fs.existsSync(exePath)

if (markerExists && markerVersion === version && exeExists) {
	console.log(`.win-electron-dev/ already has Electron v${version}, skipping.`)
	process.exit(0)
} else if (markerExists || exeExists) {
	// Only one of the two survived (or the version moved on) since the last run - print exactly
	// what's missing/mismatched rather than silently falling through to a full redownload, since
	// that's otherwise indistinguishable from "cache never worked at all". A common cause on a
	// WSL-interop setup: Windows Defender/AV quarantines or deletes a freshly-extracted unsigned
	// .exe sitting under a WSL-backed folder (visible to Windows over \\wsl.localhost\) shortly
	// after it's written - check Windows Security's "Protection history" for a detection around
	// the time of the previous run if this keeps happening, and add an exclusion for this repo
	// (or just .win-electron-dev/) if so.
	console.log(
		`.win-electron-dev/ cache miss: version marker ${markerExists ? `present (v${markerVersion})` : "missing"}, electron.exe ${exeExists ? "present" : "missing"}, need v${version}. Re-fetching.`
	)
}

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

const zipName = `electron-v${version}-win32-x64.zip`
const cachedZip = path.join(os.homedir(), ".cache", "electron", zipName)

fs.rmSync(destDir, { recursive: true, force: true })
fs.mkdirSync(destDir, { recursive: true })

if (fs.existsSync(cachedZip)) {
	console.log(`Extracting cached ${zipName}...`)
	execFileSync("unzip", ["-oq", cachedZip, "-d", destDir])
} else {
	console.log(`Downloading ${zipName} (not in ~/.cache/electron/)...`)
	const tmpZip = path.join(os.tmpdir(), zipName)
	await download(`https://github.com/electron/electron/releases/download/v${version}/${zipName}`, tmpZip)
	execFileSync("unzip", ["-oq", tmpZip, "-d", destDir])
	fs.rmSync(tmpZip, { force: true })
}

fs.chmodSync(exePath, 0o755)
fs.writeFileSync(versionMarker, version)
console.log(`.win-electron-dev/ ready (Electron v${version})`)
