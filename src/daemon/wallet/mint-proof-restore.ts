import {
  MintOperationError,
  normalizeMintUrl,
  type CoreProof,
  type Manager,
  type Repositories,
  type RepositoryTransactionScope,
  type WalletService,
} from "@cashu/coco-core";
import { withTimeout } from "../../utils/with-timeout";

const GAP_LIMIT = 300;
const BATCH_SIZE = 100;
const REQUEST_WAIT_MS = 120_000;
const RESTORE_HEARTBEAT_MS = 30_000;

type Proof = Omit<CoreProof, "mintUrl" | "state" | "usedByOperationId" | "createdByOperationId">;
type MintState = "UNSPENT" | "PENDING" | "SPENT";
type Observation = { proof: Proof; state: MintState };
type OutputData = { keep: { secret: string }[]; send: { secret: string }[] };

/** Coco's operation rows encode deterministic output secrets as hex bytes. */
function protectOutputs(protectedSecrets: Set<string>, data?: OutputData): void {
  if (!data) return;
  for (const { secret } of [...data.keep, ...data.send]) {
    if (!/^(?:[a-f0-9]{2})+$/i.test(secret)) throw new Error("Invalid stored operation output");
    protectedSecrets.add(Buffer.from(secret, "hex").toString("utf8"));
  }
}

async function operationProtection(tx: RepositoryTransactionScope, mintUrl: string) {
  const [sends, melts, receives, mints] = await Promise.all([
    tx.sendOperationRepository.getByMintUrl(mintUrl),
    tx.meltOperationRepository.getByMintUrl(mintUrl),
    tx.receiveOperationRepository.getByMintUrl(mintUrl),
    tx.mintOperationRepository.getByMintUrl(mintUrl),
  ]);
  const ids = new Set<string>();
  const secrets = new Set<string>();
  for (const op of sends) {
    // Exported tokens belong to the recipient, even when a local operation
    // was manually finalized. Never recover their outputs as wallet balance.
    if ("token" in op) for (const proof of op.token?.proofs ?? []) secrets.add(proof.secret);
    if (op.state === "finalized" || op.state === "rolled_back") continue;
    ids.add(op.id);
    if (op.state !== "init") {
      for (const secret of op.inputProofSecrets) secrets.add(secret);
      protectOutputs(secrets, op.outputData);
    }
  }
  for (const op of melts) {
    if (op.state === "finalized" || op.state === "rolled_back") continue;
    ids.add(op.id);
    if (op.state !== "init") {
      for (const secret of op.inputProofSecrets) secrets.add(secret);
      protectOutputs(secrets, op.swapOutputData);
      protectOutputs(secrets, op.changeOutputData);
    }
  }
  for (const op of receives) {
    if (op.state === "finalized" || op.state === "rolled_back") continue;
    ids.add(op.id);
    for (const proof of op.inputProofs) secrets.add(proof.secret);
    if (op.state !== "init") protectOutputs(secrets, op.outputData);
  }
  for (const op of mints) {
    // Explicit quote recovery can reopen failed quotes and reuse their outputs.
    if (op.state === "finalized") continue;
    ids.add(op.id);
    if (op.state !== "init") protectOutputs(secrets, op.outputData);
  }
  return { ids, secrets };
}

async function reconcileKeyset(
  repo: Repositories,
  mintUrl: string,
  keysetId: string,
  observations: Observation[],
  lastSigned: number | undefined,
  assertOpen: () => void,
) {
  return repo.withTransaction(async (tx) => {
    assertOpen();
    const { ids, secrets } = await operationProtection(tx, mintUrl);
    const local = new Map((await tx.proofRepository.getProofsBySecrets(
      mintUrl, observations.map(({ proof }) => proof.secret),
    )).map((proof) => [proof.secret, proof]));
    const insert: CoreProof[] = [];
    const ready: string[] = [];
    const spent: string[] = [];
    const pending: string[] = [];
    let recovered = 0;
    let recoveredSats = 0;
    for (const { proof, state } of observations) {
      const existing = local.get(proof.secret);
      if (existing && (existing.id !== keysetId || existing.amount !== proof.amount ||
          existing.C.toLowerCase() !== proof.C.toLowerCase())) {
        throw new Error("Restored proof conflicts with an existing wallet proof");
      }
      if (secrets.has(proof.secret) || (existing && (
        existing.usedByOperationId ||
        (existing.createdByOperationId && (existing.state === "inflight" || ids.has(existing.createdByOperationId)))
      ))) continue;
      if (state === "SPENT") {
        if (existing && existing.state !== "spent") spent.push(proof.secret);
      } else if (state === "PENDING") {
        // Keep pending known proofs unavailable, without inserting a new
        // inflight row that the ordinary watchers would treat as an operation.
        if (existing?.state === "ready") pending.push(proof.secret);
      } else if (!existing || existing.state === "inflight") {
        // A local spent row is never resurrected, even if the mint says unspent.
        if (existing) ready.push(proof.secret);
        else insert.push({ ...proof, mintUrl, state: "ready" });
        recovered++;
        recoveredSats += proof.amount;
      }
    }
    await tx.proofRepository.saveProofs(mintUrl, insert);
    await tx.proofRepository.setProofState(mintUrl, ready, "ready");
    await tx.proofRepository.setProofState(mintUrl, spent, "spent");
    await tx.proofRepository.setProofState(mintUrl, pending, "inflight");
    if (lastSigned !== undefined) {
      const current = (await tx.counterRepository.getCounter(mintUrl, keysetId))?.counter ?? 0;
      if (lastSigned + 1 > current) await tx.counterRepository.setCounter(mintUrl, keysetId, lastSigned + 1);
    }
    assertOpen();
    return { recovered, recoveredSats };
  });
}

