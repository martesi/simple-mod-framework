// Assembles the ./dist release folder from the various build outputs.
//
// Replaces the block of `robocopy`/`New-Item` PowerShell steps duplicated
// across the CI workflows so the same logic runs identically in CI (Windows
// or Linux) and locally.
//
// Usage: node scripts/assemble-dist.js <win|linux>
const fs = require("fs")
const path = require("path")

const platform = process.argv[2]
if (platform !== "win" && platform !== "linux") {
	console.error("Usage: node scripts/assemble-dist.js <win|linux>")
	process.exit(1)
}

const root = path.join(__dirname, "..")
const dist = path.join(root, "dist")

fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(path.join(dist, "Third-Party"), { recursive: true })
fs.mkdirSync(path.join(dist, "Info"), { recursive: true })
fs.mkdirSync(path.join(dist, "API"), { recursive: true })
fs.mkdirSync(path.join(dist, "Mod Manager"), { recursive: true })

fs.cpSync(path.join(root, "Third-Party"), path.join(dist, "Third-Party"), { recursive: true })
fs.cpSync(path.join(root, "For Build"), dist, { recursive: true })
fs.cpSync(path.join(root, "docs"), path.join(dist, "Info"), { recursive: true })

for (const file of fs.readdirSync(path.join(root, "compiled"))) {
	if (file.endsWith(".d.ts")) {
		fs.copyFileSync(path.join(root, "compiled", file), path.join(dist, "API", file))
	}
}

const unpackedDir = platform === "win" ? "win-unpacked" : "linux-unpacked"
fs.cpSync(path.join(root, "Mod Manager", "dist", unpackedDir), path.join(dist, "Mod Manager"), { recursive: true })

fs.copyFileSync(path.join(root, "Deploy.exe"), path.join(dist, "Deploy.exe"))

if (platform === "win") {
	fs.writeFileSync(path.join(dist, "Mod Manager.cmd"), '@echo off\r\ncd "Mod Manager"\r\nstart "" "Mod Manager.exe"\r\n')
} else {
	const launcher = path.join(dist, "Mod Manager.sh")
	fs.writeFileSync(launcher, '#!/bin/sh\ncd "$(dirname "$0")/Mod Manager"\nexec ./modmanager "$@"\n')
	fs.chmodSync(launcher, 0o755)
}

console.log(`Assembled dist/ for ${platform}`)
