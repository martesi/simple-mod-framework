{
  # Usage: nix develop   (or: nix --extra-experimental-features "nix-command flakes" develop
  #        if flakes/nix-command aren't enabled in your nix.conf)
  #
  # Root CLI:           npm install && npm run build:linux   (or build:win on Windows)
  # Mod Manager:        cd "Mod Manager" && npm install && npm run build:linux
  # Mod Manager (Tauri): cd mod-manager-tauri && npm run tauri dev
  #                       cd mod-manager-tauri && npm run build:linux
  #                       cd mod-manager-tauri && ./scripts/windows-test-deploy.sh  (cross-compile + WSL interop)
  description = "Dev environment for simple-mod-framework (CLI + Mod Manager GUIs)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, fenix }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Rust toolchain that includes the Windows GNU cross-compilation std.
        # fenix provides pre-built Rust components for arbitrary host+target combos.
        rustToolchain = fenix.packages.${system}.combine [
          fenix.packages.${system}.stable.cargo
          fenix.packages.${system}.stable.rustc
          fenix.packages.${system}.stable.clippy
          fenix.packages.${system}.stable.rustfmt
          fenix.packages.${system}.targets.x86_64-pc-windows-gnu.stable.rust-std
        ];

        # Shared libraries the prebuilt Electron binary (downloaded by npm
        # into "Mod Manager/node_modules/electron") dynamically links against
        # on Linux. Without these on LD_LIBRARY_PATH the app fails to start
        # with missing .so errors.
        electronRuntimeLibs = with pkgs; [
          alsa-lib
          at-spi2-atk
          at-spi2-core
          atk
          cairo
          cups
          cups.lib
          dbus
          dbus.lib
          expat
          fontconfig
          freetype
          gdk-pixbuf
          glib
          gtk3
          libdrm
          libGL
          libgbm
          libglvnd
          libxkbcommon
          mesa
          nspr
          nss
          pango
          systemd # for libudev
          vulkan-loader
          xorg.libX11
          xorg.libXcomposite
          xorg.libXdamage
          xorg.libXext
          xorg.libXfixes
          xorg.libXrandr
          xorg.libXScrnSaver
          xorg.libXtst
          xorg.libxcb
          xorg.libxshmfence
        ];

        # Libraries required to build and run the Tauri-based mod manager.
        # webkit2gtk/libsoup provide the webview; the rest are GTK + icon rendering.
        tauriLibs = with pkgs; [
          webkitgtk_4_1
          libsoup_3
          librsvg
          libayatana-appindicator
          openssl
          glib-networking
          xdg-utils
        ];
        # winpthreads provides libpthread.a which Rust's x86_64-pc-windows-gnu
        # std links against.  Without it the MinGW linker fails with
        # "cannot find -l:libpthread.a".
        # Referenced in shellHook for path substitution only (not in packages —
        # it's a Windows cross-build artifact, not a native Linux binary).
        winpthreads = pkgs.pkgsCross.mingwW64.windows.pthreads;
      in
      {
        devShells.default = pkgs.mkShell {
          name = "smf-devshell";

          packages = with pkgs; [
            nodejs_22
            rustToolchain
            cargo-tauri
            pkg-config
            python3
            p7zip
            curl
            zip
            unzip
            just # `just dist` runs the build graph in ./justfile (needs >= 1.42 for [parallel])
            # MinGW-w64 cross-compiler — linker for x86_64-pc-windows-gnu target.
            pkgsCross.mingwW64.buildPackages.gcc
            # For launching/screenshotting the Electron GUI headlessly.
            xvfb-run
            xorg.xwd
            imagemagick
          ] ++ electronRuntimeLibs ++ tauriLibs;

          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (electronRuntimeLibs ++ tauriLibs);

          shellHook = ''
            export PATH="$PWD/node_modules/.bin:$PATH"
            # Tell cargo which linker to use when targeting Windows GNU.
            export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER="x86_64-w64-mingw32-gcc"
            # winpthreads lib dir — lets the MinGW linker find libpthread.a.
            export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS="-L ${winpthreads}/lib"
            # Tauri's AppImage bundler hardcodes /usr/bin/xdg-open. On WSL2/Nix it isn't
            # there by default; symlink it once with: sudo ln -sf $(which xdg-open) /usr/bin/xdg-open
            # deb/rpm bundles work without this; only AppImage needs it.
            echo "smf-devshell ready: node $(node --version), rustc $(rustc --version | cut -d' ' -f2)"
          '';
        };
      });
}
