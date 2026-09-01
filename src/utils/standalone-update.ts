import { createHash, randomBytes } from "crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

const RELEASES_API = "https://api.github.com/repos/Routstr/routstrd/releases/latest";
const FETCH_TIMEOUT_MS = 30_000;
const PROCESS_TIMEOUT_MS = 30_000;
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024 * 1024;

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type GithubRelease = {
  tag_name: string;
  assets: ReleaseAsset[];
};

export type StandaloneRelease = {
  version: string;
  archive: ReleaseAsset;
  checksums: ReleaseAsset;
};

function normalizeVersion(version: string): string {
  return version.replace(/^v/, "");
}

export function releaseArchiveName(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`Standalone updates are not supported on ${platform}.`);
  }
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Standalone updates are not supported on ${platform}-${arch}.`);
  }
  return `routstrd-v${normalizeVersion(version)}-${platform}-${arch}.tar.gz`;
}

async function fetchOrThrow(
  url: string,
  fetchImpl: typeof fetch,
  maxBytes = MAX_CHECKSUM_BYTES,
): Promise<Response> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "routstrd",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Download is too large (${contentLength} bytes) for ${url}`);
  }
  return response;
}

async function waitForExit(
  proc: { exited: Promise<number>; kill(): void },
  label: string,
): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          proc.kill();
          reject(new Error(`${label} timed out.`));
        }, PROCESS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function getLatestStandaloneRelease(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  fetchImpl: typeof fetch = fetch,
): Promise<StandaloneRelease> {
  const response = await fetchOrThrow(RELEASES_API, fetchImpl);
  const release = (await response.json()) as GithubRelease;
  const version = normalizeVersion(release.tag_name || "");
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error("The latest GitHub Release has an invalid version tag.");
  }

  const archiveName = releaseArchiveName(version, platform, arch);
  const archive = release.assets.find((asset) => asset.name === archiveName);
  const checksums = release.assets.find((asset) => asset.name === "SHA256SUMS");
  if (!archive || !checksums) {
    throw new Error(`GitHub Release v${version} is missing ${archiveName} or SHA256SUMS.`);
  }
  return { version, archive, checksums };
}

export function expectedChecksum(contents: string, filename: string): string {
  for (const line of contents.split("\n")) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match?.[2] === filename) return match[1]!.toLowerCase();
  }
  throw new Error(`SHA256SUMS does not contain ${filename}.`);
}

export function sha256(bytes: ArrayBuffer | Uint8Array): string {
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

async function verifyCandidate(path: string, version: string): Promise<void> {
  const proc = Bun.spawn([path, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, outputText, errorText] = await Promise.all([
    waitForExit(proc, "Downloaded binary validation"),
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const output = outputText.trim();
  const error = errorText.trim();
  if (code !== 0 || normalizeVersion(output) !== normalizeVersion(version)) {
    throw new Error(
      `Downloaded binary failed version validation.${error ? ` ${error}` : ""}`,
    );
  }
}

export async function installStandaloneRelease(
  release: StandaloneRelease,
  executablePath: string = process.execPath,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), "routstrd-update-"));
  const archivePath = join(tempDir, release.archive.name);
  const stagedPath = `${executablePath}.update-${randomBytes(12).toString("hex")}`;

  try {
    const [archiveResponse, checksumsResponse] = await Promise.all([
      fetchOrThrow(
        release.archive.browser_download_url,
        fetchImpl,
        MAX_ARCHIVE_BYTES,
      ),
      fetchOrThrow(release.checksums.browser_download_url, fetchImpl),
    ]);
    const archiveBytes = await archiveResponse.arrayBuffer();
    if (archiveBytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(`Download is too large (${archiveBytes.byteLength} bytes).`);
    }
    const checksums = await checksumsResponse.text();
    if (Buffer.byteLength(checksums) > MAX_CHECKSUM_BYTES) {
      throw new Error("SHA256SUMS is too large.");
    }
    const expected = expectedChecksum(checksums, release.archive.name);
    const actual = sha256(archiveBytes);
    if (actual !== expected) {
      throw new Error(
        `Checksum mismatch for ${release.archive.name}: expected ${expected}, got ${actual}.`,
      );
    }
    writeFileSync(archivePath, new Uint8Array(archiveBytes));

    const extract = Bun.spawn(["tar", "-xzf", archivePath, "-C", tempDir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [extractCode, extractErrorText] = await Promise.all([
      waitForExit(extract, "Archive extraction"),
      new Response(extract.stderr).text(),
    ]);
    const extractError = extractErrorText.trim();
    if (extractCode !== 0) {
      throw new Error(`Could not extract ${release.archive.name}. ${extractError}`.trim());
    }

    const extractedPath = join(tempDir, "routstrd");
    const mode = statSync(executablePath).mode & 0o777;
    copyFileSync(extractedPath, stagedPath, constants.COPYFILE_EXCL);
    chmodSync(stagedPath, mode || 0o755);
    await verifyCandidate(stagedPath, release.version);
    renameSync(stagedPath, executablePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not update ${basename(executablePath)} in place. ${detail}`,
      { cause: error },
    );
  } finally {
    rmSync(stagedPath, { force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
}
