import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ensureValidSignature,
  expectedChecksum,
  getLatestStandaloneRelease,
  installStandaloneRelease,
  isMachO,
  releaseArchiveName,
  sha256,
} from "../../src/utils/standalone-update";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("releaseArchiveName", () => {
  test("maps supported platforms and architectures", () => {
    expect(releaseArchiveName("0.5.0", "linux", "x64")).toBe(
      "routstrd-v0.5.0-linux-x64.tar.gz",
    );
    expect(releaseArchiveName("v0.5.0", "darwin", "arm64")).toBe(
      "routstrd-v0.5.0-darwin-arm64.tar.gz",
    );
  });

  test("rejects unsupported targets", () => {
    expect(() => releaseArchiveName("0.5.0", "win32", "x64")).toThrow(
      "not supported",
    );
    expect(() => releaseArchiveName("0.5.0", "linux", "riscv64")).toThrow(
      "not supported",
    );
  });
});

describe("release metadata", () => {
  test("selects the matching archive and checksum asset", async () => {
    const fetchImpl = (async () =>
      Response.json({
        tag_name: "v0.5.0",
        assets: [
          {
            name: "routstrd-v0.5.0-linux-x64.tar.gz",
            browser_download_url: "https://example.com/routstrd.tar.gz",
          },
          {
            name: "SHA256SUMS",
            browser_download_url: "https://example.com/SHA256SUMS",
          },
        ],
      })) as typeof fetch;

    const release = await getLatestStandaloneRelease("linux", "x64", fetchImpl);

    expect(release.version).toBe("0.5.0");
    expect(release.archive.name).toBe("routstrd-v0.5.0-linux-x64.tar.gz");
    expect(release.checksums.name).toBe("SHA256SUMS");
  });

  test("rejects releases without the target artifact", async () => {
    const fetchImpl = (async () =>
      Response.json({ tag_name: "v0.5.0", assets: [] })) as typeof fetch;

    expect(
      getLatestStandaloneRelease("linux", "arm64", fetchImpl),
    ).rejects.toThrow("missing");
  });
});

describe("checksum verification", () => {
  test("finds a named checksum", () => {
    const hash = "a".repeat(64);
    expect(expectedChecksum(`${hash}  routstrd.tar.gz\n`, "routstrd.tar.gz")).toBe(
      hash,
    );
  });

  test("hashes downloaded bytes", () => {
    expect(sha256(new TextEncoder().encode("routstrd"))).toBe(
      "328e1349fc24bab876a37f7eef3e7c95e9d06877867e21c6a9d5564b2cb3be05",
    );
  });
});

