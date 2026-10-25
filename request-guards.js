export function requireLibraryRevision(req, currentRevision) {
  if (!currentRevision || req.headers["x-cleanerr-library-revision"] !== currentRevision) {
    const error = new Error("Service settings changed. Refresh the library before performing this action.");
    error.status = 409;
    throw error;
  }
}
