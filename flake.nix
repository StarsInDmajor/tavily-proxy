{
  description = "Self-hosted Tavily MCP proxy with local API key pool";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    inputs@{ self, flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" ];

      perSystem =
        { pkgs, ... }:
        {
          packages.default = self.packages.${pkgs.system}.tavily-proxy;

          packages.tavily-proxy = pkgs.callPackage ./nix/package.nix { };

          apps.default = {
            type = "app";
            program = "${self.packages.${pkgs.system}.tavily-proxy}/bin/tavily-proxy";
          };

          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_20
              nodePackages.npm
              nixfmt-rfc-style
            ];

            shellHook = ''
              echo "tavily-proxy dev shell"
              echo "  npm test    — run tests"
              echo "  npm run dev — start dev server"
            '';
          };
        };

      flake = {
        homeManagerModules.default = import ./module.nix;

        overlays.default = final: _prev: {
          tavily-proxy = final.callPackage ./nix/package.nix { };
        };
      };
    };
}
