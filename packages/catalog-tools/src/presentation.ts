import { Adapter, HttpsUrl, Sha256, Version } from "@repoready/contracts";

export type WebsiteRelease = {
  status: "ready" | "publisher-installer" | "paused" | "revoked";
  capability: "standalone" | "requires-repoready";
  current: boolean;
  held: boolean;
  approval: {
    appId: string;
    version: string;
    artifactSha256: string;
    downloadUrl: string;
    packagingType: string;
  } | null;
};
export type ClientRelease = {
  downloadUrl: string;
  version: string;
  sha256: string;
  tested: boolean;
} | null;
export type WebsiteAction = {
  label: string;
  href: string | null;
  notice: string;
};

// Presentation is not authorization: the production loader must authenticate
// releases and their evidence before supplying an approval to this selector.
export function safeReleaseUrl(input: string): boolean {
  if (!HttpsUrl.safeParse(input).success) return false;
  const url = new URL(input);
  return (
    !url.username &&
    !url.password &&
    !/^(localhost|127\.|0\.|\[|.*\.(?:local|invalid|test|example))/.test(
      url.hostname,
    ) &&
    !/(^|\.)example\.(com|org|net)$/.test(url.hostname) &&
    !/(?:\/latest(?:\/|$)|placeholder|changeme|todo)/i.test(url.pathname)
  );
}

export function clientDownload(release: ClientRelease): string | null {
  return release?.tested &&
    Version.safeParse(release.version).success &&
    Sha256.safeParse(release.sha256).success &&
    !/^([a-f0-9])\1{63}$/.test(release.sha256) &&
    safeReleaseUrl(release.downloadUrl)
    ? release.downloadUrl
    : null;
}

export function selectWebsiteAction(input: {
  appId: string;
  candidate: boolean;
  release: WebsiteRelease | null;
  client: ClientRelease;
  requestsAvailable?: boolean;
}): WebsiteAction {
  const { release } = input;
  if (
    release?.held ||
    release?.status === "paused" ||
    release?.status === "revoked"
  )
    return {
      label: "Download unavailable",
      href: null,
      notice: "This release is paused or withdrawn. Downloads are unavailable.",
    };
  if (input.candidate)
    return {
      label: input.requestsAvailable
        ? "Request packaging"
        : "About packaging requests",
      href: "/request/",
      notice:
        "Candidate draft — not tested by RepoReady. No installer is available here.",
    };
  const approval = release?.approval;
  if (
    !release?.current ||
    !approval ||
    approval.appId !== input.appId ||
    !Version.safeParse(approval.version).success ||
    !Sha256.safeParse(approval.artifactSha256).success ||
    /^([a-f0-9])\1{63}$/.test(approval.artifactSha256) ||
    !Adapter.safeParse(approval.packagingType).success ||
    !safeReleaseUrl(approval.downloadUrl) ||
    (release.status === "publisher-installer") !==
      approval.packagingType.startsWith("publisher-")
  )
    return {
      label: "Download unavailable",
      href: null,
      notice: "No current approved distribution is available.",
    };
  if (release.capability === "standalone")
    return {
      label:
        release.status === "publisher-installer"
          ? "Download publisher installer"
          : "Download standalone installer",
      href: approval.downloadUrl,
      notice:
        "No RepoReady client required. Follow the application's own setup, update and uninstall instructions.",
    };
  if (release.capability !== "requires-repoready")
    return {
      label: "Download unavailable",
      href: null,
      notice: "The distribution requirement has not been reviewed.",
    };
  const download = clientDownload(input.client);
  return {
    label: download
      ? "Get RepoReady to install"
      : "RepoReady is not available yet",
    href: download,
    notice:
      "Requires the RepoReady desktop app and its managed runtime. This application cannot be installed independently from this package.",
  };
}
