import { fileURLToPath } from "node:url";
import { loadCatalog } from "@repoready/catalog-tools/publication";
import type { Candidate } from "@repoready/catalog-tools/editorial";
import { selectWebsiteAction } from "@repoready/catalog-tools/presentation";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
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
    version: approved?.manifest.release.version ?? null,
    testedAt: approved?.manifest.verification.testDate ?? null,
  };
}
