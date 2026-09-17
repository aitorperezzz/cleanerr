import "dotenv/config";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function serviceConfig(label, prefix) {
  const rawUrl = required(`${prefix}_URL`);

  try {
    return {
      label,
      url: new URL(rawUrl).toString().replace(/\/$/, ""),
      apiKey: required(`${prefix}_API_KEY`),
    };
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`${prefix}_URL must be a valid absolute URL`);
    }
    throw error;
  }
}

function optionalUrl(name) {
  const value = process.env[name]?.trim();
  if (!value) return "";

  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
}

const port = Number(required("PORT"));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

export const config = {
  host: required("HOST"),
  port,
  services: {
    radarr: serviceConfig("Radarr", "RADARR"),
    sonarr: serviceConfig("Sonarr", "SONARR"),
  },
  jellyfin: {
    url: optionalUrl("JELLYFIN_URL"),
    apiKey: process.env.JELLYFIN_API_KEY?.trim() || "",
  },
};
