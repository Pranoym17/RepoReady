import { invoke, isTauri } from "@tauri-apps/api/core";
import { DesktopSnapshot, type DesktopPreferences } from "@repoready/contracts";

export const nativeAvailable = isTauri();
export type Snapshot = ReturnType<typeof DesktopSnapshot.parse>;
export type SnapshotCommand =
  | "desktop_state"
  | "catalog_refresh"
  | "preferences_save"
  | "catalog_cache_clear"
  | "client_update_check"
  | "client_update_install"
  | "diagnostics_clear";
let preview: unknown = {
  version: "0.1.0-alpha.1",
  mode: "development",
  catalog: {
    status: "not-configured",
    issuedAt: null,
    expiresAt: null,
    lastVerifiedAt: null,
    sequence: null,
    items: [],
  },
  library: [],
  preferences: { cacheLimitMb: 64, logRetentionDays: 7 },
  recoveryRequired: false,
  update: {
    status: "not-configured",
    version: null,
    messageCode: "NOT_CONFIGURED",
  },
  diagnostics: { logBytes: 0 },
  capabilities: { manageApps: false, requests: false },
  lastError: null,
};

export async function readSnapshot(
  command: SnapshotCommand,
  preferences?: DesktopPreferences,
): Promise<Snapshot> {
  const result: unknown = nativeAvailable
    ? await invoke(
        command,
        command === "client_update_install"
          ? { consent: true }
          : preferences
            ? { preferences }
            : undefined,
      )
    : preview;
  const parsed = DesktopSnapshot.parse(result);
  if (!nativeAvailable && command === "preferences_save" && preferences) {
    preview = DesktopSnapshot.parse({ ...parsed, preferences });
    return DesktopSnapshot.parse(preview);
  }
  return parsed;
}

export async function openProjectPage(
  page: "request" | "support" | "source" | "privacy",
): Promise<void> {
  if (!nativeAvailable) throw new Error("Native action unavailable");
  await invoke("open_project_page", { page });
}

export async function cancelClientUpdate(): Promise<void> {
  if (!nativeAvailable) throw new Error("Native action unavailable");
  await invoke("client_update_cancel");
}
