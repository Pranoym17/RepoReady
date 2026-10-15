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
    "RepoReady could not safely read its local state. No application action was performed. Try again or open support.",
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
} as const;
