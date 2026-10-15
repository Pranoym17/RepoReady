export const text = {
  product: "RepoReady",
  tagline: "Good software. A clearer starting point.",
  nav: {
    discover: "Discover",
    detail: "App details",
    library: "Library",
    request: "Request a project",
    settings: "Settings",
  },
  preview:
    "Browser preview — native storage and operating-system actions are unavailable. Preferences last only for this session.",
  loading: "Reading local state…",
  bridgeError:
    "RepoReady could not safely read its local state. Try again or open support. If you started an update, check its status before trying again.",
  renderErrorTitle: "RepoReady needs to reload",
  renderError:
    "The interface could not finish displaying this screen. Reload the client to read its saved state again. If you started an update, check its status before trying again.",
  working: "Working…",
  recovery:
    "Local recovery is required. Application management is unavailable. Keep your data and contact support before continuing.",
  draft: "Candidate draft — not tested",
  draftNotice:
    "This is research content, not a certified RepoReady release. No installer is available for this candidate.",
  management:
    "Application installation, launch, update, repair, and uninstall are not available in this development release.",
  standalone:
    "Approved standalone apps can also be downloaded from the website without installing RepoReady. Managed-runtime apps will clearly disclose the desktop requirement.",
  search: "Search by name, use case, or tag",
  noResults: "No applications match. Try fewer words or another category.",
  catalog: {
    "not-configured":
      "Verified catalog is not configured. Research previews remain available.",
    fresh: "Verified catalog is current.",
    stale:
      "Cached catalog has expired. Descriptions are for reference; application actions are unavailable.",
    offline:
      "You are offline. Cached descriptions may be out of date; application actions are unavailable.",
    error:
      "Catalog refresh failed. Only previously verified descriptions may be shown.",
  },
  libraryEmpty: "Your library is empty",
  libraryHelp:
    "Applications will appear here after a supported installation. Browsing a candidate never adds it to your library.",
  requestNotice:
    "Request intake is not available in this release. Nothing entered here is sent, saved, or queued.",
  settingsSaved: "Preferences saved.",
  previewSaved: "Preview preferences changed for this session only.",
  preferenceError:
    "Choose a cache limit from 16 to 512 MB and log retention from 1 to 30 days, using whole numbers.",
  updateConfirm:
    "Install the approved RepoReady client update? Application management remains unavailable.",
  updateConsent:
    "This changes the RepoReady client. Confirm only when you are ready to install the approved update.",
  updateInProgress: "Preparing the approved client update…",
  updateCancellation:
    "Cancellation can stop the download before the installer starts. It cannot undo an installation that has already started.",
  updateCancelRequested:
    "Cancellation requested. Waiting for the native update operation to finish.",
  updateCancelFailed:
    "Cancellation could not be requested. Keep the client open while the update operation finishes.",
  updateDidNotComplete:
    "The client update did not complete. Check its status before trying again. A cancellation request does not undo an installer that has already started.",
} as const;

export const errorGuidance: Record<string, string> = {
  INVALID_INPUT: "Check the values you entered and try again.",
  NOT_AVAILABLE:
    "This feature is not available in this release. Your saved data is kept.",
  UNTRUSTED_CATALOG:
    "RepoReady could not verify the catalog. Check your connection and computer clock, then refresh. Your library is kept.",
  STALE_CATALOG:
    "The catalog has expired. Refresh it before using release information.",
  INCOMPATIBLE:
    "This release does not support this computer. Review its compatibility details.",
  INSUFFICIENT_DISK:
    "There is not enough free disk space. Free some space and try again.",
  DOWNLOAD_FAILED:
    "The client update could not be checked or downloaded. Check the update status and connection before trying again.",
  HASH_MISMATCH:
    "The downloaded file could not be verified. Do not run it. Check for a new approved download.",
  INSTALL_FAILED:
    "The client update did not complete as expected. Check the installed version and update status before trying again.",
  RECOVERY_REQUIRED:
    "Keep your saved data and contact support for recovery before trying this operation again.",
  CREDENTIAL_FAILED:
    "The credential could not be used. Review its setup without sharing the key with support.",
  RATE_LIMITED: "Too many requests were made. Wait and try again later.",
  INTERNAL_ERROR:
    "RepoReady could not complete this operation. Reload and check its status, or open support.",
};
export function explainError(code: string): string {
  return errorGuidance[code] ?? errorGuidance.INTERNAL_ERROR!;
}
