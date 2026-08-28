{
  description = "routstrd - Routstr routing daemon and CLI";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems =
        f: nixpkgs.lib.genAttrs systems (system: f system (import nixpkgs { inherit system; }));
      sourceExclusions = [
        ".git"
        ".github"
        ".planning"
        ".vscode"
        "dist"
        "graphify-out"
        "node_modules"
        "result"
      ];
      src = nixpkgs.lib.cleanSourceWith {
        src = ./.;
        filter = path: _type: !(nixpkgs.lib.elem (baseNameOf path) sourceExclusions);
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
          inherit pkgs src;
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
        })
        // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
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
            program = nixpkgs.lib.getExe self.packages.${system}.default;
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
