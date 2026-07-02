import { readFile } from "node:fs/promises";
import { validateConfig } from "@sentinel-link/shared";

export async function loadConfigFromFile(configPath) {
  const raw = await readFile(configPath, "utf8");
  return validateConfig(JSON.parse(raw));
}
