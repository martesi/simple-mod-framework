# Local patch notice

This tree carries a small local patch to the framework's game-detection logic.

## Unknown game version → Steam fallback

**File:** `src/main/gameDetect.ts` (`deriveGamePathInfo()`)

The framework identifies the game build by hashing `HITMAN3.exe` (Steam/Epic) or
`MicrosoftGame.Config` (Game Pass) and looking the hash up in a fixed table (`GAME_HASHES`). When
the game updates, its hash is no longer in that table, so platform detection would otherwise fail
and the deploy would abort with "Unknown game version. If the game has recently updated, wait for
a framework update to be released…".

`deriveGamePathInfo()` makes an unrecognised hash **fall back to `"steam"`** instead of failing,
and returns `unrecognisedBuild: true` so callers can surface a warning:

```ts
const platform = recognisedPlatform ?? "steam"
```

### Caveats

- The fallback assumes **Steam**. A Game Pass / Microsoft-store install with an unrecognised hash
  will be mis-detected as Steam. Recognised hashes (Steam, Epic, Microsoft) are unaffected - they
  still resolve correctly.
- This is a stopgap for testing on updated builds, not a substitute for a proper framework update
  that adds the new game hash to `GAME_HASHES`.

### Rebuilding

Unlike when this patch lived in the old standalone CLI (`src/main.ts`, since removed - the
framework core is now embedded directly in this Electron app, no separate `Deploy.exe` to rebuild),
this fallback is permanent application code, not a patch applied on top of a build step. Picking up
a change to `GAME_HASHES` just means re-running the app (`npm run dev`) or re-packaging it
(`npm run build:win`) like any other code change - no separate rebuild/patch-reapply step.
