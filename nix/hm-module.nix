packages:
{ config, lib, ... }:
let
  cfg = config.services.meridian;
in
{
  options.services.meridian = {
    enable = lib.mkEnableOption "the Meridian proxy service";

    package = lib.mkPackageOption packages "meridian" {
      pkgsText = "inputs.meridian.packages.\${pkgs.stdenv.hostPlatform.system}";
    };

    settings = {
      port = lib.mkOption {
        type = lib.types.port;
        default = 3456;
        description = "Port to listen on.";
      };

      host = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1";
        description = "Host to bind to.";
      };

      idleTimeoutSeconds = lib.mkOption {
        type = lib.types.int;
        default = 120;
        description = "HTTP keep-alive idle timeout in seconds.";
      };

      passthrough = lib.mkOption {
        type = lib.types.nullOr lib.types.bool;
        default = null;
        description = "Forward tool calls to client instead of executing. Null lets Meridian auto-detect.";
      };

      defaultAgent = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Default adapter for unrecognized agents (opencode, forgecode, pi, crush, droid, passthrough).";
      };

      sonnetModel = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Sonnet context tier: 'sonnet' (200k) or 'sonnet[1m]' (1M, requires Extra Usage).";
      };

      telemetry = {
        persist = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Enable SQLite telemetry persistence.";
        };

        retentionDays = lib.mkOption {
          type = lib.types.nullOr lib.types.int;
          default = null;
          description = "Days to retain telemetry data before cleanup.";
        };
      };
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Extra environment variables passed to the Meridian service.";
    };

    opencode.pluginPath = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.package}/lib/meridian/plugin/meridian.ts";
      readOnly = true;
      description = "Nix store path to the OpenCode plugin file. Use this to reference the plugin in your OpenCode config.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.user.services.meridian = {
      Unit.Description = "Meridian - Local Anthropic API proxy";

      Service = {
        Type = "exec";
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        RestartSec = 5;

        Environment =
          lib.pipe
            {
              MERIDIAN_DEFAULT_AGENT = cfg.settings.defaultAgent;
              MERIDIAN_HOST = cfg.settings.host;
              MERIDIAN_IDLE_TIMEOUT_SECONDS = cfg.settings.idleTimeoutSeconds;
              MERIDIAN_PASSTHROUGH = cfg.settings.passthrough;
              MERIDIAN_PORT = cfg.settings.port;
              MERIDIAN_SONNET_MODEL = cfg.settings.sonnetModel;
              MERIDIAN_TELEMETRY_PERSIST = cfg.settings.telemetry.persist;
              MERIDIAN_TELEMETRY_RETENTION_DAYS = cfg.settings.telemetry.retentionDays;
            }
            [
              (lib.filterAttrs (_: v: v != null))
              (lib.flip lib.mergeAttrs cfg.environment)
              (lib.mapAttrsToList (lib.generators.mkKeyValueDefault { } "="))
            ];
      };

      Install.WantedBy = [ "default.target" ];
    };
  };
}
