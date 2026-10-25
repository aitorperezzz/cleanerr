export function requireConfiguredService(service) {
  if (!service?.url || !service.apiKey) {
    const error = new Error(`${service?.label || "Service"} is not configured`);
    error.status = 503;
    throw error;
  }
}

function uncertainWriteError(service, cause) {
  const error = new Error(
    `Could not confirm whether ${service.label} completed the request. Check ${service.label} before retrying.`,
  );
  error.status = 502;
  error.uncertain = true;
  error.cause = cause;
  return error;
}

export function createServiceTransport({
  fetchImpl = fetch,
  readFallback,
  onWrite = () => {},
}) {
  async function fetchJson(service, endpoint) {
    requireConfiguredService(service);
    const url = `${service.url}/api/v3/${endpoint}`;
    let response;

    try {
      response = await fetchImpl(url, {
        redirect: "error",
        headers: {
          "X-Api-Key": service.apiKey,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return readFallback(service, url);
    }

    if (!response.ok) throw new Error(`${service.label} responded ${response.status}`);
    return response.json();
  }

  async function sendJson(service, endpoint, method, body) {
    requireConfiguredService(service);
    const url = `${service.url}/api/v3/${endpoint}`;
    let response;

    try {
      response = await fetchImpl(url, {
        redirect: "error",
        method,
        headers: {
          "X-Api-Key": service.apiKey,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch (cause) {
      onWrite(service);
      throw uncertainWriteError(service, cause);
    }

    onWrite(service);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`${service.label} responded ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    if (response.status === 204) return null;
    return response.json().catch(() => null);
  }

  async function deleteEndpoint(service, url) {
    requireConfiguredService(service);
    let response;

    try {
      response = await fetchImpl(url, {
        redirect: "error",
        method: "DELETE",
        headers: {
          "X-Api-Key": service.apiKey,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(20000),
      });
    } catch (cause) {
      onWrite(service);
      throw uncertainWriteError(service, cause);
    }

    onWrite(service);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`${service.label} responded ${response.status}${detail ? `: ${detail}` : ""}`);
    }
  }

  return { fetchJson, sendJson, deleteEndpoint };
}
