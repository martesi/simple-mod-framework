// pkg (see package.json's "pkg.scripts") needs to bundle piscina's worker file,
// but piscina is vendored in ./piscina rather than installed from npm, so it
// isn't in node_modules for pkg to find. Stage it there.
//
// This replaces the CI-only `robocopy ./piscina ./node_modules/piscina` step
// so the same thing works identically in CI and in a local build.
const fs = require("fs")
const path = require("path")

const src = path.join(__dirname, "..", "piscina")
const dest = path.join(__dirname, "..", "node_modules", "piscina")

fs.mkdirSync(dest, { recursive: true })
fs.cpSync(src, dest, { recursive: true })

console.log(`Staged ${src} -> ${dest}`)
