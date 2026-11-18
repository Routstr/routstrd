import { createHash } from "crypto";
import type { ReceiveOperation } from "@cashu/coco-core";
import type { Database } from "bun:sqlite";

const TOKEN_TABLE = "routstrd_receive_tokens";
const MAINTENANCE_TABLE = "routstrd_wallet_maintenance";
const RECONCILE_BACKUP_KEY = "receive_reconcile_v1_backup";

export type StoredReceiveTokenState = "processing" | "succeeded" | "failed";

export interface StoredReceiveTokenRow {
  tokenHash: string;
  state: StoredReceiveTokenState;
  operationId: string | null;
  error: string | null;
}

export interface ReceiveTokenReservation {
  acquired: boolean;
  tokenHash: string;
  existing?: StoredReceiveTokenRow;
}

export interface ReceiveReconcileResult {
  executing: number;
  uniqueGroups: number;
  rolledBack: number;
  retained: number;
  unresolved: number;
  recoveryOperationIds: string[];
  backupPath?: string;
}

interface SerializedBlindedMessageLike {
  amount: number;
  id: string;
  B_: string;
}

interface SerializedOutput {
  blindedMessage: SerializedBlindedMessageLike;
  secret: string;
}

interface SerializedOutputDataLike {
  keep: SerializedOutput[];
  send: SerializedOutput[];
}

type ExecutingReceive = Extract<ReceiveOperation, { state: "executing" }>;

export interface ReceiveReconcileSource {
  listExecuting(): Promise<ReceiveOperation[]>;
  checkProofStates(operation: ExecutingReceive): Promise<Array<{ state: string }>>;
  restoreOutputs(
    mintUrl: string,
    outputs: SerializedBlindedMessageLike[],
  ): Promise<Array<{ B_: string }>>;
  hasSavedOutputs(operation: ExecutingReceive): Promise<boolean>;
  rollBack(operation: ExecutingReceive, reason: string): Promise<void>;
}

export function hashReceiveToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function initReceiveDedupSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${TOKEN_TABLE} (
      tokenHash TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('processing', 'succeeded', 'failed')),
      operationId TEXT,
      error TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${MAINTENANCE_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);
}

export function listProcessingReceiveTokens(database: Database): StoredReceiveTokenRow[] {
  return database
    .query(
      `SELECT tokenHash, state, operationId, error
       FROM ${TOKEN_TABLE} WHERE state = 'processing'`,
    )
    .all() as StoredReceiveTokenRow[];
}

export function deleteReceiveTokenReservation(database: Database, tokenHash: string): void {
  database.query(`DELETE FROM ${TOKEN_TABLE} WHERE tokenHash = ?`).run(tokenHash);
}

export function clearInterruptedReceiveReservations(database: Database): number {
  const result = database
    .query(
      `DELETE FROM ${TOKEN_TABLE}
       WHERE state = 'processing' AND operationId IS NULL`,
    )
    .run();
  return result.changes;
}

export function reserveReceiveToken(database: Database, token: string): ReceiveTokenReservation {
  const tokenHash = hashReceiveToken(token);
  const now = Math.floor(Date.now() / 1000);
  const result = database
    .query(
      `INSERT OR IGNORE INTO ${TOKEN_TABLE}
       (tokenHash, state, operationId, error, createdAt, updatedAt)
       VALUES (?, 'processing', NULL, NULL, ?, ?)`,
    )
    .run(tokenHash, now, now);

  if (result.changes > 0) return { acquired: true, tokenHash };

  const existing = database
    .query(
      `SELECT tokenHash, state, operationId, error
       FROM ${TOKEN_TABLE} WHERE tokenHash = ?`,
    )
    .get(tokenHash) as StoredReceiveTokenRow | null;
  return { acquired: false, tokenHash, ...(existing ? { existing } : {}) };
}

export function releaseReceiveToken(database: Database, tokenHash: string): void {
  database
    .query(`DELETE FROM ${TOKEN_TABLE} WHERE tokenHash = ? AND operationId IS NULL`)
    .run(tokenHash);
}

export function updateReceiveToken(
  database: Database,
  tokenHash: string,
  update: { state: StoredReceiveTokenState; operationId?: string; error?: string },
): void {
  database
    .query(
      `UPDATE ${TOKEN_TABLE}
       SET state = ?, operationId = COALESCE(?, operationId), error = ?, updatedAt = ?
       WHERE tokenHash = ?`,
    )
    .run(
      update.state,
      update.operationId ?? null,
      update.error ?? null,
      Math.floor(Date.now() / 1000),
      tokenHash,
    );
}

