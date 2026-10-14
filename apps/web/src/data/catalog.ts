import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCatalog } from "@repoready/catalog-tools/publication";
import type { Candidate } from "@repoready/catalog-tools/editorial";
import { selectWebsiteAction } from "@repoready/catalog-tools/presentation";

// Vite bundles this module into a different directory. Resolve the workspace
// from its checked identity rather than the generated module's import.meta.url.
let root = process.cwd();
while (
  !existsSync(join(root, "catalog", "trust-roots.json")) ||
  !existsSync(join(root, "package.json")) ||
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name !==
    "repoready"
) {
  const parent = dirname(root);
  if (parent === root) throw new Error("RepoReady catalog workspace not found");
  root = parent;
}
// Only the build-time loader joins signed approval and evidence. It is not
// shipped to browsers and never reads candidate records as install manifests.
const catalog = loadCatalog(root);
export const clientRelease = null;

export function getCatalog(): Candidate[] {
  const entries = new Map(
    catalog.candidates.map((candidate) => [candidate.id, candidate]),
  );
  for (const release of catalog.releases)
    entries.set(release.manifest.app.id, release.presentation.editorial);
  return [...entries.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  );
}

export function getAppPresentation(candidate: Candidate) {
  const approved = catalog.releases.find(
    (release) => release.manifest.app.id === candidate.id,
  );
  const release = approved
    ? {
        status: approved.manifest.app.status as
          "ready" | "publisher-installer" | "paused" | "revoked",
        capability: approved.presentation.distribution.capability,
        current: true,
        held: approved.held,
        approval: approved.downloadUrl
          ? {
              appId: approved.manifest.app.id,
              version: approved.manifest.release.version,
              artifactSha256: approved.manifest.artifact.sha256,
              downloadUrl: approved.downloadUrl,
              packagingType: approved.manifest.artifact.adapter,
            }
          : null,
      }
    : null;
  return {
    isCertified: Boolean(approved && !approved.held),
    releaseStatus: approved?.held
      ? "paused"
      : (approved?.manifest.app.status ?? "requested"),
    statusLabel: approved?.held
      ? "Release paused or withdrawn"
      : approved
        ? release?.status === "publisher-installer"
          ? "Official installer — Publisher supplied"
          : "Ready — Tested by RepoReady"
        : "Candidate draft — not tested",
    action: selectWebsiteAction({
      appId: candidate.id,
      candidate: !approved,
      release,
      client: clientRelease,
    }),
    distributionLabel: approved
      ? release?.capability === "standalone"
        ? "No RepoReady client required"
        : "Requires the RepoReady desktop app"
      : "Distribution requirements not certified by RepoReady",
    distributionNotes:
      approved?.presentation.distribution.notes ?? candidate.distribution.notes,
    version: approved?.manifest.release.version ?? null,
    testedAt: approved?.manifest.verification.testDate ?? null,
    releaseDetails: approved
      ? {
          downloadBytes: approved.manifest.artifact.sizeBytes,
          minWindowsBuild: approved.manifest.app.requirements.minWindowsBuild,
          minRamMb: approved.manifest.app.requirements.minRamMb,
          diskMb: approved.manifest.app.requirements.diskMb,
          extraDownloadBytes:
            approved.manifest.app.requirements.extraDownloadBytes,
          requiredPrivileges: approved.manifest.artifact.requiredPrivileges,
          apiProviders: approved.manifest.app.requirements.externalApiProviders,
        }
      : null,
  };
}
