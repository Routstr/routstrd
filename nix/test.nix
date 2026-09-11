{ self }:
let
  inherit (self.inputs.nixpkgs) lib;
in
{
  name = "routstrd-module";

  nodes.machine = { pkgs, ... }: {
    imports = [ self.nixosModules.default ];
    services.routstrd = {
      enable = true;
      openFirewall = true;
      secretConfigFile = "/run/routstrd-secret.json";
      settings = {
        host = "0.0.0.0";
        port = 8008;
        maxTokens = 4096;
        wallet = {
          initializeDefaultMint = false;
          enableNpc = false;
        };
      };
    };
    systemd.services.routstrd-secret = {
      description = "Provision routstrd test credentials";
      before = [ "routstrd.service" ];
      requiredBy = [ "routstrd.service" ];
      serviceConfig.Type = "oneshot";
      script = ''
        install -m 0600 ${pkgs.writeText "routstrd-test-secret.json" ''{"nsec":"test-only"}''} /run/routstrd-secret.json
      '';
    };
    # Keep the integration test independent of DHCP and graphical device
    # initialization. The production module still waits for network-online.
    systemd.services.routstrd.after = lib.mkForce [ "systemd-tmpfiles-setup.service" ];
    virtualisation = {
      graphics = false;
      memorySize = 1024;
      cores = 1;
    };
  };

  testScript = ''
    from datetime import timedelta

    machine.start()
    machine.wait_for_unit("routstrd.service")
    machine.wait_for_open_port(8008, timeout=timedelta(seconds=300))
    machine.succeed("curl --fail --silent http://127.0.0.1:8008/health")

    machine.succeed("test $(stat -c %a /var/lib/routstrd) = 700")
    machine.succeed("test $(stat -c %a /var/lib/routstrd/wallet) = 700")
    machine.succeed("test $(stat -c %a /var/lib/routstrd/wallet/config.json) = 600")
    machine.succeed("test $(systemctl show routstrd.service -P User) = routstrd")
    machine.succeed("systemctl cat routstrd.service | grep 'LoadCredential=routstrd-secret-config.json:/run/routstrd-secret.json'")
    machine.succeed("test $(sudo -u routstrd routstrd wallet backup --wallet-dir /var/lib/routstrd/wallet | wc -w) = 12")

    before = machine.succeed("sha256sum /var/lib/routstrd/wallet/config.json | cut -d' ' -f1").strip()
    machine.succeed("systemctl restart routstrd.service")
    machine.wait_for_unit("routstrd.service")
    machine.wait_for_open_port(8008, timeout=timedelta(seconds=300))
    after = machine.succeed("sha256sum /var/lib/routstrd/wallet/config.json | cut -d' ' -f1").strip()
    assert before == after, "wallet changed across service restart"

    machine.succeed("systemctl stop routstrd.service")
    machine.succeed("printf 'invalid-json' > /var/lib/routstrd/config.json")
    machine.succeed("systemctl start routstrd.service")
    machine.succeed("test $(systemctl show routstrd.service -P ActiveState) = inactive")
    machine.succeed("test $(cat /var/lib/routstrd/config.json) = invalid-json")
  '';
}
