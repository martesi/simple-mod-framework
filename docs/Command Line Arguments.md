`Deploy.exe` accepts the following command line arguments:
```powershell
.\Deploy --useConsoleLogging # Whether to use Node.js console logging instead of the default fancy logging
.\Deploy --pauseAfterLogging # Whether to pause execution after each log entry
.\Deploy --doNotPause # Whether to never pause after errors
.\Deploy --logLevel verbose --logLevel debug --logLevel info --logLevel warn --logLevel error # The log levels to enable
.\Deploy --analyseMod SomeMod.Id # Analyse a single mod and (re)populate its analysis cache, instead of running a full deploy
```

These arguments can be mixed together, but note that console logging does not respect set log levels, and will always log the default levels (`debug` onwards).

## `--analyseMod`

`--analyseMod <id>` analyses a single mod (disk walk, manifest/option resolution, its `analysis` script if it has one) and writes the result to that mod's analysis cache entry (`cache/analysis/<id>.json`), without running a full deploy - no discovery, no diffing, no touching other mods, no packing RPKGs.

A subsequent full deploy loads each mod's cached analysis instead of redoing this work, as long as the mod's files and its currently-selected options haven't changed since the cache entry was written. This is meant to be triggered by the mod manager whenever a mod is added or updated, or when its selected options change - both cheap, infrequent events - so that deploys stay fast even with many installed mods. If a mod has no cache entry yet (or its options have changed since), deploy falls back to analysing it inline, exactly as before; `--analyseMod` is a pure optimisation; not required for `Deploy.exe` to work.

`<id>` accepts either the mod's ID (from its manifest.json) or its exact folder name under `Mods/`.