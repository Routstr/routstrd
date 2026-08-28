self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.routstrd;
  jsonFormat = pkgs.formats.json { };
  managedConfig = jsonFormat.generate "routstrd-config.json" cfg.settings;
  defaultDataDir = "/var/lib/routstrd";
in
{
  options.services.routstrd = {
    enable = lib.mkEnableOption "routstrd Routstr routing daemon";
    package = lib.mkPackageOption self.packages.${pkgs.stdenv.hostPlatform.system} "routstrd" { };

    user = lib.mkOption {
      type = lib.types.str;
      default = "routstrd";
      description = "User account under which routstrd runs.";
    };
    group = lib.mkOption {
      type = lib.types.str;
      default = "routstrd";
      description = "Group under which routstrd runs.";
    };
    createUser = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to create the configured system user and group.";
    };
    dataDir = lib.mkOption {
      type = lib.types.str;
      default = defaultDataDir;
      description = "Writable directory containing routstrd configuration, databases, and logs.";
    };
    walletDir = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.dataDir}/wallet";
      defaultText = lib.literalExpression ''"''${config.services.routstrd.dataDir}/wallet"'';
      description = "Writable directory containing the Cashu wallet and its recovery mnemonic.";
    };

    settings = lib.mkOption {
      default = { };
      description = ''
        Declarative routstrd configuration. These values override mutable
        runtime configuration after every restart. Do not put secrets here,
        because this value is rendered into the world-readable Nix store.
      '';
      type = lib.types.submodule {
        freeformType = jsonFormat.type;
        options = {
          port = lib.mkOption {
            type = lib.types.port;
            default = 8008;
            description = "TCP port on which routstrd listens.";
          };
          host = lib.mkOption {
            type = lib.types.str;
            default = "127.0.0.1";
            description = "Address on which routstrd listens.";
          };
          provider = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Optional default Routstr provider URL.";
          };
          mode = lib.mkOption {
            type = lib.types.enum [
              "apikeys"
              "xcashu"
            ];
            default = "apikeys";
            description = "Routstr client payment mode.";
          };
          maxTokens = lib.mkOption {
            type = lib.types.ints.unsigned;
            default = 64000;
            description = "Default output-token limit; zero disables injection.";
          };
          wallet = lib.mkOption {
            default = { };
            description = "Cashu wallet startup integrations.";
            type = lib.types.submodule {
              options = {
                initializeDefaultMint = lib.mkOption {
                  type = lib.types.bool;
                  default = true;
                  description = "Whether a fresh wallet adds the built-in default mint during startup.";
                };
                enableNpc = lib.mkOption {
                  type = lib.types.bool;
                  default = true;
                  description = "Whether to register the npubx.cash NPC plugin.";
                };
              };
            };
          };
        };
      };
    };

    secretConfigFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        External JSON configuration file loaded with highest precedence.
        Use this for nsec and nwc.connectionString so secrets do not enter the Nix store.
      '';
    };
    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Additional environment variables passed to routstrd.";
    };
    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional systemd EnvironmentFile containing additional variables or secret paths.";
    };
    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the configured routstrd TCP port in the firewall.";
    };
    extraArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Additional arguments appended to the foreground daemon command.";
    };
    extraServiceConfig = lib.mkOption {
      type = lib.types.attrs;
      default = { };
      description = "Additional or overriding systemd serviceConfig values.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.hasPrefix "/" cfg.dataDir;
        message = "services.routstrd.dataDir must be an absolute path";
      }
      {
        assertion = lib.hasPrefix "/" cfg.walletDir;
        message = "services.routstrd.walletDir must be an absolute path";
      }
    ];
    warnings = lib.optional (
      cfg.openFirewall
      && lib.elem cfg.settings.host [
        "127.0.0.1"
        "::1"
      ]
    ) "services.routstrd.openFirewall is enabled, but routstrd only binds to loopback";

    networking.firewall.allowedTCPPorts = lib.optional cfg.openFirewall cfg.settings.port;
    environment.systemPackages = [ cfg.package ];

    users.groups = lib.mkIf cfg.createUser { ${cfg.group} = { }; };
    users.users = lib.mkIf cfg.createUser {
      ${cfg.user} = {
        isSystemUser = true;
        group = cfg.group;
        home = cfg.dataDir;
        createHome = false;
      };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0700 ${cfg.user} ${cfg.group} -"
      "d ${cfg.walletDir} 0700 ${cfg.user} ${cfg.group} -"
    ];

    systemd.services.routstrd = {
      description = "Routstr routing daemon";
      documentation = [ "https://github.com/Routstr/routstrd" ];
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [
        "network-online.target"
        "systemd-tmpfiles-setup.service"
      ];
      environment = {
        HOME = cfg.dataDir;
        ROUTSTRD_DIR = cfg.dataDir;
        ROUTSTRD_WALLET_DIR = cfg.walletDir;
        ROUTSTRD_CONFIG_FILE = managedConfig;
      }
      // lib.optionalAttrs (cfg.secretConfigFile != null) {
        ROUTSTRD_SECRET_CONFIG_FILE = toString cfg.secretConfigFile;
      }
      // cfg.environment;
      serviceConfig = {
        ExecStart = lib.escapeShellArgs (
          [
            (lib.getExe cfg.package)
            "daemon"
          ]
          ++ cfg.extraArgs
        );
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = cfg.dataDir;
        Restart = "on-failure";
        RestartSec = 5;
        UMask = "0077";
        ReadWritePaths = lib.unique [
          cfg.dataDir
          cfg.walletDir
        ];
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectSystem = "strict";
        RestrictSUIDSGID = true;
      }
      // lib.optionalAttrs (cfg.dataDir == defaultDataDir) {
        StateDirectory = "routstrd";
        StateDirectoryMode = "0700";
      }
      // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = toString cfg.environmentFile;
      }
      // cfg.extraServiceConfig;
    };
  };
}
