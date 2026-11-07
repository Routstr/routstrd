/**
 * Only model metadata gets additional cross-origin read permission.
 * This policy is not authentication, CSRF protection, or DNS-rebinding defense.
 */
export const CORS_ROUTES: ReadonlySet<string> = new Set(["/v1/models"]);

/** Only HTTP loopback origins receive cross-origin read permission. */
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

const CORS_ROUTE_HEADERS = {
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "accept, content-type",
  "access-control-max-age": "600",
} as const;

/**
 * CORS response headers for one request, or null when nothing is exposed.
 *
 * @param method - Request method.
 * @param pathname - Canonical request path, after collapsing duplicated `/v1` segments.
 * @param origin - Request `Origin` header, if any.
 * @returns Headers to set on the response, or null to grant no additional cross-origin read permission.
 */
export function corsHeadersFor(
  method: string,
  pathname: string,
  origin: string | undefined,
): Record<string, string> | null {
  if (!origin || !LOOPBACK_ORIGIN.test(origin)) return null;
  if (!CORS_ROUTES.has(pathname)) return null;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") return null;
  return {
    "access-control-allow-origin": origin,
    vary: "origin",
    ...CORS_ROUTE_HEADERS,
  };
}

