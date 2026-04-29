# Tavily Proxy - Home Manager Module
# Self-hosted Tavily MCP proxy with API key pool
#
# Usage in host config:
#   services.tavily-proxy = {
#     enable = true;
#     port = 9100;
#     keyStorePath = "/path/to/decrypted/keys.json";
#   };
#
# To decrypt keys via agenix, add in the same host config:
#   age.secrets.tavily-keys = {
#     file = ./secrets/keys/tavily-keys.json.age;
#     path = "${config.home.homeDirectory}/.config/secrets/tavily-keys.json";
#     mode = "600";
#   };
{
  config,
  lib,
  pkgs,
  self ? null,
  ...
}:

let
  cfg = config.services.tavily-proxy;

  # Build the Node.js service from this flake's source
  # When self is null (module used outside flake), fall back to local path
  serviceSrc =
    if self != null then
      pkgs.callPackage (self + "/nix/package.nix") { }
    else
      pkgs.callPackage ./nix/package.nix { };

  # Actual store path (use config value or default to home directory)
  actualStorePath =
    if cfg.storePath != null then
      cfg.storePath
    else
      "${config.home.homeDirectory}/.local/state/tavily/key-store.json";

  # Node.js wrapper script
  # When authKey is null, TAVILY_AUTH_KEY is omitted and the service reads
  # authKey from the key store JSON (keyStorePath field "authKey").
  tavilyProxy = pkgs.writeShellScriptBin "tavily-proxy" (
    ''
      set -e
      export NODE_PATH="${serviceSrc.passthru.serviceSrc}/node_modules"
      export TAVILY_PORT="${toString cfg.port}"
      export TAVILY_STORE_PATH="${actualStorePath}"
    ''
    + lib.optionalString (cfg.authKey != null) ''
      export TAVILY_AUTH_KEY="${cfg.authKey}"
    ''
    + ''
      exec ${pkgs.nodejs_20}/bin/node "${serviceSrc.passthru.serviceSrc}/dist/src/index.js" "$@"
    ''
  );

  # CLI wrapper for key management
  tavilyCli = pkgs.writeShellScriptBin "tavily-cli" ''
    set -e

    base_url="http://127.0.0.1:${toString cfg.port}"
    key_store_path="${lib.escapeShellArg (cfg.keyStorePath or "")}"

    # Read authKey from the decrypted key store JSON (preferred) or env var
    auth_key=""
    if [ -n "$key_store_path" ] && [ -f "$key_store_path" ]; then
      auth_key="$(${pkgs.jq}/bin/jq -r '.authKey // empty' "$key_store_path")"
    fi
    auth_key="''${auth_key:-''${TAVILY_AUTH_KEY:-}}"
    if [ -z "$auth_key" ]; then
      echo "Error: authKey not found in key store and TAVILY_AUTH_KEY is not set" >&2
      exit 1
    fi

    show_help() {
      cat <<EOF
    Tavily Proxy CLI

    Usage: tavily-cli <command>

    Commands:
      status          Show service status and API keys
      add <key>       Add a Tavily API key to the pool
      remove <key>    Remove a key from the pool
      list            List all keys with remaining credits
      health          Check service health

    Examples:
      tavily-cli status
      tavily-cli add tvly-xxxxxxxxxxxx
      tavily-cli remove tvly-xxxxxxxxxxxx
      tavily-cli list
      tavily-cli health
    EOF
    }

    cmd="''${1:-help}"

    case "$cmd" in
      status)
        echo "=== Tavily Proxy Status ==="
        curl -s "$base_url/" | ${pkgs.jq}/bin/jq .
        echo ""
        echo "=== API Keys ==="
        curl -s -H "x-api-key: $auth_key" "$base_url/api/keys" | ${pkgs.jq}/bin/jq .
        ;;
      add)
        if [ -z "''${2:-}" ]; then
          echo "Error: Missing API key argument"
          echo "Usage: tavily-cli add <api-key>"
          exit 1
        fi
        echo "Adding API key: ''${2:0:13}..."
        curl -s -X POST \
          -H "Content-Type: application/json" \
          -H "x-api-key: $auth_key" \
          -d "{\"apiKey\": \"''${2}\"}" \
          "$base_url/api/keys" | ${pkgs.jq}/bin/jq .
        echo ""
        ;;
      remove)
        if [ -z "''${2:-}" ]; then
          echo "Error: Missing API key argument"
          echo "Usage: tavily-cli remove <api-key>"
          exit 1
        fi
        echo "Removing API key: ''${2:0:13}..."
        curl -s -X DELETE \
          -H "Content-Type: application/json" \
          -H "x-api-key: $auth_key" \
          -d "{\"apiKey\": \"''${2}\"}" \
          "$base_url/api/keys" | ${pkgs.jq}/bin/jq .
        echo ""
        ;;
      list)
        echo "=== API Keys ==="
        curl -s -H "x-api-key: $auth_key" "$base_url/api/keys" | ${pkgs.jq}/bin/jq '.keys[] | {apiKey: (.apiKey[0:13] + "..."), remainingCredit}'
        ;;
      health)
        echo "Checking Tavily Proxy health..."
        curl -s -o /dev/null -w "Status: %{http_code}\n" "$base_url/"
        ;;
      help|--help|-h)
        show_help
        ;;
      *)
        echo "Unknown command: $cmd"
        show_help
        exit 1
        ;;
    esac
  '';
