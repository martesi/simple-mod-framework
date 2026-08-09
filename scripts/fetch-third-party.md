# Third-party setup

[`fetch-third-party.ts`](./fetch-third-party.ts) downloads the release-backed tools that a fresh
clone needs in `extra/Third-Party/`. The directory also contains tools committed to the repository;
the downloaded filenames are ignored individually, so deleting them and re-running the setup is
safe.

The current release sources are:

- `quickentity-3.exe` from the 3.0 release of [quickentity-rs](https://github.com/atampy25/quickentity-rs).
- `quickentity-rs.exe` from the latest [quickentity-rs](https://github.com/atampy25/quickentity-rs)
  release.
- `rpkg-cli.exe`, `quickentity_ffi.dll`, `assimp.dll`, and `hash_list.hmla` extracted from the
  [RPKG-Tool v2.34.0 CLI release](https://github.com/glacier-modding/RPKG-Tool/releases/tag/v2.34.0).
- `ResourceTool.exe`, `ResourceLib_HM2.dll`, `ResourceLib_HM2016.dll`, and `ResourceLib_HM3.dll`
  extracted from the [ZHMTools v4.1.0 Windows release](https://github.com/OrfeasZ/ZHMTools/releases/tag/v4.1.0).
- `xdelta3.exe` extracted from the [xdelta v3.2.0 Windows x64 release](https://github.com/jmacd/xdelta/releases/tag/v3.2.0).
- `HMLanguageTools.exe` and `HMTextureTools.exe` extracted from the latest
  [TonyTools.zip](https://github.com/AnthonyFuller/TonyTools/releases/latest). TonyTools does not
  bundle its license, so `TonyTools-LICENSE` remains committed separately.
- `7z.exe`, copied from `7za.exe` in the latest [7-Zip `*-extra.7z` release](https://github.com/ip7z/7zip/releases/latest).

## 7-Zip bootstrap

The 7-Zip release asset has a versioned name such as `7z2602-extra.7z`, so the script queries the
[GitHub releases API](https://api.github.com/repos/ip7z/7zip/releases/latest) and selects the asset
matching `7z\d+-extra.7z`. On Windows, the script downloads 7-Zip's dependency-free `7zr.exe`
bootstrap extractor at the same time as the metadata and archive. On other platforms it requires a
native `7zz`, `7z`, or `7za` on `PATH`; `nix develop .#e2e` provides `7zz`.

The Extra package contains both a top-level 32-bit `7za.exe` and an `x64/7za.exe`. Windows uses the
first matching executable, while non-Windows setup selects `x64/7za.exe` because a 64-bit-only Wine
installation cannot run the 32-bit build. The selected binary is always stored as `7z.exe`; the
application's Wine execution layer decides how to invoke it later.

## Behavior and recovery

- Independent release downloads run concurrently.
- Existing complete file groups are skipped. Archive downloads are written to unique temporary
  files, extracted into unique temporary directories, validated by filename, and copied into place
  only after all required files have been found.
- A network or archive-layout failure is reported as a warning so postinstall remains usable. The
  missing files can be placed in `extra/Third-Party/` by hand and the setup can be retried.
- `SMF_DEBUG=1 bun scripts/fetch-third-party.ts` logs request status, GitHub API rate-limit headers,
  response snippets, selected assets, and extraction details.

The provisioning table in the [README](../README.md#third-party-tools-and-provenance) records the
broader provenance audit and the committed tools that are not fetched here.
