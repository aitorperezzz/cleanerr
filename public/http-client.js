export async function readJsonResponse(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    if (response.status === 404) {
      throw new Error(
        "The server is running an older version. Restart Cleanerr and open it on port 3050.",
      );
    }
    throw new Error(`Cleanerr returned an invalid response (${response.status})`);
  }
}

