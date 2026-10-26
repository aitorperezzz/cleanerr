import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rawConfig = JSON.parse(readFileSync(resolve(rootDir, "config.json"), "utf8"));
const host = String(rawConfig.server?.host || "").trim();
const port = Number(rawConfig.server?.port);
const configuredDataDirectory = process.env.CLEANERR_DATA_DIR?.trim();
const dataDirectory = configuredDataDirectory
  ? resolve(configuredDataDirectory)
  : process.env.NODE_ENV === "production"
    ? "/data"
    : resolve(rootDir, "data");

if (!host) throw new Error("config.json: server.host is required");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("config.json: server.port must be an integer between 1 and 65535");
}
export const config = {
  host,
  port,
  settingsFile: resolve(dataDirectory, "config.json"),
};