in
{
  options.services.tavily-proxy = {
    enable = lib.mkEnableOption "Tavily MCP proxy with API key pool";

    port = lib.mkOption {
      type = lib.types.port;
      default = 9100;
      description = "Port for the Tavily proxy server.";
    };

    authKey = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Authentication key for API access (x-api-key header).
        If null, the service reads authKey from the key store JSON at runtime.
      '';
    };

    storePath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Path to the runtime key pool JSON file. Defaults to ~/.local/state/tavily/key-store.json";
    };

    keyStorePath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Path to a JSON file containing authKey and initial API keys.
        The file should have the format:
        { "authKey": "...", "keys": [{ "key": "tvly-...", "credit": 1000 }] }
        Typically this is a decrypted agenix secret.
      '';
    };

    externalPath = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = ''
        URL path prefix added to the SSE message endpoint sent to clients.
        Set to the nginx location prefix (e.g. "/tavily") when the service is
        behind a reverse proxy that strips the prefix before forwarding.
        Empty string means the service is accessed directly (no prefix).
      '';
    };

    autoStart = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Automatically start the Tavily proxy service.";
    };

    afterServices = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Additional systemd services to wait for before starting.
        Use this to depend on agenix.service or other secret providers.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home = {
      packages = [
        tavilyProxy
        tavilyCli
        pkgs.jq
      ];
      file = {
        ".local/state/tavily/.keep".text = "";
        ".config/tavily-proxy/.keep".text = "";
      };
    };

    systemd.user.services.tavily-proxy = lib.mkIf cfg.autoStart {
      Unit = {
        Description = "Tavily MCP proxy with API key pool";
        After = [ "network.target" ] ++ cfg.afterServices;
        Wants = cfg.afterServices;
      };

      Service = {
        Type = "simple";
        ExecStart = "${tavilyProxy}/bin/tavily-proxy";
        Restart = "on-failure";
        RestartSec = "5s";

        Environment =
          [
            "TAVILY_PORT=${toString cfg.port}"
            "TAVILY_STORE_PATH=${actualStorePath}"
            "NODE_OPTIONS=--max-old-space-size=64"
          ]
          ++ lib.optional (cfg.authKey != null) "TAVILY_AUTH_KEY=${cfg.authKey}"
          ++ lib.optional (cfg.keyStorePath != null) "TAVILY_KEY_STORE_PATH=${cfg.keyStorePath}"
          ++ lib.optional (cfg.externalPath != "") "TAVILY_EXTERNAL_PATH=${cfg.externalPath}";

        # Security hardening
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = "read-only";
        ReadWritePaths = [
          "%h/.local/state/tavily"
          "%h/.config/tavily-proxy"
        ];

        # Resource limits
        LimitNPROC = 100;
        LimitNOFILE = 1024;

        # Memory protection (peak observed ~112 MB)
        MemoryMax = "192M";
      };

      Install = {
        WantedBy = [ "default.target" ];
      };
    };
  };
}
