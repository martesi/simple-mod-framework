# End-to-end tests

Real end-to-end tests: they launch the actual app binary (real WebKit webview,
real Rust IO bridge) via [tauri-driver](https://crates.io/crates/tauri-driver)
and drive it over WebDriver with WebdriverIO.

Each run builds a throwaway SMF install under `e2e/.runtime/game/` — fixture
`config.json`, a `Mods/` folder with one framework mod and one RPKG-only mod,
and a stub `Deploy.exe` that prints SMF-style output — and places the app
binary inside it so the framework-root resolution (`exe dir/..`) is exercised
for real.

## Prerequisites

All of these are available inside the repo's dev shell (`nix develop`):

- `WebKitWebDriver` (ships with webkitgtk)
- `xvfb-run` for headless runs
- `tauri-driver` — one-time install: `cargo install tauri-driver --locked`
  (found via `PATH` or `~/.cargo/bin`; override with `$TAURI_DRIVER`)

## Running

```sh
# from mod-manager-tauri/, inside nix develop
npm run test:e2e:build        # build the debug app binary (embedded assets)
xvfb-run -a npm run test:e2e  # headless; omit xvfb-run if you have a display
```

Environment overrides:

- `E2E_APP_BINARY` — app binary to test (default `src-tauri/target/debug/mod-manager-tauri`)
- `E2E_DRIVER_PORT` — tauri-driver port (default 4444)
- `TAURI_DRIVER`, `WEBKIT_WEBDRIVER` — explicit driver binary paths

## Integration tests (real game + real Deploy.exe)

See [INTEGRATION.md](INTEGRATION.md) for the full plan.  The short version:
create `e2e/integration.json` (gitignored) with your game path and mod zips —
the `integration.test.js` suite will pick it up automatically and skip if the
file is absent.

## What's covered / not covered

Covered: launch + framework-root path resolution, mod discovery and listing,
enabling a mod with persistence to `config.json`, and the deploy flow
(spawning `Deploy.exe`, streaming its output into the modal).

Not covered: flows that require native file-open dialogs (Add a Mod) or
drag-drop, since WebDriver can't drive GTK dialogs, and the auto-install
deep-link flow, which needs a network download.
