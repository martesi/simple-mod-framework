# Local patch notice

This tree carries a small local patch to the framework's deploy pipeline.

## Unknown game version → Steam fallback

**File:** `src/main.ts` (platform detection, just above `doTheThing()`)

The framework identifies the game build by hashing `HITMAN3.exe` (Steam/Epic) or
`MicrosoftGame.Config` (Game Pass) and looking the hash up in a fixed table. When
the game updates, its hash is no longer in that table, so `core.config.platform`
becomes `undefined` and the deploy aborts with:

> Unknown game version. If the game has recently updated, wait for a framework
> update to be released…

That check made the end-to-end deploy test (`mod-manager-tauri/e2e/`) unrunnable
against a freshly-updated Steam install. The patch makes an unrecognised hash
**fall back to `Platform.steam`** instead of aborting, and logs a `WARN` so the
fallback is visible in `Deploy.log`:

```ts
core.config.platform = detectedPlatform ?? Platform.steam
```

### Caveats

- The fallback assumes **Steam**. A Game Pass / Microsoft-store install with an
  unrecognised hash will be mis-detected as Steam. Recognised hashes (Steam,
  Epic, Microsoft) are unaffected — they still resolve correctly.
- This is a stopgap for testing on updated builds, not a substitute for a proper
  framework update that adds the new game hash to the table in `src/main.ts`.

### Rebuilding

The deploy binary must be rebuilt for the patch to take effect:

```sh
npm run build:linux   # produces a Linux Deploy.exe (used by the e2e tests)
# or: npm run build:win   # produces a Windows Deploy.exe
```

Point the e2e integration config at the rebuilt binary via `deployExe` in
`mod-manager-tauri/e2e/integration.json`.
