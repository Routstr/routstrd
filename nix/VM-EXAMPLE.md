# routstrd NixOS VM example

Build and run the disposable demonstration VM:

```sh
nix build path:.#vm
result/bin/run-routstrd-vm-vm
```

The VM forwards guest port 8008 to `127.0.0.1:8008` on the host. Test it with:

```sh
curl --fail http://127.0.0.1:8008/health
```

The VM creates a new wallet on first boot and uses a temporary disk. To inspect
the recovery mnemonic from the VM console, run:

```sh
sudo -u routstrd routstrd wallet backup --wallet-dir /var/lib/routstrd/wallet
```

For a real deployment, import `nixosModules.default`, enable
`services.routstrd`, and use persistent storage. Never put an NWC connection
string or nsec directly in `services.routstrd.settings`; use
`services.routstrd.secretConfigFile` instead.
