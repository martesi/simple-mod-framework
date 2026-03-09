# simple-mod-framework
A mod framework for HITMAN 3 that allows the automatic synthesis of mods from source files.

You can download an artifact (nightly) version of the framework from [here](https://nightly.link/atampy25/simple-mod-framework/workflows/artifact/main/Output.zip).

## Local development

This repository has three parts:

- root project (framework CLI, TypeScript)
- `Mod Manager/` Electron + Svelte GUI

### Prerequisites

- Windows (the project runtime and release output are Windows-first)
- Node.js 18

### Quick start

```bash
npm run setup:dev
npm run build:dev
npm run dev:gui
```

What this does:

- installs root and GUI package dependencies
- provisions required `Third-Party` binaries (including downloading `rpkg-cli.exe` if missing)
- compiles TypeScript to `compiled/`
- starts Mod Manager in dev mode

### Useful scripts

- `npm run setup:tools` verifies/provisions required third-party tools
- `npm run build:core` compiles framework TypeScript
- `npm run build:gui` builds the GUI
- `npm run watch:core` watches and rebuilds framework TypeScript
