# Local game-detection behavior

This tree keeps storefront detection explicit when the bundled game-build hash table does not
recognise an installed build.

`src/main/gameDetect.ts` hashes `HITMAN3.exe` for Steam/Epic installs and `MicrosoftGame.Config`
for Microsoft Store/Xbox installs. Recognised hashes still select their storefront automatically.
For an unknown hash, the manager leaves the storefront unset, asks the user to choose Steam, Epic,
or Microsoft in Settings/the setup wizard, and blocks deployment until that choice is saved.

The selection is stored with the normalized game-path detection in `cache.db`, so deploy and eager
mod analysis use the same choice. Cache version 2 invalidates older entries that may have persisted
the previous temporary Steam guess.

The game-root picker accepts either the folder containing `Retail` and `Runtime`, or the `Retail`
folder itself. Microsoft Store roots are normalized before checking `Runtime/chunk0.rpkg` and
`MicrosoftGame.Config`.
