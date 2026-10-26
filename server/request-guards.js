export function requireLibraryRevision(req, currentRevision) {
  if (!currentRevision || req.headers["x-cleanerr-library-revision"] !== currentRevision) {
    const error = new Error("Service settings changed. Refresh the library before performing this action.");
    error.status = 409;
    throw error;
  }
}

export function requireSafeWrite(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const reject = (message, status = 403) => {
    const error = new Error(message);
    error.status = status;
    throw error;
  };
  // This non-safelisted header also prevents cross-origin HTML forms from writing.
  if (req.headers["x-cleanerr-request"] !== "1") reject("Missing Cleanerr request header.");
  if (req.headers["sec-fetch-site"] === "cross-site") reject("Cross-origin writes are not allowed.");
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { reject("Invalid request origin."); }
    if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host) {
      reject("Cross-origin writes are not allowed.");
    }
  }
  if (["POST", "PUT"].includes(req.method) && req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    reject("Request content type must be application/json.", 415);
  }
}
