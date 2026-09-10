import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { releaseArchiveName } from "../src/utils/standalone-update";

const INSTALL_SCRIPT = join(import.meta.dir, "..", "install.sh");
const REPO = "Routstr/routstrd";
const VERSION = "9.9.9";
const PLATFORMS = ["linux", "darwin"] as const;
const ARCHS = ["x64", "arm64"] as const;

const tempDirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Builds a tar.gz that mimics a real release archive: a single `routstrd` entry. */
function buildArchive(dir: string, version: string): Uint8Array {
  const stage = join(dir, "stage");
  const archivePath = join(dir, "archive.tar.gz");
  writeFileSync(
    join(dir, "routstrd"),
    `#!/bin/sh\necho ${version}\n`,
  );
  Bun.spawnSync([
    "sh",
    "-c",
    `mkdir -p ${JSON.stringify(stage)} && cp ${JSON.stringify(join(dir, "routstrd"))} ${JSON.stringify(join(stage, "routstrd"))} && tar -czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(stage)} routstrd`,
  ]);
  return new Uint8Array(readFileSync(archivePath));
}

type FakeReleaseOptions = {
  version?: string;
  asset?: string;
  archive?: Uint8Array;
  checksums?: string;
  omitAsset?: boolean;
  /** Delays the archive response so a test can signal while the download is in flight. */
  assetDelayMs?: number;
};

/**
 * Serves the subset of the GitHub API and release download URLs that install.sh
 * consumes, so the installer can be exercised end to end without network access.
 */
function serveFakeRelease(options: FakeReleaseOptions = {}): string {
  const version = options.version ?? VERSION;
  const asset = options.asset ?? releaseArchiveName(version, "linux", "x64");
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === `/repos/${REPO}/releases/latest`) {
        return Response.json({
          tag_name: `v${version}`,
          assets: [{ name: asset }, { name: "SHA256SUMS" }],
        });
      }
      if (pathname === `/dl/v${version}/SHA256SUMS`) {
        return new Response(options.checksums ?? "");
      }
      if (pathname === `/dl/v${version}/${asset}`) {
        if (options.omitAsset) return new Response("not found", { status: 404 });
        if (options.assetDelayMs) await Bun.sleep(options.assetDelayMs);
        return new Response(options.archive ?? new Uint8Array());
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  return origin;
}

