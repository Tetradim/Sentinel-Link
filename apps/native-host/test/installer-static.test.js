import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("native host installer registers a compiled executable instead of a command wrapper", async () => {
  const installer = await readFile("scripts/install-copy-repost-native-host.ps1", "utf8");

  assert.match(installer, /copy-repost-native-host\.exe/);
  assert.match(installer, /csc\.exe/);
  assert.match(installer, /launcherExePath/);
  assert.doesNotMatch(installer, /"path": "\$\(ConvertTo-JsonEscaped \$wrapperPath\)"/);
});

test("native host installer allows the currently loaded unpacked extension id", async () => {
  const installer = await readFile("scripts/install-copy-repost-native-host.ps1", "utf8");

  assert.match(installer, /Find-InstalledCopyRepostExtensionIds/);
  assert.match(installer, /Secure Preferences/);
  assert.match(installer, /extensions\\copy-repost/);
  assert.match(installer, /allowedOriginsJson/);
  assert.doesNotMatch(installer, /"chrome-extension:\/\/\$ExtensionId\/"/);
});
