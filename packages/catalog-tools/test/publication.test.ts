import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Manifest } from "@repoready/contracts";
import { DOMAIN, sha256, type Index } from "../src/index.js";
import { CandidateSchema } from "../src/editorial.js";
import {
  authenticatePublications,
  loadCatalog,
  type Publication,
} from "../src/publication.js";
const { privateKey, publicKey } = generateKeyPairSync("ed25519"); // Ephemeral test-only authority.
const now = Date.parse("2026-10-15T12:00:00Z");
const date = "2026-10-14T12:00:00Z";
const seed = CandidateSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../../../catalog/candidates/ollama.json", import.meta.url),
      "utf8",
    ),
  ),
);
const cases = JSON.parse(
  readFileSync(
    new URL("../../contracts/fixtures/cases.json", import.meta.url),
    "utf8",
  ),
) as { schema: string; valid: boolean; value: Manifest }[];
function fixture(
  change?: (presentation: Publication, manifest: Manifest) => void,
) {
  const manifest = structuredClone(
    cases.find((entry) => entry.schema === "InstallManifest" && entry.valid)!
      .value,
  );
  manifest.app.id = "ollama";
  manifest.app.slug = "ollama";
  manifest.release.appId =
    manifest.artifact.appId =
    manifest.verification.appId =
      "ollama";
  manifest.app.sourceUrl = seed.sourceUrl;
  manifest.app.name = seed.name;
  manifest.app.upstreamAuthor = seed.upstreamAuthor;
  manifest.app.supportUrl = "https://github.com/ollama/ollama/issues";
  manifest.artifact.downloadUrl =
    "https://github.com/ollama/ollama/releases/download/v1.0.0/test-only.exe";
  manifest.artifact.sha256 = manifest.verification.artifactSha256 = sha256(
    Buffer.from("TEST ONLY artifact"),
  );
  manifest.app.licenseSpdx = "MIT";
  manifest.app.screenshots = [
    "https://github.com/ollama/ollama/raw/main/docs/test-only.png",
  ];
  manifest.app.verifiedAt =
    manifest.release.approvedAt =
    manifest.verification.testDate =
      date;
  const editorial = structuredClone(seed);
  editorial.setupNotes = "Test-only clean-machine setup completed.";
  editorial.updateNotes = "Test-only update and rollback reviewed.";
  editorial.uninstallNotes = "Test-only uninstall and retained data reviewed.";
  editorial.license.notes =
    "Test-only redistribution and dependency notices reviewed.";
  editorial.distribution = {
    capability: "standalone",
    notes: "Test-only standalone distribution reviewed.",
  };
  for (const key of Object.keys(
    editorial.requirements,
  ) as (keyof typeof editorial.requirements)[])
    editorial.requirements[key] =
      "Test-only complete disclosure; exact requirement reviewed.";
  editorial.proposedPackageType = manifest.artifact.adapter;
  editorial.screenshots = [
    {
      url: manifest.app.screenshots[0]!,
      alt: "Test-only screenshot",
      credit: "Test author",
      sourceUrl: seed.sourceUrl,
    },
  ];
  editorial.review.reviewedAt = date;
  editorial.research = [{ url: seed.sourceUrl, accessedAt: date }];
  const presentation: Publication = {
    appId: "ollama",
    version: manifest.release.version,
    artifactSha256: manifest.artifact.sha256,
    editorial,
    distribution: {
      capability: "standalone",
      notes: editorial.distribution.notes,
      reviewedAt: date,
    },
    evidencePath: "evidence.bin",
  };
  change?.(presentation, manifest);
  const presentationBytes = Buffer.from(JSON.stringify(presentation));
  const evidenceBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      websitePresentationSha256: sha256(presentationBytes),
      independentUseResult:
        presentation.distribution.capability === "standalone"
          ? "passed-without-repoready"
          : "requires-repoready",
      reviewer: "TEST ONLY",
      reviewedAt: date,
      checklistNotes: "TEST ONLY reviewed install, task, update and uninstall",
    }),
  );
  manifest.verification.evidenceSha256 = sha256(evidenceBytes);
  const detailBytes = Buffer.from(JSON.stringify(manifest));
  const index: Index = {
    schemaVersion: 1,
    channel: "stable",
    sequence: 1,
    issuedAt: date,
    expiresAt: "2026-10-20T12:00:00Z",
    details: [
      {
        appId: presentation.appId,
        version: presentation.version,
        sha256: sha256(detailBytes),
      },
    ],
    holds: [],
  };
  return { presentationBytes, evidenceBytes, detailBytes, index };
}
function run(
  entry: ReturnType<typeof fixture>,
  patch?: Partial<Parameters<typeof authenticatePublications>[0]>,
) {
  const payload = Buffer.from(JSON.stringify(entry.index));
  const envelopeBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      keyId: "test-only",
      payload: payload.toString("base64"),
      signature: sign(
        null,
        Buffer.concat([DOMAIN, payload]),
        privateKey,
      ).toString("hex"),
    }),
  );
  return authenticatePublications({
    envelopeBytes,
    pinnedKeys: new Map([["test-only", publicKey]]),
    now,
    trustState: { highestSequence: 0, acceptedDigest: null },
    entries: [entry],
    ...patch,
  });
}
test("only authenticated version-bound standalone evidence issues a direct URL, without any client", () => {
  const [release] = run(fixture());
  assert.equal(release!.presentation.distribution.capability, "standalone");
  assert.match(release!.downloadUrl!, /^https:/);
  assert.equal(release!.held, false);
});
test("signed holds retain descriptive publications and suppress links; expired and unknown authority fail", () => {
  const held = fixture();
  held.index.holds = [
    {
      appId: "ollama",
      version: "1.0.0",
      status: "paused",
      reason: "Test-only hold",
    },
  ];
  assert.equal(run(held)[0]!.downloadUrl, null);
  assert.equal(run(held)[0]!.held, true);
  assert.throws(() => run(fixture(), { pinnedKeys: new Map() }), /Unknown key/);
  assert.throws(
    () => run(fixture(), { now: Date.parse("2026-10-21T00:00:00Z") }),
    /Stale/,
  );
});
test("publication rejects disclosure omissions, placeholder artifacts, unknown adapters and date errors", () => {
  const edits: ((p: Publication, m: Manifest) => void)[] = [
    (p) => {
      p.editorial.screenshots = [];
    },
    (p) => {
      p.editorial.requirements.apiCharges = "";
    },
    (p) => {
      p.editorial.license.spdx = null;
    },
    (p) => {
      p.artifactSha256 = sha256(Buffer.from("wrong"));
    },
    (p) => {
      p.editorial.requirements.disk = "Unknown";
    },
    (p) => {
      p.distribution.reviewedAt = "2027-01-01T00:00:00Z";
    },
    (_, m) => {
      m.artifact.downloadUrl = "https://example.com/app.exe";
    },
    (_, m) => {
      m.artifact.downloadUrl =
        "https://github.com/ollama/ollama/releases/latest/download/app.exe";
    },
    (p) => {
      p.editorial.requirements.disk = "TBD";
    },
    (p) => {
      p.editorial.upstreamAuthor = "Someone else";
    },
    (p) => {
      p.editorial.setupNotes = "Unknown";
    },
    (p) => {
      p.editorial.distribution.capability = "requires-repoready";
    },
    (p, m) => {
      p.artifactSha256 =
        m.artifact.sha256 =
        m.verification.artifactSha256 =
          "0".repeat(64);
    },
    (_, m) => {
      m.artifact.adapter = "not-an-adapter" as Manifest["artifact"]["adapter"];
    },
    (_, m) => {
      m.verification.testDate = "2026-10-15T00:00:00Z";
    },
  ];
  for (const edit of edits)
    assert.throws(() => run(fixture(edit)), /approved\[0\]/);
});
test("substitution of presentation, evidence or detail cannot bypass signed digest chain", () => {
  for (const field of [
    "presentationBytes",
    "evidenceBytes",
    "detailBytes",
  ] as const) {
    const entry = fixture();
    entry[field] = Buffer.concat([entry[field], Buffer.from(" ")]);
    assert.throws(() => run(entry), /digest/);
  }
  const mismatch = fixture();
  const evidence = JSON.parse(mismatch.evidenceBytes.toString()) as {
    independentUseResult: string;
  };
  evidence.independentUseResult = "requires-repoready";
  mismatch.evidenceBytes = Buffer.from(JSON.stringify(evidence));
  const manifest = JSON.parse(mismatch.detailBytes.toString()) as Manifest;
  manifest.verification.evidenceSha256 = sha256(mismatch.evidenceBytes);
  mismatch.detailBytes = Buffer.from(JSON.stringify(manifest));
  mismatch.index.details[0]!.sha256 = sha256(mismatch.detailBytes);
  assert.throws(() => run(mismatch), /independent-use/);
});
test("filesystem loader accepts empty approvals and fails closed for incomplete approval files", () => {
  const directory = mkdtempSync(join(tmpdir(), "repoready-m1-"));
  try {
    assert.equal(loadCatalog(directory).releases.length, 0);
    mkdirSync(join(directory, "catalog", "apps"), { recursive: true });
    writeFileSync(join(directory, "catalog", "apps", ".gitkeep"), "");
    assert.equal(loadCatalog(directory).releases.length, 0);
    writeFileSync(
      join(directory, "catalog", "apps", "README.md"),
      "Local documentation only.",
    );
    assert.equal(loadCatalog(directory).releases.length, 0);
    writeFileSync(join(directory, "catalog", "apps", "artifact.json"), "{}");
    assert.throws(() => loadCatalog(directory), /every release/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("filesystem loader authenticates reviewed files and rejects conflicting draft identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "repoready-m1-approved-"));
  try {
    const entry = fixture();
    // Real-time freshness for the build-time loader, while certification stays in the past.
    entry.index.issuedAt = new Date(Date.now() - 60000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    entry.index.expiresAt = new Date(Date.now() + 86400000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const payload = Buffer.from(JSON.stringify(entry.index));
    const catalog = join(directory, "catalog");
    const release = join(catalog, "apps", "ollama", "1.0.0");
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, "presentation.json"), entry.presentationBytes);
    writeFileSync(join(release, "manifest.json"), entry.detailBytes);
    writeFileSync(join(release, "evidence.bin"), entry.evidenceBytes);
    writeFileSync(
      join(catalog, "index.json"),
      JSON.stringify({
        schemaVersion: 1,
        keyId: "test-only",
        payload: payload.toString("base64"),
        signature: sign(
          null,
          Buffer.concat([DOMAIN, payload]),
          privateKey,
        ).toString("hex"),
      }),
    );
    writeFileSync(
      join(catalog, "trust-roots.json"),
      JSON.stringify({
        schemaVersion: 1,
        keys: [
          {
            id: "test-only",
            publicKeyPem: publicKey
              .export({ format: "pem", type: "spki" })
              .toString(),
          },
        ],
      }),
    );
    assert.equal(loadCatalog(directory).releases.length, 1);
    mkdirSync(join(catalog, "candidates"));
    writeFileSync(
      join(catalog, "candidates", "ollama.json"),
      JSON.stringify(seed),
    );
    assert.throws(
      () => loadCatalog(directory),
      /duplicate candidate\/approved/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