export async function recoverMintProofs(
  coco: Manager,
  repo: Repositories,
  url: string,
  onProgress?: (message: string) => void,
  assertOpen: () => void = () => {},
): Promise<string> {
  const mintUrl = normalizeMintUrl(url);
  const { walletService } = coco as unknown as { walletService?: WalletService };
  if (typeof walletService?.getWallet !== "function" || typeof walletService.clearCache !== "function") {
    throw new Error("Coco's deterministic wallet is unavailable; refusing proof recovery");
  }
  assertOpen();
  onProgress?.(`Fetching mint info for ${mintUrl}…`);
  const { keysets } = await coco.mint.addMint(mintUrl, { trusted: true });
  assertOpen();
  const satKeysets = keysets.filter(({ unit }) => unit === "sat");
  if (!satKeysets.length) throw new Error(`Mint ${mintUrl} has no sat keysets to restore`);
  walletService.clearCache(mintUrl);
  const wallet = await walletService.getWallet(mintUrl);
  if (typeof wallet.restore !== "function" || typeof wallet.checkProofsStates !== "function") {
    throw new Error("Coco's restore and proof-state APIs are unavailable");
  }
  let recoveredSats = 0;
  const failures: string[] = [];
  for (const keyset of satKeysets) {
    assertOpen();
    onProgress?.(`Keyset ${keyset.id}: scanning mint signatures…`);
    const startedAt = Date.now();
    const heartbeat = onProgress && setInterval(() => {
      onProgress(`Keyset ${keyset.id}: still restoring (${Math.round((Date.now() - startedAt) / 1000)}s)…`);
    }, RESTORE_HEARTBEAT_MS);
    const proofs = new Map<string, Proof>();
    let lastSigned: number | undefined;
    let scanned = false;
    try {
      // Match pinned Coco's 300-output gap but issue individual read-only
      // batches, so shutdown/timeouts don't leave an opaque scan running.
      let empty = 0;
      for (let start = 0; empty < GAP_LIMIT; start += BATCH_SIZE) {
        assertOpen();
        const result = await withTimeout(wallet.restore(start, BATCH_SIZE, { keysetId: keyset.id }),
          REQUEST_WAIT_MS, "Timed out reading mint restore signatures");
        scanned = true;
        if (!result.proofs.length) {
          empty += BATCH_SIZE;
          continue;
        }
        empty = 0;
        if (result.lastCounterWithSignature === undefined ||
            !Number.isSafeInteger(result.lastCounterWithSignature) ||
            result.lastCounterWithSignature < start || result.lastCounterWithSignature >= start + BATCH_SIZE) {
          throw new Error("Invalid last signed restore counter");
        }
        lastSigned = result.lastCounterWithSignature;
        for (const proof of result.proofs) {
          if (proof.id !== keyset.id || !Number.isSafeInteger(proof.amount) || proof.amount <= 0 ||
              !proof.secret || !proof.C || proofs.has(proof.secret)) throw new Error("Invalid restored proof");
          proofs.set(proof.secret, proof);
        }
      }
      const restored = [...proofs.values()];
      const observations: Observation[] = [];
      for (let index = 0; index < restored.length; index += BATCH_SIZE) {
        assertOpen();
        const batch = restored.slice(index, index + BATCH_SIZE);
        const states = await withTimeout(wallet.checkProofsStates(batch), REQUEST_WAIT_MS,
          "Timed out checking restored proof states");
        if (!Array.isArray(states) || states.length !== batch.length) throw new Error("Malformed proof state response");
        for (const [i, proof] of batch.entries()) {
          const state = states[i]?.state;
          if (state !== "UNSPENT" && state !== "SPENT" && state !== "PENDING") {
            throw new Error("Unknown restored proof state");
          }
          observations.push({ proof, state });
        }
      }
      const result = await reconcileKeyset(repo, mintUrl, keyset.id, observations, lastSigned, assertOpen);
      recoveredSats += result.recoveredSats;
      onProgress?.(`Keyset ${keyset.id}: ${result.recovered} newly spendable proof(s), ${result.recoveredSats} sat`);
    } catch (error) {
      assertOpen();
      // A protocol-level unknown keyset on the first restore request for an
      // inactive keyset is distinct from transport, NUT-07 and database errors.
      if (!keyset.active && !scanned && error instanceof MintOperationError && error.code === 12001 &&
          /(?:keyset.*(?:not found|unknown|not known)|unknown.*keyset)/i.test(error.message)) {
        onProgress?.(`Keyset ${keyset.id}: skipped (mint no longer serves this retired keyset)`);
        continue;
      }
      const detail = `${keyset.id}: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(detail);
      onProgress?.(`Keyset ${detail}`);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
  if (failures.length) {
    throw new Error(`Mint recovery incomplete (${recoveredSats} sat recovered): ${failures.join("; ")}`);
  }
  return `Mint ${mintUrl} recovered: ${recoveredSats} sat newly spendable`;
}