export function receiveInputFingerprint(operation: ReceiveOperation): string {
  // Legacy cleanup is intentionally stricter than new-request token hashing:
  // only operations with the exact same proof material are grouped. A shared
  // secret alone is not enough evidence to discard an operation.
  const proofs = operation.inputProofs
    .map((proof) => ({
      amount: proof.amount,
      id: proof.id,
      secret: proof.secret,
      C: proof.C,
      witness: proof.witness ?? null,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return createHash("sha256")
    .update(JSON.stringify([operation.mintUrl, operation.unit, proofs]))
    .digest("hex");
}

export function groupExecutingReceives(
  operations: ReceiveOperation[],
): ExecutingReceive[][] {
  const groups = new Map<string, ExecutingReceive[]>();
  for (const operation of operations) {
    if (operation.state !== "executing") continue;
    const key = receiveInputFingerprint(operation);
    const group = groups.get(key) ?? [];
    group.push(operation);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) =>
    group.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
  );
}

function outputData(operation: ExecutingReceive): SerializedOutputDataLike | null {
  const value = operation.outputData as unknown;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SerializedOutputDataLike>;
  if (!Array.isArray(candidate.keep) || !Array.isArray(candidate.send)) return null;
  return { keep: candidate.keep, send: candidate.send };
}

function outputBlindedMessages(operation: ExecutingReceive): SerializedBlindedMessageLike[] {
  const data = outputData(operation);
  if (!data) return [];
  return [...data.keep, ...data.send]
    .map((entry) => entry?.blindedMessage)
    .filter((message): message is SerializedBlindedMessageLike =>
      Boolean(
        message &&
          typeof message.B_ === "string" &&
          message.B_ &&
          typeof message.id === "string" &&
          Number.isFinite(message.amount),
      ),
    );
}

async function rollBackOthers(
  source: ReceiveReconcileSource,
  group: ExecutingReceive[],
  retainedIds: Set<string>,
  reason: string,
): Promise<number> {
  let count = 0;
  for (const operation of group) {
    if (retainedIds.has(operation.id)) continue;
    await source.rollBack(operation, reason);
    count++;
  }
  return count;
}

/**
 * Reduce legacy executing receives before coco-core's per-operation recovery.
 *
 * No state is changed unless the evidence is conclusive:
 * - saved local outputs identify the successful operation;
 * - all inputs are unspent, so one deterministic retry is sufficient; or
 * - all inputs are spent and restore identifies an output owner (or confirms
 *   that none of the stored deterministic outputs exist).
 *
 * Unreachable mints, malformed output data, partial restore ownership, and
 * mixed proof states are left untouched for normal recovery/manual review.
 */
export async function reconcileExecutingReceives(
  source: ReceiveReconcileSource,
): Promise<ReceiveReconcileResult> {
  const executing = (await source.listExecuting()).filter(
    (operation): operation is ExecutingReceive => operation.state === "executing",
  );
  const groups = groupExecutingReceives(executing);
  const result: ReceiveReconcileResult = {
    executing: executing.length,
    uniqueGroups: groups.length,
    rolledBack: 0,
    retained: 0,
    unresolved: 0,
    recoveryOperationIds: [],
  };

  for (const group of groups) {
    try {
      const savedOwners = new Set<string>();
      for (const operation of group) {
        if (await source.hasSavedOutputs(operation)) savedOwners.add(operation.id);
      }
      if (savedOwners.size > 0) {
        result.rolledBack += await rollBackOthers(
          source,
          group,
          savedOwners,
          "Duplicate receive: outputs already persisted by another operation",
        );
        result.retained += savedOwners.size;
        result.recoveryOperationIds.push(...savedOwners);
        continue;
      }

      const states = await source.checkProofStates(group[0]!);
      const completeStates = states.length === group[0]!.inputProofs.length;
      const allUnspent = completeStates && states.every((state) => state.state === "UNSPENT");
      const allSpent = completeStates && states.every((state) => state.state === "SPENT");

      if (allUnspent) {
        const canonical = group.find((operation) => outputBlindedMessages(operation).length > 0);
        if (!canonical) {
          result.unresolved += group.length;
          continue;
        }
        result.rolledBack += await rollBackOthers(
          source,
          group,
          new Set([canonical.id]),
          "Duplicate receive: identical inputs retained by canonical operation",
        );
        result.retained++;
        result.recoveryOperationIds.push(canonical.id);
        continue;
      }

      if (!allSpent) {
        result.unresolved += group.length;
        continue;
      }

      const outputOwners = new Map<
        string,
        { message: SerializedBlindedMessageLike; owners: Set<string> }
      >();
      let malformed = false;
      for (const operation of group) {
        const outputs = outputBlindedMessages(operation);
        if (outputs.length === 0) {
          malformed = true;
          continue;
        }
        for (const output of outputs) {
          const entry = outputOwners.get(output.B_) ?? {
            message: output,
            owners: new Set<string>(),
          };
          entry.owners.add(operation.id);
          outputOwners.set(output.B_, entry);
        }
      }
      if (malformed || outputOwners.size === 0) {
        result.unresolved += group.length;
        continue;
      }

      const restored = await source.restoreOutputs(
        group[0]!.mintUrl,
        [...outputOwners.values()].map((entry) => entry.message),
      );
      const restoredOwners = new Set<string>();
      for (const output of restored) {
        for (const owner of outputOwners.get(output.B_)?.owners ?? []) {
          restoredOwners.add(owner);
        }
      }

      if (restoredOwners.size === 0) {
        for (const operation of group) {
          await source.rollBack(
            operation,
            "Recovered: input proofs spent without recoverable outputs",
          );
          result.rolledBack++;
        }
        continue;
      }

      result.rolledBack += await rollBackOthers(
        source,
        group,
        restoredOwners,
        "Duplicate receive: recoverable outputs belong to another operation",
      );
      result.retained += restoredOwners.size;
      result.recoveryOperationIds.push(...restoredOwners);
    } catch {
      // A network, parsing, or persistence failure is not evidence that an
      // operation is safe to abandon. Leave the complete group untouched.
      result.unresolved += group.length;
    }
  }

  return result;
}

export function getReceiveReconcileBackup(database: Database): string | null {
  const row = database
    .query(`SELECT value FROM ${MAINTENANCE_TABLE} WHERE key = ?`)
    .get(RECONCILE_BACKUP_KEY) as { value: string } | null;
  return row?.value ?? null;
}

export function setReceiveReconcileBackup(database: Database, path: string): void {
  database
    .query(
      `INSERT INTO ${MAINTENANCE_TABLE} (key, value, updatedAt)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    )
    .run(RECONCILE_BACKUP_KEY, path, Math.floor(Date.now() / 1000));
}
