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
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        # jujutsu: this repo is jj-managed (see .gitignore's snapshot.max-new-file-size note).
        # nodejs/bun: match what CI/electron-builder expect - see package.json's dependency versions.
        # wine is deliberately NOT included here: it's only needed for electron-builder's
        # rcedit/signtool pass on a non-Windows host, and pulling it into every `nix develop`
        # would be a heavy default for something scripts/build-win-wsl.sh already works around.
        # Add it ad hoc with `nix shell nixpkgs#wine64` if you want real (unsigned) rcedit
        # icon/version-info embedding instead of the --win.signAndEditExecutable=false skip.
        packages = with pkgs; [
          nodejs_24
          bun
          jujutsu
        ];

        LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath electronRuntimeLibs;

        shellHook = ''
          echo "smf dev shell: node $(node -v), bun $(bun -v), jj $(jj --version)"
        '';
      };
    };
}
