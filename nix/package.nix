{
  pkgs,
  lib,
}:

let
  serviceSrc = pkgs.buildNpmPackage {
    pname = "tavily-proxy-service";
    version = "1.0.0";

    src = ../service;

    npmDepsHash = "sha256-31IAwA3Y2/Ajc+pYzbkWvzoahV7r8HhzANNGjCDomVU=";

    buildPhase = ''
      runHook preBuild
      npm run build
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -r dist $out/
      cp -r node_modules $out/
      runHook postInstall
    '';

    doCheck = false;
  };

  # Wrapper script that sets NODE_PATH and execs the compiled service
  tavilyProxy = pkgs.writeShellScriptBin "tavily-proxy" ''
    exec ${pkgs.nodejs_20}/bin/node "${serviceSrc}/dist/src/index.js" "$@"
  '';
in
tavilyProxy // {
  meta = {
    description = "Self-hosted Tavily MCP proxy with local API key pool";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
    mainProgram = "tavily-proxy";
  };

  # Expose the service derivation for the HM module to set NODE_PATH
  passthru = {
    inherit serviceSrc;
  };
}
