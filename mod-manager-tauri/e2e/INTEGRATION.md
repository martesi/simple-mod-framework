# Integration tests — real game, real mods

The stub e2e tests in `app.e2e.test.js` use a fake game layout and a shell-script
`Deploy.exe` so they run anywhere without a game install. Integration tests go
one level deeper: they use the real `Deploy.exe` binary against a real (or
realistic) game directory and real mod zips, verifying the full install → enable
→ deploy → output pipeline end to end.

## Safety: `outputToSeparateDirectory`

Without a guard, running `Deploy.exe` would overwrite files directly inside the
game's `Runtime/` folder — patched `.rpkg` chunks, `packagedefinition.txt`,
`thumbs.dat`. Recovery would require Steam "Verify integrity of game files."

The framework's `outputToSeparateDirectory: true` flag routes every write to a
sibling `Output/` directory instead. `Runtime/` is read-only from Deploy.exe's
point of view. The integration fixture always sets this flag, so:

- game install is never mutated
- cleanup is `rm -rf Output/`
- the same game directory can be reused across test runs

Deploy.exe still **reads** real `.rpkg` chunks to extract hashes and entity
data. A real (or near-complete) `Runtime/` is therefore required for any mod
that patches existing assets. RPKG-only "add" mods that only introduce new hashes
can work with a minimal stub chunk, but most framework mods cannot.

## Opt-in config file

Integration tests only run when `e2e/integration.json` exists. That file is
already gitignored by the `*.local` rule in `.gitignore`, so it is never
accidentally committed.

Create it by copying the example and filling in your paths:

```sh
cp e2e/integration.example.json e2e/integration.json
# fill in gamePath, mods, and optionally deployExe
```

### Schema

```jsonc
{
  // Absolute path to the directory that contains Runtime/, Retail/, etc.
  // This is the parent of the framework root — the same folder you point
  // the existing Mod Manager at.
  "gamePath": "/path/to/HITMAN3",

  // One or more mod archives to install during the test run.
  // May be .zip, .7z, .rar, or .rpkg files.
  // Listed mods are installed in order; each must be a framework mod
  // (has a manifest.json at the archive root) unless it ends in .rpkg.
  "mods": [
    "/path/to/SomeMod.zip",
    "/path/to/AnotherMod.zip"
  ],

  // Optional: the framework root inside gamePath (the folder holding
  // config.json + Deploy.exe + Mods/).  Auto-detected when omitted — the
  // fixture scans gamePath's children for it (real installs name it
  // "Simple Mod Framework").  Set this only if auto-detection fails.
  "frameworkPath": "/path/to/HITMAN3/Simple Mod Framework",

  // Optional: a pre-built Deploy.exe to swap in for the test run.  When
  // omitted, the install's existing Deploy.exe is used as-is.  When set, the
  // original is backed up and restored on teardown.
  "deployExe": "/path/to/Deploy.exe"
}
```

## What is tested

Each integration test run exercises the full UI path through the real binary:

1. **Startup** — app resolves `gamePath/framework/Mod Manager/mod-manager` as
   `exe`, derives `gamePath/framework/` as framework root, reads `config.json`.
   Test asserts the home screen renders without a "can't find config" modal.

2. **Mod install** — each archive in `mods` is installed into
   `<frameworkRoot>/Mods` **before launch**, mirroring the app's own
   `installFrameworkMod` / `installRPKGMod` (extract framework mods, copy
   `.rpkg` mods into a `chunkN/` folder). WebDriver cannot drive the GTK
   file-open dialog or Tauri drag-drop (see README "not covered"), so the
   install is done on the Node side and the real `getAllMods` discovers it at
   startup. The fixture also merges the new mod ids into `knownMods` so the app
   doesn't flag them as "extracted" and pop a blocking dialog. Test asserts each
   mod appears in the Available Mods list with the correct name from its
   manifest.

3. **Enable + persist** — each mod is enabled via the Enable button. Test
   asserts `config.json` loadOrder contains the mod IDs within 10 s (same
   assertion as the stub test).

4. **Deploy → Output/** — the Apply button is clicked. The real `Deploy.exe` is
   spawned (not the stub). Test waits up to 120 s for the "Deploy successful"
   or "Deploy unsuccessful" span to appear (a failure span fails the test with
   the deploy log), then against `<gamePath>/Output`:
   - asserts `Output/` exists and is non-empty
   - asserts `Output/packagedefinition.txt` exists
   - asserts at least one `chunk*patch<N>.rpkg` is present in `Output/`
   - asserts `Runtime/chunk0.rpkg` mtime is unchanged (game files untouched)

5. **Cleanup** — the fixture teardown unwinds every mutation in reverse:
   `<gamePath>/Output/` is deleted, `Mods/` entries installed during the test
   are removed, `config.json` is restored verbatim (undoing the
   `outputToSeparateDirectory` / `knownMods` edits), any `Deploy.exe` override
   is reverted, and the app binary is removed (restoring a pre-existing one from
   backup). The game directory is left exactly as it started.

## Running locally

```sh
# from mod-manager-tauri/, inside nix develop (or with cargo-tauri + webkitgtk on PATH)

# build the real Deploy.exe first (if not already built at repo root)
cd .. && npm run build:linux && cd mod-manager-tauri

# build the Tauri debug binary
npm run test:e2e:build

# run both stub and integration tests
xvfb-run -a npm run test:e2e

# run only integration tests (if you want to skip the stub suite)
xvfb-run -a node --test "e2e/integration.test.js"
```

If `e2e/integration.json` is absent, `integration.test.js` prints a single
skip message and exits 0 — it does not fail the suite.

## CI

Integration tests are **not** run in CI by default: the runner has no game
install and the game is ~60 GB. The stub tests in `app.e2e.test.js` cover the
Tauri/WebKit/Rust bridge; integration tests are a local developer gate.

A future CI job could run integration tests against a minimal game stub (a
real `chunk0.rpkg` plus stub `Retail/`) if asset size becomes manageable, but
that is out of scope for now.
