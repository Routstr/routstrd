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

export const CONFIDENTIAL_REUSE_SCOPE_HEADER = "x-routstr-reuse-scope";
/** The longest accepted reuse scope, in UTF-8 bytes. */
export const CONFIDENTIAL_REUSE_SCOPE_MAX_BYTES = 256;

export type ConfidentialReuseScopeHeader =
  | { kind: "absent" }
  | { kind: "scope"; value: string }
  | { kind: "invalid"; error: string };

/**
 * Classify `x-routstr-reuse-scope`. The header separates conversations, so a
 * value that cannot be used as given (repeated, empty, over 256 bytes) is
 * refused instead of being dropped: dropping it would run the request in the
 * client's wider scope. Node joins repeated header lines with ", ", so the
 * raw lines are counted when the request has them.
 */
export function parseConfidentialReuseScope(req: {
  headers: Record<string, string | string[] | undefined>;
  rawHeaders?: string[];
}): ConfidentialReuseScopeHeader {
  let values: string[];
  if (Array.isArray(req.rawHeaders)) {
    values = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i]!.toLowerCase() === CONFIDENTIAL_REUSE_SCOPE_HEADER) values.push(req.rawHeaders[i + 1]!);
    }
  } else {
    const raw = req.headers[CONFIDENTIAL_REUSE_SCOPE_HEADER];
    values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  }
  if (values.length === 0) return { kind: "absent" };
  const value = values[0]!;
  if (values.length === 1 && value.length > 0 && Buffer.byteLength(value, "utf8") <= CONFIDENTIAL_REUSE_SCOPE_MAX_BYTES) {
    return { kind: "scope", value };
  }
  return {
    kind: "invalid",
    error:
      `Invalid ${CONFIDENTIAL_REUSE_SCOPE_HEADER} header: send it once, with a value of 1 to ` +
      `${CONFIDENTIAL_REUSE_SCOPE_MAX_BYTES} bytes, or not at all.`,
  };
}

/**
 * The endpoints a confidential request may use: chat completions, and image
 * generation (OpenAI `/v1/images/generations` or Venice-style
 * `/v1/image/generate`), which the node serves when its signed offer has the
 * `images` capability.
 */
export function isConfidentialPath(pathname: string): boolean {
  return /^\/(v1\/)?(chat\/completions|images\/generations|image\/generate)\/?$/.test(pathname);
}
