import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const script of [
  "collect-release-backports_test.sh",
  "create-release-backport_test.sh"
]) {
  test(script, () => {
    const result = spawnSync(
      "bash",
      [fileURLToPath(new URL(script, import.meta.url))],
      {
        encoding: "utf8",
        stdio: "pipe"
      }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
}
