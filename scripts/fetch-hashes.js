// Downloads the latest hitman-hashes release and extracts it into the given
// Third-Party/ folder - either dist/Third-Party (release assembly, see
// "assemble:win") or build/Third-Party (dev runtime, see scripts/setup.js -
// the CLI needs these hashes to run/deploy locally too, not just in a
// packaged release).
//
// Relies on 7z.exe already being present at build/Third-Party/7z.exe (staged
// by scripts/link-third-party.js), regardless of which folder is the actual
// extraction target - so this must run after setup.js's link-third-party
// step, same as it already had to run after "npm install" for assemble:win.
//
// Usage: node scripts/fetch-hashes.js <dist|build>
const child_process = require("child_process")
const fs = require("fs")
const https = require("https")
const os = require("os")
const path = require("path")

const target = process.argv[2]
if (target !== "dist" && target !== "build") {
	console.error("Usage: node scripts/fetch-hashes.js <dist|build>")
	process.exit(1)
}

const url = "https://github.com/glacier-modding/hitman-hashes/releases/latest/download/latest-hashes.7z"
const tmp = path.join(os.tmpdir(), "latest-hashes.7z")
const dest = path.join(__dirname, "..", target, "Third-Party")

fs.mkdirSync(dest, { recursive: true })

function download(url, dest, cb) {
	const file = fs.createWriteStream(dest)
	https.get(url, (res) => {
		if (res.statusCode === 301 || res.statusCode === 302) {
			file.destroy()
			return download(res.headers.location, dest, cb)
		}
		if (res.statusCode !== 200) {
			file.destroy()
			return cb(new Error(`HTTP ${res.statusCode} fetching ${url}`))
		}
		res.pipe(file)
		file.on("finish", () => file.close(cb))
	}).on("error", (err) => {
		fs.unlink(dest, () => {})
		cb(err)
	})
}

const sevenZip = process.platform === "win32"
	? path.join(__dirname, "..", "build", "Third-Party", "7z.exe")
	: "7z"

console.log("Fetching hitman-hashes...")
download(url, tmp, (err) => {
	if (err) {
		console.error("Download failed:", err.message)
		process.exit(1)
	}
	try {
		child_process.execSync(`"${sevenZip}" x "${tmp}" -o"${dest}" -y`, { stdio: "inherit" })
		fs.unlinkSync(tmp)
		console.log(`Extracted hitman-hashes to ${dest}`)
	} catch (e) {
		console.error("Extraction failed:", e.message)
		process.exit(1)
	}
})
