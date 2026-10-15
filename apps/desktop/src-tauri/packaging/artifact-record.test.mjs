import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactRecord } from "./artifact-record.mjs";

test("final-byte inventory changes after mutation and confines reads to workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "repoready-artifact-test-"));
  try {
    // Inert MZ-prefixed bytes are only an inventory fixture, never an installer or certification.
    writeFileSync(join(root, "inert.bin"), "MZinert test bytes");
    writeFileSync(
      join(root, "public.sig"),
      Buffer.from(
        "untrusted comment: TEST fixture only\nnot a real signature\n",
      ).toString("base64"),
    );
    const run = () =>
      artifactRecord(
        root,
        "inert.bin",
        "public.sig",
        "0.1.0-alpha.2",
        "https://updates.repoready.org/0.1.0-alpha.2/RepoReady.exe",
      );
    const first = run();
    assert.equal(first.target, "windows-x86_64");
    writeFileSync(join(root, "inert.bin"), "MZchanged final test bytes");
    assert.notEqual(run().sha256, first.sha256);
    assert.throws(
      () =>
        artifactRecord(
          root,
          "../outside",
          "public.sig",
          "0.1.0-alpha.2",
          "https://updates.repoready.org/0.1.0-alpha.2/RepoReady.exe",
        ),
      /workspace/,
    );
    assert.throws(
      () =>
        artifactRecord(
          root,
          "inert.bin",
          "public.sig",
          "0.1.0-alpha.2",
          "https://updates.repoready.org/latest/RepoReady.exe",
        ),
      /version-specific/,
    );
    writeFileSync(
      join(root, "public.sig"),
      "secret-key material is never accepted",
    );
    assert.throws(run, /signature/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
