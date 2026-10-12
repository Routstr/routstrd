/**
 * Parsing of the per-request confidential opt-in header.
 *
 * A request opts into the confidential upstream with
 * `x-routstr-verify: confidential`. A value that is only nearly right (a
 * typo, a list, a different word) must not fall through to the plain path:
 * whoever sent it asked for something, and the plain path would hand the
 * prompt to the node. Such values are refused instead. Surrounding
 * whitespace and letter case are ignored for the one accepted value.
 */

export const CONFIDENTIAL_OPT_IN_HEADER = "x-routstr-verify";
export const CONFIDENTIAL_OPT_IN_VALUE = "confidential";

export type ConfidentialOptIn =
  | { kind: "absent" }
  | { kind: "confidential" }
  | { kind: "invalid"; error: string };

/** Classify the raw header value as Node's `IncomingMessage` reports it. */
export function parseConfidentialOptIn(
  raw: string | string[] | undefined,
): ConfidentialOptIn {
  if (raw === undefined) return { kind: "absent" };
  const values = Array.isArray(raw) ? raw : [raw];
  // Node joins repeated unknown headers with ", ": a list, in either form,
  // is not the single accepted value.
  if (values.length === 1) {
    const v = values[0]!.trim().toLowerCase();
    if (v === CONFIDENTIAL_OPT_IN_VALUE) return { kind: "confidential" };
  }
  return {
    kind: "invalid",
    error:
      `Unrecognized ${CONFIDENTIAL_OPT_IN_HEADER} header value; the only accepted value is ` +
      `"${CONFIDENTIAL_OPT_IN_VALUE}". Remove the header to send the request on the plain path.`,
  };
}
