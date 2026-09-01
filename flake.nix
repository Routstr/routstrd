{
  description = "routstrd - Routstr routing daemon and CLI";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      pkgsFor = lib.genAttrs systems (system: nixpkgs.legacyPackages.${system});
      forAllSystems = f: lib.genAttrs systems (system: f system pkgsFor.${system});
      src = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./src
          ./tests
          ./nix/daemon-entry.js
          ./package.json
          ./bun.lock
          ./tsconfig.json
        ];
      };
      dependencySrc = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./package.json
          ./bun.lock
        ];
      };
    in
    {
      nixosModules = {
        routstrd = import ./nix/module.nix self;
        default = self.nixosModules.routstrd;
      };

      packages = forAllSystems (
        system: pkgs:
        (import ./nix/package.nix {
          inherit pkgs src dependencySrc;
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
        })
        // lib.optionalAttrs (system == "x86_64-linux") {
          nixos-test = pkgs.testers.runNixOSTest (import ./nix/test.nix { inherit self; });
          vm =
            (nixpkgs.lib.nixosSystem {
              inherit system;
              modules = [
                "${nixpkgs}/nixos/modules/virtualisation/qemu-vm.nix"
                self.nixosModules.default
                ./nix/example-vm.nix
              ];
            }).config.system.build.vm;
        }
      );

      apps = forAllSystems (
        system: _pkgs: {
          default = {
            type = "app";
            program = lib.getExe self.packages.${system}.default;
            meta.description = "Run the routstrd CLI";
          };
        }
      );

      devShells = forAllSystems (
        _system: pkgs: {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.nixfmt
            ];
          };
        }
      );

      formatter = forAllSystems (_system: pkgs: pkgs.nixfmt);

      checks = forAllSystems (
        system: pkgs: {
          package = self.packages.${system}.default;
          profile = import ./nix/profile-test.nix {
            inherit pkgs;
            package = self.packages.${system}.default;
          };
        }
      );
    };
}
