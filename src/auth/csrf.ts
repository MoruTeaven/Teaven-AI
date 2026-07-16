import { permissionDenied } from "../http/errors";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function enforceSameOriginForUnsafeRequest(request: Request): void {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) {
    return;
  }

  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  if (origin && origin !== requestOrigin) {
    throw permissionDenied("Cross-origin requests are not allowed");
  }

  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw permissionDenied("Cross-origin requests are not allowed");
  }
}
