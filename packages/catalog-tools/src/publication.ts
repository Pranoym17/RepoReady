import { createPublicKey, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  Id,
  Sha256,
  Timestamp,
  Version,
  validateManifest,
} from "@repoready/contracts";
import {
  CandidateSchema,
  PlainText,
  SafeUrl,
  validateCandidates,
} from "./editorial.js";
import {
  sha256,
  verifyCatalog,
  verifyDetail,
  type TrustState,
} from "./index.js";

export const PublicationSchema = z.strictObject({
  appId: Id,
  version: Version,
  artifactSha256: Sha256,
  editorial: CandidateSchema,
  distribution: z.strictObject({
    capability: z.enum(["standalone", "requires-repoready"]),
    notes: PlainText,
    reviewedAt: Timestamp,
  }),
  evidencePath: z.literal("evidence.bin"),
});
export type Publication = z.infer<typeof PublicationSchema>;
export type ApprovedPublication = {
  manifest: ReturnType<typeof validateManifest>;
  presentation: Publication;
  downloadUrl: string | null;
  held: boolean;
};
export type PublicationEntry = {
  presentationBytes: Uint8Array;
  detailBytes: Uint8Array;
  evidenceBytes: Uint8Array;
};
const EvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  websitePresentationSha256: Sha256,
  independentUseResult: z.enum([
    "passed-without-repoready",
    "requires-repoready",
  ]),
  reviewer: PlainText,
  reviewedAt: Timestamp,
  checklistNotes: PlainText,
});
const json = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
function realHash(value: string, field: string) {
  if (/^([a-f0-9])\1{63}$/.test(value) || /^(0123456789abcdef){4}$/.test(value))
    throw new Error(`${field}: placeholder digest`);
}
function realUrl(value: string, field: string) {
  SafeUrl.parse(value);
  const host = new URL(value).hostname;
  if (
    /(^|\.)(example\.(com|org|net)|invalid|test|localhost)$/.test(host) ||
    /placeholder|todo|replace-me/i.test(value) ||
    /\/latest(?:\/|$|\?)/i.test(new URL(value).pathname)
  )
    throw new Error(`${field}: placeholder or mutable URL`);
}
export function authenticatePublications(options: {
  envelopeBytes: Uint8Array;
  pinnedKeys: ReadonlyMap<string, KeyObject>;
  now: number;
  trustState: TrustState;
  entries: PublicationEntry[];
}): ApprovedPublication[] {
  const { index } = verifyCatalog(
    options.envelopeBytes,
    options.pinnedKeys,
    options.now,
    options.trustState,
  );
  const identities = new Set<string>();
  const slugs = new Set<string>();
  const appIds = new Set<string>();
  const results: ApprovedPublication[] = [];
  for (const [position, entry] of options.entries.entries()) {
    try {
      const parsed = PublicationSchema.safeParse(json(entry.presentationBytes));
      if (!parsed.success)
        throw new Error(
          parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        );
      const presentation = parsed.data;
      const identity = `${presentation.appId}/${presentation.version}`;
      if (identities.has(identity))
        throw new Error("appId/version: duplicate release");
      if (slugs.has(presentation.editorial.slug))
        throw new Error("editorial.slug: duplicate approved slug");
      if (appIds.has(presentation.appId))
        throw new Error(
          "appId: only one selected approved release per app is supported",
        );
      identities.add(identity);
      slugs.add(presentation.editorial.slug);
      appIds.add(presentation.appId);
      // Validate all disclosure and evidence data even when a signed hold suppresses its link.
      const manifest = validateManifest(json(entry.detailBytes));
      const reference = index.details.find(
        (detail) =>
          detail.appId === presentation.appId &&
          detail.version === presentation.version,
      );
      if (!reference || reference.sha256 !== sha256(entry.detailBytes))
        throw new Error("detail: signed reference missing or digest mismatch");
      if (
        manifest.app.id !== presentation.appId ||
        manifest.release.version !== presentation.version ||
        manifest.artifact.sha256 !== presentation.artifactSha256 ||
        presentation.editorial.id !== presentation.appId ||
        presentation.editorial.slug !== manifest.app.slug
      )
        throw new Error(
          "appId/version/artifactSha256: presentation identity mismatch",
        );
      if (
        manifest.app.name !== presentation.editorial.name ||
        manifest.app.sourceUrl !== presentation.editorial.sourceUrl ||
        manifest.app.upstreamAuthor !== presentation.editorial.upstreamAuthor
      )
        throw new Error("editorial: signed source/name/author mismatch");
      const evidence = EvidenceSchema.parse(json(entry.evidenceBytes));
      if (
        sha256(entry.evidenceBytes) !== manifest.verification.evidenceSha256 ||
        evidence.websitePresentationSha256 !== sha256(entry.presentationBytes)
      )
        throw new Error(
          "evidence: certification or exact presentation digest mismatch",
        );
      if (
        (presentation.distribution.capability === "standalone") !==
        (evidence.independentUseResult === "passed-without-repoready")
      )
        throw new Error(
          "distribution.capability: independent-use evidence mismatch",
        );
      const dates = [
        manifest.verification.testDate,
        manifest.app.verifiedAt!,
        manifest.release.approvedAt,
        presentation.distribution.reviewedAt,
        evidence.reviewedAt,
        presentation.editorial.review.reviewedAt,
        ...presentation.editorial.research.map((record) => record.accessedAt),
      ];
      if (
        dates.some((date) => Date.parse(date) > options.now) ||
        Date.parse(manifest.verification.testDate) >
          Date.parse(manifest.release.approvedAt) ||
        Date.parse(manifest.app.verifiedAt!) <
          Date.parse(manifest.verification.testDate) ||
        Date.parse(evidence.reviewedAt) >
          Date.parse(manifest.release.approvedAt) ||
        Date.parse(presentation.distribution.reviewedAt) >
          Date.parse(manifest.release.approvedAt)
      )
        throw new Error("dates: future or inconsistent certification date");
      for (const [field, digest] of Object.entries({
        artifactSha256: manifest.artifact.sha256,
        evidenceSha256: manifest.verification.evidenceSha256,
        detailSha256: reference.sha256,
      }))
        realHash(digest, field);
      for (const [field, url] of Object.entries({
        downloadUrl: manifest.artifact.downloadUrl,
        supportUrl: manifest.app.supportUrl,
        sourceUrl: presentation.editorial.sourceUrl,
        licenseEvidenceUrl: presentation.editorial.license.evidenceUrl,
      }))
        realUrl(url, field);
      for (const shot of presentation.editorial.screenshots) {
        realUrl(shot.url, "screenshots.url");
        realUrl(shot.sourceUrl, "screenshots.sourceUrl");
      }
      for (const research of presentation.editorial.research)
        realUrl(research.url, "research.url");
      if (
        !presentation.editorial.screenshots.length ||
        !manifest.app.screenshots.length
      )
        throw new Error("screenshots: reviewed media required for publication");
      if (
        manifest.app.screenshots.some(
          (url) =>
            !presentation.editorial.screenshots.some(
              (shot) => shot.url === url,
            ),
        )
      )
        throw new Error(
          "screenshots: signed media missing reviewed provenance",
        );
      if (
        !presentation.editorial.license.spdx ||
        presentation.editorial.license.spdx !== manifest.app.licenseSpdx
      )
        throw new Error("license.spdx: reviewed license mismatch");
      if (
        presentation.editorial.proposedPackageType !== manifest.artifact.adapter
      )
        throw new Error(
          "proposedPackageType: approved adapter disclosure mismatch",
        );
      if (
        Object.values(presentation.editorial.requirements).some((value) =>
          /\bunknown\b|not (measured|tested|selected|reviewed|verified)|await.*review|\b(TBD|TBC|pending)\b|to be determined/i.test(
            value,
          ),
        )
      )
        throw new Error("requirements: unresolved release disclosure");
      const unresolved =
        /\bunknown\b|not (measured|tested|selected|reviewed|verified)|await.*review|\b(TBD|TBC|pending)\b|to be determined/i;
      for (const [field, value] of Object.entries({
        setupNotes: presentation.editorial.setupNotes,
        updateNotes: presentation.editorial.updateNotes,
        uninstallNotes: presentation.editorial.uninstallNotes,
        "license.notes": presentation.editorial.license.notes,
        "distribution.notes": presentation.distribution.notes,
      })) {
        if (unresolved.test(value))
          throw new Error(`${field}: unresolved release disclosure`);
      }
      if (
        presentation.editorial.distribution.capability !==
          presentation.distribution.capability ||
        presentation.editorial.distribution.notes !==
          presentation.distribution.notes
      )
        throw new Error(
          "distribution.capability: conflicting editorial and approved capability",
        );
      const held = index.holds.some(
        (hold) =>
          hold.appId === presentation.appId &&
          hold.version === presentation.version,
      );
      if (!held)
        verifyDetail(
          index,
          presentation.appId,
          presentation.version,
          entry.detailBytes,
        );
      results.push({
        manifest,
        presentation,
        downloadUrl: held ? null : manifest.artifact.downloadUrl,
        held,
      });
    } catch (error) {
      throw new Error(
        `approved[${position}]: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const reference of index.details)
    if (!identities.has(`${reference.appId}/${reference.version}`))
      throw new Error(
        `approved ${reference.appId}/${reference.version}: missing publication files`,
      );
  return results;
}

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(join(directory, entry.name))
        : [join(directory, entry.name)],
    )
    .sort();
}
export function loadCatalog(root: string) {
  const candidateFiles = files(join(root, "catalog", "candidates"));
  const candidates = validateCandidates(
    candidateFiles.map((file) => {
      if (!file.endsWith(".json"))
        throw new Error(`candidate ${file}: unsupported file`);
      try {
        return JSON.parse(readFileSync(file, "utf8")) as unknown;
      } catch (error) {
        throw new Error(`candidate ${file}: ${String(error)}`);
      }
    }),
  );
  const appFiles = files(join(root, "catalog", "apps")).filter(
    (file) => !file.toLowerCase().endsWith(".md"),
  );
  if (!appFiles.length)
    return { candidates, releases: [] as ApprovedPublication[] };
  const presentations = appFiles.filter((file) =>
    file.endsWith("presentation.json"),
  );
  if (!presentations.length || appFiles.length !== presentations.length * 3)
    throw new Error(
      "catalog/apps: every release needs only presentation.json, manifest.json and evidence.bin",
    );
  const roots = z
    .strictObject({
      schemaVersion: z.literal(1),
      keys: z.array(
        z.strictObject({ id: Id, publicKeyPem: z.string().min(1) }),
      ),
    })
    .parse(
      JSON.parse(
        readFileSync(join(root, "catalog", "trust-roots.json"), "utf8"),
      ),
    );
  if (new Set(roots.keys.map((key) => key.id)).size !== roots.keys.length)
    throw new Error("trust-roots.keys: duplicate key id");
  const keys = new Map(
    roots.keys.map((key) => [key.id, createPublicKey(key.publicKeyPem)]),
  );
  const releases = authenticatePublications({
    envelopeBytes: readFileSync(join(root, "catalog", "index.json")),
    pinnedKeys: keys,
    now: Date.now(),
    trustState: { highestSequence: 0, acceptedDigest: null },
    entries: presentations.map((file) => {
      const directory = file.slice(0, -"presentation.json".length);
      return {
        presentationBytes: readFileSync(file),
        detailBytes: readFileSync(join(directory, "manifest.json")),
        evidenceBytes: readFileSync(join(directory, "evidence.bin")),
      };
    }),
  });
  const all = [
    ...candidates.map((candidate) => ({
      id: candidate.id,
      slug: candidate.slug,
    })),
    ...releases.map((release) => ({
      id: release.presentation.appId,
      slug: release.presentation.editorial.slug,
    })),
  ];
  if (
    new Set(all.map((record) => record.id)).size !== all.length ||
    new Set(all.map((record) => record.slug)).size !== all.length
  )
    throw new Error("catalog: duplicate candidate/approved id or slug");
  return { candidates, releases };
}
export function lintCatalog(root: string) {
  return loadCatalog(root);
}
