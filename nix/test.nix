{ self }:
let
  inherit (self.inputs.nixpkgs) lib;
in
{
  name = "routstrd-module";

  nodes.machine = {
    imports = [ self.nixosModules.default ];
    services.routstrd = {
      enable = true;
      openFirewall = true;
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
    machine.start()
    machine.wait_for_unit("routstrd.service")
    machine.wait_for_open_port(8008, timeout=300)
    machine.succeed("curl --fail --silent http://127.0.0.1:8008/health")

    machine.succeed("test $(stat -c %a /var/lib/routstrd) = 700")
    machine.succeed("test $(stat -c %a /var/lib/routstrd/wallet) = 700")
    machine.succeed("test $(stat -c %a /var/lib/routstrd/wallet/config.json) = 600")
    machine.succeed("test $(systemctl show routstrd.service -P User) = routstrd")
    machine.succeed("test $(sudo -u routstrd routstrd wallet backup --wallet-dir /var/lib/routstrd/wallet | wc -w) = 12")

    before = machine.succeed("sha256sum /var/lib/routstrd/wallet/config.json | cut -d' ' -f1").strip()
    machine.succeed("systemctl restart routstrd.service")
    machine.wait_for_unit("routstrd.service")
    machine.wait_for_open_port(8008, timeout=300)
    after = machine.succeed("sha256sum /var/lib/routstrd/wallet/config.json | cut -d' ' -f1").strip()
    assert before == after, "wallet changed across service restart"
  '';
}
