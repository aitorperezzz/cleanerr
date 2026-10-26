import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireConfiguredService } from "./service-transport.js";

const execFileAsync = promisify(execFile);

export async function curlJson(service, url) {
  const text = await curlText(service, url);
  if (!text) return null;
  return JSON.parse(text);
}

async function curlText(service, url) {
  requireConfiguredService(service);
  const args = [
    "-sS",
    "-w",
    "\n%{http_code}",
    "-X",
    "GET",
    "-H",
    `X-Api-Key: ${service.apiKey}`,
    "-H",
    "accept: application/json",
  ];

  args.push(url);

  const { stdout } = await execFileAsync("curl", args, {
    maxBuffer: 50 * 1024 * 1024,
    timeout: 30000,
  });
  const separator = stdout.lastIndexOf("\n");
  const responseBody = separator === -1 ? "" : stdout.slice(0, separator);
  const status = Number(separator === -1 ? stdout : stdout.slice(separator + 1));

  if (status < 200 || status >= 300) {
    throw new Error(`${service.label} responded ${status}${responseBody ? `: ${responseBody}` : ""}`);
  }

  return responseBody;
}

