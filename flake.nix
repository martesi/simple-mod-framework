{
  # Usage: nix develop   (or: nix --extra-experimental-features "nix-command flakes" develop
  #        if flakes/nix-command aren't enabled in your nix.conf)
  #
  # Root CLI:           npm install && npm run build:linux   (or build:win on Windows)
  # Mod Manager:        cd "Mod Manager" && npm install && npm run build:linux
  # Mod Manager (Tauri): cd mod-manager-tauri && npm run tauri dev
  description = "Dev environment for simple-mod-framework (CLI + Mod Manager GUIs)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

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
        ];
      in
      {
        devShells.default = pkgs.mkShell {
          name = "smf-devshell";

          packages = with pkgs; [
            nodejs_22
            rustc
            cargo
            rustfmt
            clippy
            pkg-config
            python3
            p7zip
            curl
            zip
            unzip
            # For launching/screenshotting the Electron GUI headlessly.
            xvfb-run
            xorg.xwd
            imagemagick
          ] ++ electronRuntimeLibs ++ tauriLibs;

          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (electronRuntimeLibs ++ tauriLibs);

          shellHook = ''
            export PATH="$PWD/node_modules/.bin:$PATH"
            echo "smf-devshell ready: node $(node --version), rustc $(rustc --version | cut -d' ' -f2)"
          '';
        };
      });
}
