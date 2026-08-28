{
  pkgs,
  src,
  dependencySrc,
  version,
}:
let
  inherit (pkgs) lib stdenvNoCC;

  nodeModules = stdenvNoCC.mkDerivation {
    pname = "routstrd-node-modules";
    inherit version;
    src = dependencySrc;

    impureEnvVars = lib.fetchers.proxyImpureEnvVars ++ [
      "GIT_PROXY_COMMAND"
      "SOCKS_SERVER"
    ];
    nativeBuildInputs = [
      pkgs.bun
      pkgs.writableTmpDirAsHomeHook
    ];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export BUN_INSTALL_CACHE_DIR="$(mktemp -d)"
      bun install \
        --cpu="*" \
        --os="*" \
        --frozen-lockfile \
        --ignore-scripts \
        --no-progress \
        --production
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -R node_modules "$out/"
      runHook postInstall
    '';
    dontFixup = true;
    outputHash = "sha256-OzUuhIZdRrPJrfVv1Wy8Ye/eh4qmy9Adw1PqVYusSFk=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };

  routstrd = stdenvNoCC.mkDerivation {
    pname = "routstrd";
    inherit version src;
    nativeBuildInputs = [
      pkgs.bun
      pkgs.makeWrapper
    ];
    buildPhase = ''
      runHook preBuild
      ln -s ${nodeModules}/node_modules node_modules
      bun run build
      mv dist/daemon/index.js dist/daemon/runtime.js
      cp nix/daemon-entry.js dist/daemon/index.js
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      app="$out/share/routstrd"
      mkdir -p "$app" "$out/bin"
      cp package.json "$app/"
      cp -R dist "$app/"
      cp -R ${nodeModules}/node_modules "$app/"
      makeWrapper ${lib.getExe pkgs.bun} "$out/bin/routstrd" \
        --prefix PATH : ${
          lib.makeBinPath [
            pkgs.bun
            pkgs.pm2
          ]
        } \
        --add-flags "run" \
        --add-flags "$app/dist/index.js"
      ln -s ${lib.getExe pkgs.pm2} "$out/bin/routstrd-pm2"
      runHook postInstall
    '';
    meta = {
      description = "CLI and daemon for routing AI requests through Routstr providers";
      homepage = "https://github.com/Routstr/routstrd";
      license = lib.licenses.mit;
      mainProgram = "routstrd";
      platforms = lib.platforms.linux;
    };
  };
in
{
  default = routstrd;
  inherit routstrd;
}