describe("installStandaloneRelease", () => {
  test("validates and atomically replaces the current executable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "routstrd-updater-test-"));
    tempDirs.push(dir);
    const current = join(dir, "installed-routstrd");
    const archiveRoot = join(dir, "archive");
    const candidate = join(archiveRoot, "routstrd");
    const archivePath = join(dir, "routstrd-v0.5.0-linux-x64.tar.gz");
    mkdirSync(archiveRoot);
    writeFileSync(current, "#!/bin/sh\necho 0.4.4\n");
    writeFileSync(candidate, "#!/bin/sh\necho 0.5.0\n");
    chmodSync(current, 0o755);
    chmodSync(candidate, 0o755);
    const tar = Bun.spawnSync([
      "tar",
      "-C",
      archiveRoot,
      "-czf",
      archivePath,
      "routstrd",
    ]);
    expect(tar.exitCode).toBe(0);

    const archiveBytes = readFileSync(archivePath);
    const checksum = sha256(archiveBytes);
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("SHA256SUMS")) {
        return new Response(`${checksum}  ${releaseName}\n`);
      }
      return new Response(archiveBytes);
    }) as typeof fetch;
    const releaseName = "routstrd-v0.5.0-linux-x64.tar.gz";

    await installStandaloneRelease(
      {
        version: "0.5.0",
        archive: { name: releaseName, browser_download_url: "https://example/archive" },
        checksums: {
          name: "SHA256SUMS",
          browser_download_url: "https://example/SHA256SUMS",
        },
      },
      current,
      fetchImpl,
    );

    const version = Bun.spawnSync([current, "--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString().trim()).toBe("0.5.0");
  });

  test("leaves the installed executable untouched on checksum failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "routstrd-updater-test-"));
    tempDirs.push(dir);
    const current = join(dir, "installed-routstrd");
    writeFileSync(current, "#!/bin/sh\necho 0.4.4\n");
    chmodSync(current, 0o755);
    const original = readFileSync(current, "utf8");
    const fetchImpl = (async (input: string | URL | Request) => {
      return String(input).endsWith("SHA256SUMS")
        ? new Response(`${"0".repeat(64)}  routstrd-v0.5.0-linux-x64.tar.gz\n`)
        : new Response("not the expected archive");
    }) as typeof fetch;

    await expect(
      installStandaloneRelease(
        {
          version: "0.5.0",
          archive: {
            name: "routstrd-v0.5.0-linux-x64.tar.gz",
            browser_download_url: "https://example/archive",
          },
          checksums: {
            name: "SHA256SUMS",
            browser_download_url: "https://example/SHA256SUMS",
          },
        },
        current,
        fetchImpl,
      ),
    ).rejects.toThrow("Checksum mismatch");
    expect(readFileSync(current, "utf8")).toBe(original);
  });
});

describe("ensureValidSignature", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  /** Writes a fake Mach-O: isMachO only inspects the first four magic bytes. */
  function writeFakeMachO(path: string): void {
    writeFileSync(
      path,
      Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(64)]),
    );
    chmodSync(path, 0o755);
  }

  function codesignVerifies(path: string): boolean {
    const proc = Bun.spawnSync(["codesign", "--verify", path], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return proc.exitCode === 0;
  }

  test("detects Mach-O binaries but not scripts or missing files", () => {
    const dir = tempDir("macho-detect-");
    const macho = join(dir, "binary");
    const script = join(dir, "script.sh");
    writeFakeMachO(macho);
    writeFileSync(script, "#!/bin/sh\necho hi\n");

    expect(isMachO(macho)).toBe(true);
    expect(isMachO(script)).toBe(false);
    expect(isMachO(join(dir, "does-not-exist"))).toBe(false);
  });

  test("leaves non-Mach-O payloads alone", () => {
    const dir = tempDir("codesign-script-");
    const target = join(dir, "script.sh");
    writeFileSync(target, "#!/bin/sh\necho hi\n");

    expect(() => ensureValidSignature(target)).not.toThrow();
  });

  // `bun build --compile` appends its standalone payload after the linker's
  // ad-hoc signature, leaving the CodeDirectory stale. This is the regression
  // test for the resulting SIGKILL on macOS.
  const canBuildStandalone =
    process.platform === "darwin" && Bun.which("codesign") !== null;

  test.skipIf(!canBuildStandalone)(
    "repairs the stale signature on a freshly compiled standalone binary",
    () => {
      const dir = tempDir("codesign-integration-");
      const entry = join(dir, "entry.ts");
      writeFileSync(entry, 'console.log("ok");\n');
      const binary = join(dir, "standalone");

      const build = Bun.spawnSync(
        ["bun", "build", "--compile", "--outfile", binary, entry],
        { stdout: "ignore", stderr: "ignore" },
      );
      expect(build.exitCode).toBe(0);
      expect(isMachO(binary)).toBe(true);

      ensureValidSignature(binary);

      // Whether or not this particular build was already valid, the binary must
      // end up with a signature that verifies, otherwise macOS kills it on launch.
      expect(codesignVerifies(binary)).toBe(true);
      const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "ignore" });
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString().trim()).toBe("ok");
    },
    120_000,
  );
});