function runInstaller(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync(["sh", INSTALL_SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * The fake release server lives in this process, so tests that download from it
 * must not block the event loop: Bun.spawnSync would deadlock on the request the
 * child makes back into this process. Always await the child instead.
 */
async function runInstallerAsync(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["sh", INSTALL_SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("install.sh", () => {
  test("is valid POSIX shell", () => {
    const result = Bun.spawnSync(["sh", "-n", INSTALL_SCRIPT], { stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("resolves the same asset names as releaseArchiveName", () => {
    for (const platform of PLATFORMS) {
      for (const arch of ARCHS) {
        const result = runInstaller([
          "--print-asset",
          "--version",
          VERSION,
          "--platform",
          platform,
          "--arch",
          arch,
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString().trim()).toBe(
          releaseArchiveName(VERSION, platform, arch),
        );
      }
    }
  });

  test("accepts a v-prefixed version", () => {
    const result = runInstaller([
      "--print-asset",
      "--version",
      `v${VERSION}`,
      "--platform",
      "linux",
      "--arch",
      "x64",
    ]);
    expect(result.stdout.toString().trim()).toBe(releaseArchiveName(VERSION, "linux", "x64"));
  });

  test("rejects unsupported platforms and architectures", () => {
    for (const args of [
      ["--print-asset", "--version", VERSION, "--platform", "windows", "--arch", "x64"],
      ["--print-asset", "--version", VERSION, "--platform", "linux", "--arch", "riscv64"],
      ["--print-asset", "--version", "../../etc/passwd", "--platform", "linux", "--arch", "x64"],
    ]) {
      const result = runInstaller(args);
      expect(result.exitCode).not.toBe(0);
    }
  });

  test("installs the executable from a release archive", async () => {
    const dir = tempDir("routstrd-install-e2e-");
    const installDir = join(dir, "bin");
    const asset = releaseArchiveName(VERSION, process.platform, process.arch);
    const archive = buildArchive(dir, VERSION);
    const origin = serveFakeRelease({
      asset,
      archive,
      checksums: `${sha256Hex(archive)}  ${asset}\n`,
    });

    const result = await runInstallerAsync([
      "--dir",
      installDir,
      "--api-base-url",
      origin,
      "--download-base-url",
      `${origin}/dl`,
    ]);

    expect(result.stderr).toContain(`Installed routstrd v${VERSION}`);
    expect(result.exitCode).toBe(0);

    const target = join(installDir, "routstrd");
    expect(statSync(target).mode & 0o111).not.toBe(0);
    const version = Bun.spawnSync([target, "--version"]);
    expect(version.stdout.toString().trim()).toBe(VERSION);
  });

  test("installs a specific version without querying the API", async () => {
    const dir = tempDir("routstrd-install-pinned-");
    const installDir = join(dir, "bin");
    const asset = releaseArchiveName(VERSION, process.platform, process.arch);
    const archive = buildArchive(dir, VERSION);
    const origin = serveFakeRelease({
      asset,
      archive,
      checksums: `${sha256Hex(archive)}  ${asset}\n`,
    });

    const result = await runInstallerAsync([
      "--version",
      VERSION,
      "--dir",
      installDir,
      "--api-base-url",
      `${origin}/broken`,
      "--download-base-url",
      `${origin}/dl`,
    ]);

    expect(result.exitCode).toBe(0);
    expect(statSync(join(installDir, "routstrd")).isFile()).toBe(true);
  });

  test("refuses to install when the checksum does not match", async () => {
    const dir = tempDir("routstrd-install-tampered-");
    const installDir = join(dir, "bin");
    const asset = releaseArchiveName(VERSION, process.platform, process.arch);
    const archive = buildArchive(dir, VERSION);
    const origin = serveFakeRelease({
      asset,
      archive,
      checksums: `${sha256Hex(new TextEncoder().encode("tampered"))}  ${asset}\n`,
    });

    const result = await runInstallerAsync([
      "--dir",
      installDir,
      "--api-base-url",
      origin,
      "--download-base-url",
      `${origin}/dl`,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch");
    expect(() => statSync(join(installDir, "routstrd"))).toThrow();
  });

  test("reports a missing asset for the current platform", async () => {
    const dir = tempDir("routstrd-install-missing-");
    const origin = serveFakeRelease({
      asset: releaseArchiveName(VERSION, process.platform, process.arch),
      omitAsset: true,
    });

    const result = await runInstallerAsync([
      "--dir",
      join(dir, "bin"),
      "--api-base-url",
      origin,
      "--download-base-url",
      `${origin}/dl`,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("may not include a build");
  });

  test("reports a release without SHA256SUMS", async () => {
    const dir = tempDir("routstrd-install-nosums-");
    const asset = releaseArchiveName(VERSION, process.platform, process.arch);
    const archive = buildArchive(dir, VERSION);
    const origin = serveFakeRelease({ asset, archive, checksums: "" });

    const result = await runInstallerAsync([
      "--dir",
      join(dir, "bin"),
      "--api-base-url",
      origin,
      "--download-base-url",
      `${origin}/dl`,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("does not contain");
  });

  test("honours ROUTSTRD_INSTALL_DIR when --dir is absent", async () => {
    const dir = tempDir("routstrd-install-env-");
    const installDir = join(dir, "bin");
    const asset = releaseArchiveName(VERSION, process.platform, process.arch);
    const archive = buildArchive(dir, VERSION);
    const origin = serveFakeRelease({
      asset,
      archive,
      checksums: `${sha256Hex(archive)}  ${asset}\n`,
    });

    const result = await runInstallerAsync(
      [
        "--api-base-url",
        origin,
        "--download-base-url",
        `${origin}/dl`,
      ],
      { ROUTSTRD_INSTALL_DIR: installDir },
    );

    expect(result.exitCode).toBe(0);
    const installed = join(installDir, "routstrd");
    expect(statSync(installed).isFile()).toBe(true);
    expect(statSync(installed).mode & 0o111).not.toBe(0);
  });

  test("prints the asset without curl, wget or HOME", () => {
    // --print-asset performs no install and, with --version, no network access,
    // so it must not require an HTTP client or an install directory. /bin/sh is
    // addressed absolutely because PATH is deliberately stripped.
    const result = Bun.spawnSync(
      [
        "/bin/sh",
        INSTALL_SCRIPT,
        "--print-asset",
        "--version",
        VERSION,
        "--platform",
        "linux",
        "--arch",
        "x64",
      ],
      { env: { PATH: "/nonexistent" }, stdout: "pipe", stderr: "pipe" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(releaseArchiveName(VERSION, "linux", "x64"));
  });

  test("refuses a release whose binary reports the wrong version", async () => {
    const dir = tempDir("routstrd-install-wrong-version-");
    const installDir = join(dir, "bin");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "routstrd"), "#!/bin/sh\necho old\n");
    const asset = releaseArchiveName(VERSION, process.platform, process.arch);
    const archive = buildArchive(dir, "0.0.1");
    const origin = serveFakeRelease({
      asset,
      archive,
      checksums: `${sha256Hex(archive)}  ${asset}\n`,
    });

    const result = await runInstallerAsync([
      "--dir",
      installDir,
      "--api-base-url",
      origin,
      "--download-base-url",
      `${origin}/dl`,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("reported version");
    // The previous install must survive a rejected update.
    expect(readFileSync(join(installDir, "routstrd"), "utf8")).toContain("old");
  });

  test("accepts a staged binary that reports a v-prefixed version", async () => {
    const dir = tempDir("routstrd-install-vprefixed-binary-");
    const installDir = join(dir, "bin");
    const asset = releaseArchiveName(VERSION, process.platform, process.arch);
    const archive = buildArchive(dir, `v${VERSION}`);
    const origin = serveFakeRelease({
      asset,
      archive,
      checksums: `${sha256Hex(archive)}  ${asset}\n`,
    });

    const result = await runInstallerAsync([
      "--dir",
      installDir,
      "--api-base-url",
      origin,
      "--download-base-url",
      `${origin}/dl`,
    ]);

    expect(result.exitCode).toBe(0);
    expect(statSync(join(installDir, "routstrd")).isFile()).toBe(true);
  });

  test("rejects an oversized SHA256SUMS", async () => {
    const dir = tempDir("routstrd-install-big-sums-");
    const asset = releaseArchiveName(VERSION, process.platform, process.arch);
    const archive = buildArchive(dir, VERSION);
    const origin = serveFakeRelease({
      asset,
      archive,
      checksums: `${sha256Hex(archive)}  ${asset}\n${"a".repeat(2 * 1024 * 1024)}\n`,
    });

    const result = await runInstallerAsync([
      "--dir",
      join(dir, "bin"),
      "--api-base-url",
      origin,
      "--download-base-url",
      `${origin}/dl`,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("SHA256SUMS is unexpectedly large");
  });

  test(
    "exits without installing when interrupted mid-download",
    async () => {
      const dir = tempDir("routstrd-install-interrupt-");
      const installDir = join(dir, "bin");
      const tmpParent = join(dir, "tmp");
      mkdirSync(tmpParent, { recursive: true });
      const asset = releaseArchiveName(VERSION, process.platform, process.arch);
      const archive = buildArchive(dir, VERSION);
      const origin = serveFakeRelease({
        asset,
        archive,
        checksums: `${sha256Hex(archive)}  ${asset}\n`,
        assetDelayMs: 2000,
      });

      const proc = Bun.spawn(
        [
          "sh",
          INSTALL_SCRIPT,
          "--dir",
          installDir,
          "--api-base-url",
          origin,
          "--download-base-url",
          `${origin}/dl`,
        ],
        { env: { ...process.env, TMPDIR: tmpParent }, stdout: "pipe", stderr: "pipe" },
      );

      // Signal while the archive download is still in flight. The installer must
      // report the interrupt, exit non-zero and clean up after itself, rather
      // than resuming into a misleading follow-on failure (or an install).
      await Bun.sleep(300);
      proc.kill();

      const [exitCode, stderr] = await Promise.all([
        Promise.race([proc.exited, Bun.sleep(8000).then(() => -1)]),
        new Response(proc.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Interrupted.");
      expect(readdirSync(tmpParent)).toEqual([]);
      expect(() => statSync(join(installDir, "routstrd"))).toThrow();
    },
    15000,
  );
});
