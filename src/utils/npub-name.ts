/**
 * Display-name validation for registered npubs.
 *
 * A name is mandatory whenever an npub is created (`npubs register`,
 * `npubs add`) and cannot be removed afterwards (`npubs update`), so every
 * entry the admin list shows is attributable to a person. Only npubs that were
 * bootstrapped from the daemon's environment or migrated from the legacy admin
 * table can still be unnamed.
 */

export const MAX_NPUB_NAME_LENGTH = 64;

export const NPUB_NAME_REQUIRED_MESSAGE =
  "Missing required display name. Provide one with --name <name> (1-64 characters).";

export const NPUB_NAME_CANNOT_CLEAR_MESSAGE =
  "A display name cannot be removed. Provide a new name with --name <name>.";

export interface NpubNameParseResult {
  /** Valid, trimmed name. Absent when `error` or `missing` is set. */
  name?: string;
  /** Human-readable validation error. */
  error?: string;
  /** The option was not supplied at all, so the caller may prompt for it. */
  missing?: boolean;
}

function tooLongError(): string {
  return `Invalid name. Maximum length is ${MAX_NPUB_NAME_LENGTH} characters.`;
}

/** Trim a name and enforce the 64-character cap (counted in code points). */
export function validateNpubName(
  raw: string,
  emptyMessage: string = NPUB_NAME_REQUIRED_MESSAGE,
): NpubNameParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { error: emptyMessage };
  }
  if ([...trimmed].length > MAX_NPUB_NAME_LENGTH) {
    return { error: tooLongError() };
  }
  return { name: trimmed };
}

/**
 * Parse a required `--name` option.
 *
 * `missing` is returned when the flag was not passed, so interactive callers can
 * prompt for the value instead of failing. Empty or whitespace-only values are
 * always an error: a name that is required at creation time cannot be blank.
 */
export function parseRequiredNpubName(raw: string | undefined): NpubNameParseResult {
  if (raw === undefined) return { missing: true };
  return validateNpubName(raw);
}

/**
 * Parse the `--name` option of `npubs update`.
 *
 * Omitting the flag leaves the stored name untouched; passing it must supply a
 * real name, because clearing it would leave a registered npub unnamed.
 */
export function parseUpdatedNpubName(raw: string | undefined): NpubNameParseResult {
  if (raw === undefined) return {};
  return validateNpubName(raw, NPUB_NAME_CANNOT_CLEAR_MESSAGE);
}
