{
  description = "Simple Mod Framework dev shell - WSL host, cross-compiling the Windows Electron build";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };

      # `npm run dev`/`npm run preview` launch the *actual* Electron binary that
      # node_modules/electron downloaded (a prebuilt glibc binary, dynamically linked
      # against the GTK/Chromium stack) - not something Nix built, so NixOS's lack of an
      # FHS /usr/lib means it can't find any of this at startup ("error while loading
      # shared libraries: libglib-2.0.so.0: cannot open shared object file"). Rather than
      # repackaging Electron through nixpkgs (version drift against package.json's pinned
      # ^43.1.1) or patchelf-ing the downloaded binary (breaks on every `npm install`),
      # just point LD_LIBRARY_PATH at the same shared libs nixpkgs' own Electron/Chromium
      # derivations require (see pkgs/development/tools/electron/generic.nix upstream).
      electronRuntimeLibs = with pkgs; [
        glib
        nss
        nspr
        atk
        at-spi2-atk
        at-spi2-core
        cups
        dbus
        expat
        gtk3
        pango
        cairo
        gdk-pixbuf
        libdrm
        mesa
        libgbm # libgbm.so.1 lives in this split-out mesa output, not `mesa` itself
        libxkbcommon
        systemd # libudev.so.1
        alsa-lib
        libx11
        libxcomposite
        libxdamage
        libxext
        libxfixes
        libxrandr
        libxcb
        libxshmfence
      ];

      commonPackages = with pkgs; [
        nodejs_24
        bun
        jujutsu
      ];

      commonEnv = {
        LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath electronRuntimeLibs;
      };

      commonHook = ''
        echo "smf dev shell: node $(node -v), bun $(bun -v), jj $(jj --version)"
      '';
    in
    {
      devShells.${system} = {
        default = pkgs.mkShell {
          # jujutsu: this repo is jj-managed (see .gitignore's snapshot.max-new-file-size note).
          # nodejs/bun: match what CI/electron-builder expect - see package.json's dependency versions.
          # wine is deliberately NOT included here: it's only needed for electron-builder's
          # rcedit/signtool pass on a non-Windows host, and pulling it into every `nix develop`
          # would be a heavy default for something scripts/build-win-wsl.sh already works around
          # (and for running the bundled Third-Party .exe tools under devShells.e2e below). Add it
          # ad hoc with `nix shell nixpkgs#wine64` if you want real (unsigned) rcedit icon/version-info
          # embedding instead of the --win.signAndEditExecutable=false skip.
          packages = commonPackages;
          inherit (commonEnv) LD_LIBRARY_PATH;
          shellHook = commonHook;
        };

        # Everything needed to run the app - and the Windows .exe tools it shells out to
        # (extra/Third-Party/) - headlessly on Linux, for e2e runs: a virtual X server to give
        # Electron/Chromium somewhere to render (it still opens a real window/GL context even when
        # driven over CDP, not just when clicked through with xdotool), and Wine so the bundled
        # win32 tools (7z.exe et al) can actually execute. `scripts/fetch-third-party.js` fetches
        # 7z.exe's own upstream archive with `7zz` (native Linux 7-Zip) on this platform rather than
        # needing Wine just to bootstrap that - see its ensureSevenZip() for why - and wraps the
        # extracted win32 binary in a `wine "$@"` shebang script of the same name so
        # src/main/archive.ts's `execFile(sevenZip, ...)` needs no platform branch at all: the OS
        # exec of that path just happens to run a script instead of a PE binary. This is kept out of
        # `devShells.default` since it's dead weight (GUI/X11/Wine closure) for everyday
        # typecheck/lint/dev work - see references/e2e-shell.md in the headless-gui skill.
        e2e = pkgs.mkShell {
          packages =
            commonPackages
            ++ (with pkgs; [
              wine64 # runs the bundled Third-Party .exe tools (7z.exe, quickentity-rs.exe, ...)
              _7zz # extracts 7-Zip's own upstream release archive to fetch 7z.exe in the first place
              xvfb
              xdpyinfo # readiness check - see references/driving.md
            ]);

          inherit (commonEnv) LD_LIBRARY_PATH;

          shellHook = ''
            ${commonHook}
            export DISPLAY="''${DISPLAY:-:99}"
            # libglvnd looks for vendor ICD json in /usr/share/glvnd/egl_vendor.d, which doesn't
            # exist in this sandbox - without an ICD there's no EGL vendor at all and Chromium's GPU
            # process (or a plain xdotool/import run) can misbehave. Point it at mesa's own ICD for
            # a software (llvmpipe) context. The `:-` guard leaves a real desktop's own EGL setup
            # (e.g. NixOS exporting /run/opengl-driver/...) untouched.
            export __EGL_VENDOR_LIBRARY_DIRS="''${__EGL_VENDOR_LIBRARY_DIRS:-${pkgs.mesa}/share/glvnd/egl_vendor.d}"
            # A slim container has no /etc/fonts - without this fontconfig finds nothing and every
            # screenshot comes out structurally correct but rendered as tofu.
            export FONTCONFIG_FILE="''${FONTCONFIG_FILE:-${pkgs.makeFontsConf {
              fontDirectories = with pkgs; [ dejavu_fonts liberation_ttf ];
            }}}"
            echo "smf e2e shell: wine $(wine --version), 7zz $(7zz | sed -n 2p)"
          '';
        };
      };
    };
}
