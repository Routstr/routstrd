{ config, ... }:
{
  networking.hostName = "routstrd-vm";
  services.routstrd = {
    enable = true;
    openFirewall = true;
    settings.host = "0.0.0.0";
  };

  virtualisation = {
    graphics = true;
    memorySize = 2048;
    cores = 2;
    diskImage = null;
    forwardPorts = [
      {
        from = "host";
        proto = "tcp";
        host.address = "127.0.0.1";
        host.port = config.services.routstrd.settings.port;
        guest.port = config.services.routstrd.settings.port;
      }
    ];
  };

  services.getty.autologinUser = "root";
  system.stateVersion = "26.05";
}
