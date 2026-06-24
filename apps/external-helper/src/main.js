import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "./config.js";
import { createServer } from "./server.js";
import { createJsonStore } from "./store.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.HELPER_CONFIG
  ? resolve(process.env.HELPER_CONFIG)
  : resolve(rootDir, "config", "config.example.json");
const statePath = process.env.HELPER_STATE
  ? resolve(process.env.HELPER_STATE)
  : resolve(rootDir, "data", "state.json");
const port = Number.parseInt(process.env.HELPER_PORT || "17654", 10);
const authToken = process.env.HELPER_TOKEN?.trim() || randomUUID();

await mkdir(dirname(statePath), { recursive: true });
const config = await loadConfigFromFile(configPath);
const store = await createJsonStore(statePath);
const server = createServer({ config, store, authToken });

server.listen(port, "127.0.0.1", () => {
  console.log(`Discord extension helper listening on http://127.0.0.1:${port}`);
  console.log(`Config: ${configPath}`);
  console.log(`State: ${statePath}`);
  console.log(`Token: ${authToken}`);
});
