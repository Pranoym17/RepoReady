import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { DesktopPreferences } from "@repoready/contracts";
import {
  searchCatalog,
  catalogCategories,
} from "../../../packages/catalog-tools/src/search";
import { entriesFor, type Entry } from "./catalog";
import {
  nativeAvailable,
  cancelClientUpdate,
  openProjectPage,
  readSnapshot,
  type Snapshot,
  type SnapshotCommand,
} from "./bridge";
import { text } from "./strings";

type Screen = keyof typeof text.nav;
const statusLabels: Record<string, string> = {
  ready: "Ready — tested by RepoReady",
  "publisher-installer": "Official publisher installer",
  requested: "Requested",
  unavailable: "Unavailable",
  paused: "Paused",
  revoked: "Withdrawn",
};
export function App() {
  const [screen, setScreen] = useState<Screen>("discover");
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [updateConsent, setUpdateConsent] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string>(
    text.updateInProgress,
  );
  const main = useRef<HTMLElement>(null);
  const initialNavigation = useRef(true);

  async function command(
    name: SnapshotCommand,
    preferences?: { cacheLimitMb: number; logRetentionDays: number },
  ) {
    setPending(true);
    setError(false);
    setNotice("");
    try {
      const next = await readSnapshot(name, preferences);
      setSnapshot(next);
      return next;
    } catch {
      setError(true);
      return null;
    } finally {
      setPending(false);
    }
  }
  async function installClientUpdate() {
    setUpdateConsent(false);
    setPending(true);
    setInstallingUpdate(true);
    setCancelRequested(false);
    setUpdateMessage(text.updateInProgress);
    setError(false);
    setNotice("");
    try {
      setSnapshot(await readSnapshot("client_update_install"));
    } catch {
      setNotice(text.updateDidNotComplete);
    } finally {
      setInstallingUpdate(false);
      setPending(false);
    }
  }
  async function cancelUpdate() {
    setCancelRequested(true);
    try {
      await cancelClientUpdate();
      setUpdateMessage(text.updateCancelRequested);
    } catch {
      setUpdateMessage(text.updateCancelFailed);
      setCancelRequested(false);
    }
  }
  useEffect(() => {
    void command("desktop_state");
  }, []);
  useEffect(() => {
    if (initialNavigation.current) {
      initialNavigation.current = false;
      return;
    }
    main.current?.focus();
  }, [screen, selected]);
  const entries = useMemo(() => entriesFor(snapshot), [snapshot]);
  const filtered = useMemo(
    () => searchCatalog(entries, query, category),
    [entries, query, category],
  );
  const app = entries.find((entry) => entry.id === selected);
  function navigate(next: Screen) {
    setScreen(next);
    setNotice("");
  }
  async function external(page: "request" | "support" | "source" | "privacy") {
    setNotice("");
    try {
      await openProjectPage(page);
    } catch {
      setNotice(
        nativeAvailable
          ? "The project page could not be opened. Try again later."
          : "External project pages can be opened from the native app. Browser preview does not open operating-system links.",
      );
    }
  }
  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const preferences = DesktopPreferences.safeParse({
      cacheLimitMb: Number(values.get("cacheLimitMb")),
      logRetentionDays: Number(values.get("logRetentionDays")),
    });
    if (!preferences.success) {
      setNotice(text.preferenceError);
      return;
    }
    if (await command("preferences_save", preferences.data))
      setNotice(nativeAvailable ? text.settingsSaved : text.previewSaved);
  }
  return (
    <div className="desktop-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Application navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            R
          </span>
          <span>
            {text.product}
            <small>Development edition</small>
          </span>
        </div>
        <nav aria-label="Main">
          <ul>
            {(["discover", "library", "request", "settings"] as const).map(
              (item) => (
                <li key={item}>
                  <button
                    aria-current={
                      screen === item ||
                      (screen === "detail" && item === "discover")
                        ? "page"
                        : undefined
                    }
                    onClick={() => navigate(item)}
                  >
                    <span aria-hidden="true">
                      {
                        {
                          discover: "◈",
                          library: "▤",
                          request: "＋",
                          settings: "⚙",
                        }[item]
                      }
                    </span>
                    {text.nav[item]}
                  </button>
                </li>
              ),
            )}
          </ul>
        </nav>
        <div className="sidebar-bottom">
          <p>{text.tagline}</p>
          <span className="badge">
            {snapshot?.version ?? "Development build"}
          </span>
          <button
            className="text-button"
            onClick={() => void external("support")}
          >
            Support
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>{text.nav[screen]}</span>
          <span className="muted">
            {snapshot?.mode === "stable"
              ? "Stable channel"
              : "Development channel"}
          </span>
        </header>
        <main id="main" ref={main} tabIndex={-1} aria-busy={pending}>
          {!nativeAvailable && (
            <div className="preview-banner">{text.preview}</div>
          )}
          {snapshot?.recoveryRequired && (
            <div className="alert" role="alert">
              {text.recovery}
            </div>
          )}
          {error && (
            <div className="alert" role="alert">
              <p>{text.bridgeError}</p>
              <button
                onClick={() => void command("desktop_state")}
                disabled={pending}
              >
                Try again
              </button>
            </div>
          )}
          {snapshot?.lastError && (
            <div className="alert" role="alert">
              A local operation could not finish safely. Reference:{" "}
              {snapshot.lastError.code}. The operation could not be completed.
            </div>
          )}
          <div className="operation-status" role="status" aria-live="polite">
            {installingUpdate ? updateMessage : pending ? text.working : notice}
          </div>
          {installingUpdate && (
            <section
              className="catalog-banner"
              aria-label="Client update in progress"
            >
              <p>{text.updateCancellation}</p>
              <button
                className="secondary"
                disabled={cancelRequested}
                onClick={() => void cancelUpdate()}
              >
                {cancelRequested ? "Cancellation requested" : "Cancel download"}
              </button>
            </section>
          )}
          {screen === "discover" && (
            <>
              <div className="page-heading">
                <p className="eyebrow">Find your next useful tool</p>
                <h1>Discover</h1>
                <p>Open-source projects, with the context to choose well.</p>
              </div>
              <div className="catalog-banner">
                <div>
                  <strong>
                    {snapshot
                      ? text.catalog[snapshot.catalog.status]
                      : text.loading}
                  </strong>
                  <p className="muted">
                    {snapshot?.catalog.lastVerifiedAt
                      ? `Last verified ${formatDate(snapshot.catalog.lastVerifiedAt)}${snapshot.catalog.expiresAt ? ` · Expires ${formatDate(snapshot.catalog.expiresAt)}` : ""}`
                      : "No verified catalog has been received."}
                  </p>
                </div>
                <button
                  className="secondary"
                  onClick={() => void command("catalog_refresh")}
                  disabled={pending || !nativeAvailable}
                >
                  Refresh catalog
                </button>
              </div>
              <p className="path-note">{text.standalone}</p>
              <form
                className="searchbar"
                onSubmit={(event) => event.preventDefault()}
              >
                <div className="field search-field">
                  <label htmlFor="search">{text.search}</label>
                  <input
                    id="search"
                    type="search"
                    value={query}
                    maxLength={200}
                    placeholder="Try local AI, notes, or video"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="category">Category</label>
                  <select
                    id="category"
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                  >
                    <option value="">All categories</option>
                    {catalogCategories.map((value) => (
                      <option key={value} value={value}>
                        {value === "ai"
                          ? "AI"
                          : value.charAt(0).toUpperCase() + value.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setCategory("");
                  }}
                >
                  Clear filters
                </button>
              </form>
              <p className="muted" role="status">
                {filtered.length} catalog entries ·{" "}
                {entries.filter((entry) => entry.draft).length} research drafts
              </p>
              {filtered.length ? (
                <div className="app-grid">
                  {filtered.map((entry) => (
                    <article
                      className="app-card"
                      key={entry.id}
                      data-catalog-item
                    >
                      <div className="card-top">
                        <span className="app-monogram" aria-hidden="true">
                          {entry.name.slice(0, 1)}
                        </span>
                        <span className="eyebrow">{entry.category}</span>
                      </div>
                      <h2>
                        <button
                          className="title-button"
                          onClick={() => {
                            setSelected(entry.id);
                            navigate("detail");
                          }}
                        >
                          {entry.name}
                        </button>
                      </h2>
                      <p>{entry.summary}</p>
                      <span className="badge">
                        {entry.draft
                          ? text.draft
                          : statusLabels[entry.verified!.status]}
                      </span>
                      <ul className="tags" aria-label="Tags">
                        {entry.tags.slice(0, 4).map((tag) => (
                          <li key={tag}>{tag}</li>
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <h2>No matches</h2>
                  <p>{text.noResults}</p>
                </div>
              )}
            </>
          )}
          {screen === "detail" &&
            (app ? (
              <Detail
                app={app}
                onBack={() => navigate("discover")}
                onRequest={() => navigate("request")}
              />
            ) : (
              <div className="empty-state">
                <h1>Application not found</h1>
                <button onClick={() => navigate("discover")}>
                  Back to Discover
                </button>
              </div>
            ))}
          {screen === "library" && (
            <>
              <div className="page-heading">
                <p className="eyebrow">Your applications</p>
                <h1>Library</h1>
                <p>{text.management}</p>
              </div>
              {snapshot?.library.length ? (
                <div className="library-list">
                  {snapshot.library.map((item) => (
                    <article className="panel" key={item.appId}>
                      <h2>
                        {entries.find((entry) => entry.id === item.appId)
                          ?.name ?? item.appId}
                      </h2>
                      <dl>
                        <dt>Version</dt>
                        <dd>{item.version}</dd>
                        <dt>Installed</dt>
                        <dd>{formatDate(item.installedAt)}</dd>
                        <dt>Last launch</dt>
                        <dd>
                          {item.lastLaunchAt
                            ? formatDate(item.lastLaunchAt)
                            : "Not recorded"}
                        </dd>
                        <dt>Update status</dt>
                        <dd>{item.updateStatus}</dd>
                        <dt>Source</dt>
                        <dd>{item.sourceSummary}</dd>
                      </dl>
                      <p>
                        Application controls are unavailable in this release.
                      </p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <span className="empty-symbol" aria-hidden="true">
                    ▤
                  </span>
                  <h2>{text.libraryEmpty}</h2>
                  <p>{text.libraryHelp}</p>
                  <button onClick={() => navigate("discover")}>
                    Explore the catalog
                  </button>
                </div>
              )}
            </>
          )}
          {screen === "request" && (
            <>
              <div className="page-heading">
                <p className="eyebrow">Shape what comes next</p>
                <h1>Request a project</h1>
                <p>Useful software starts with a good source.</p>
              </div>
              <section className="panel prose">
                <h2>Requests are not open yet</h2>
                <p>{text.requestNotice}</p>
                <p>
                  We will need a public repository, a distributable license, a
                  clear use case, installation requirements, and privacy and
                  cost disclosures. A request never guarantees packaging or
                  certification.
                </p>
                <p>
                  For now, browse the candidate research and check the project
                  website for intake availability.
                </p>
                <button
                  className="secondary"
                  onClick={() => void external("request")}
                >
                  Open request information
                </button>
              </section>
            </>
          )}
          {screen === "settings" && (
            <>
              <div className="page-heading">
                <p className="eyebrow">Make room for your work</p>
                <h1>Settings</h1>
                <p>Manage this client’s storage, diagnostics, and updates.</p>
              </div>
              {snapshot ? (
                <div className="settings-grid">
                  <section className="panel">
                    <h2>Storage and privacy</h2>
                    <p className="muted">
                      {nativeAvailable
                        ? "Preferences are saved by the native client."
                        : "Preview changes are kept in memory only."}
                    </p>
                    <form
                      className="stack"
                      onSubmit={savePreferences}
                      key={`${snapshot.preferences.cacheLimitMb}/${snapshot.preferences.logRetentionDays}`}
                    >
                      <div className="field">
                        <label htmlFor="cache">Catalog cache limit (MB)</label>
                        <input
                          id="cache"
                          name="cacheLimitMb"
                          type="number"
                          min="16"
                          max="512"
                          step="1"
                          required
                          defaultValue={snapshot.preferences.cacheLimitMb}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="retention">
                          Diagnostic log retention (days)
                        </label>
                        <input
                          id="retention"
                          name="logRetentionDays"
                          type="number"
                          min="1"
                          max="30"
                          step="1"
                          required
                          defaultValue={snapshot.preferences.logRetentionDays}
                        />
                      </div>
                      <button disabled={pending} type="submit">
                        Save preferences
                      </button>
                    </form>
                    <div className="setting-actions">
                      <button
                        className="secondary"
                        disabled={pending || !nativeAvailable}
                        onClick={() => void command("catalog_cache_clear")}
                      >
                        Clear cached catalog
                      </button>
                      <p className="muted">
                        Removes cached catalog descriptions. Installed
                        applications are not removed.
                      </p>
                    </div>
                    <div className="setting-actions">
                      <p>
                        Diagnostic logs:{" "}
                        {snapshot.diagnostics.logBytes.toLocaleString()} bytes
                      </p>
                      <button
                        className="secondary"
                        disabled={pending || !nativeAvailable}
                        onClick={() => void command("diagnostics_clear")}
                      >
                        Clear diagnostic logs
                      </button>
                    </div>
                  </section>
                  <section className="panel">
                    <h2>RepoReady client updates</h2>
                    <p>
                      Version {snapshot.version} · {snapshot.mode} channel
                    </p>
                    <p className="badge">
                      {updateLabel(snapshot.update.status)}
                    </p>
                    <p>
                      {snapshot.update.version
                        ? `Offered version: ${snapshot.update.version}`
                        : "No client update is available."}
                    </p>
                    <p className="muted">
                      Updates for catalog applications are separate and
                      unavailable in this release.
                    </p>
                    <button
                      className="secondary"
                      disabled={pending || !nativeAvailable}
                      onClick={() => void command("client_update_check")}
                    >
                      Check for client updates
                    </button>
                    {snapshot.update.status === "available" &&
                      nativeAvailable &&
                      !snapshot.recoveryRequired && (
                        <button
                          onClick={() => setUpdateConsent(true)}
                          disabled={pending}
                        >
                          Review client update
                        </button>
                      )}
                  </section>
                  <section className="panel">
                    <h2>About and support</h2>
                    <p>
                      No application credentials or API keys are collected here.
                    </p>
                    <div className="button-row">
                      <button
                        className="secondary"
                        onClick={() => void external("privacy")}
                      >
                        Privacy information
                      </button>
                      <button
                        className="secondary"
                        onClick={() => void external("source")}
                      >
                        Project source
                      </button>
                      <button
                        className="secondary"
                        onClick={() => void external("support")}
                      >
                        Get support
                      </button>
                    </div>
                  </section>
                </div>
              ) : (
                <p>{error ? text.bridgeError : text.loading}</p>
              )}
            </>
          )}
        </main>
      </div>
      {updateConsent && (
        <UpdateConfirmation
          pending={pending}
          onCancel={() => setUpdateConsent(false)}
          onConfirm={() => void installClientUpdate()}
        />
      )}
    </div>
  );
}

function Detail({
  app,
  onBack,
  onRequest,
}: {
  app: Entry;
  onBack: () => void;
  onRequest: () => void;
}) {
  const draft = app.draft;
  const verified = app.verified;
  return (
    <article className="detail">
      <button className="text-button" onClick={onBack}>
        ← Back to Discover
      </button>
      <div className="page-heading">
        <p className="eyebrow">{app.category}</p>
        <h1>{app.name}</h1>
        <p>{app.summary}</p>
        <span className="badge">
          {draft ? text.draft : statusLabels[verified!.status]}
        </span>
      </div>
      <div className="catalog-banner">
        <div>
          <strong>{draft ? text.draftNotice : text.management}</strong>
          <p>
            {draft
              ? draft.distribution.notes
              : "Catalog descriptions do not grant installation authority. Application controls are unavailable in this release."}
          </p>
        </div>
        <button onClick={onRequest}>About packaging requests</button>
      </div>
      <section className="panel prose">
        <h2>About this project</h2>
        <p>{app.description}</p>
        {app.useCases.length > 0 && (
          <>
            <h3>Use cases</h3>
            <ul>
              {app.useCases.map((useCase) => (
                <li key={useCase}>{useCase}</li>
              ))}
            </ul>
          </>
        )}
        <h3>Author, source, and license</h3>
        <dl>
          <dt>Author</dt>
          <dd>{draft?.upstreamAuthor ?? verified?.upstreamAuthor}</dd>
          <dt>Source</dt>
          <dd>{draft?.sourceUrl ?? verified?.sourceUrl}</dd>
          <dt>License</dt>
          <dd>
            {draft
              ? `${draft.license.spdx ?? "Unknown — review required"}. ${draft.license.notes}`
              : verified?.licenseSpdx}
          </dd>
          <dt>Testing</dt>
          <dd>
            {draft
              ? "Not tested by RepoReady."
              : verified?.verifiedAt
                ? `Catalog verification date: ${formatDate(verified.verifiedAt)}`
                : "No verification date recorded."}
          </dd>
        </dl>
      </section>
      <section className="panel prose">
        <h2>Compatibility and requirements</h2>
        {draft ? (
          <dl>
            {Object.entries(draft.requirements).map(([key, value]) => (
              <div className="disclosure" key={key}>
                <dt>
                  {{
                    platform: "Platform",
                    hardware: "Hardware",
                    disk: "Disk space",
                    modelDownloads: "Model downloads",
                    network: "Network",
                    privacy: "Privacy",
                    apiCharges: "API charges",
                  }[key] ?? key}
                </dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <dl>
            <dt>Platform</dt>
            <dd>
              Windows 11 x64 · minimum build{" "}
              {verified?.requirements.minWindowsBuild}
            </dd>
            <dt>Memory</dt>
            <dd>{verified?.requirements.minRamMb} MB</dd>
            <dt>Disk</dt>
            <dd>{verified?.requirements.diskMb} MB</dd>
            <dt>GPU</dt>
            <dd>
              {verified?.requirements.gpuNotes || "No additional GPU notes."}
            </dd>
            <dt>Network</dt>
            <dd>
              {verified?.requirements.internetRequired
                ? "Internet connection required."
                : "No persistent internet connection required by catalog metadata."}
            </dd>
            <dt>Additional downloads</dt>
            <dd>{verified?.requirements.extraDownloadBytes} bytes</dd>
            <dt>API providers</dt>
            <dd>
              {verified?.requirements.externalApiProviders.join(", ") ||
                "None listed."}
            </dd>
            <dt>API charges</dt>
            <dd>
              {verified?.requirements.apiChargesDisclosed
                ? "External API charges may apply; consult the publisher."
                : "No API charges disclosed in this catalog record."}
            </dd>
          </dl>
        )}
        <p>{text.standalone}</p>
        {!draft && (
          <p>
            <strong>Distribution requirements:</strong> This catalog descriptor
            does not include release-specific standalone or managed-runtime
            information. Do not assume this package works independently. No
            application installation is available in this release.
          </p>
        )}
      </section>
      {!draft && (
        <section className="panel prose">
          <h2>Screenshots and release information</h2>
          <p>
            Remote screenshot previews are unavailable in this development
            build. This catalog lists {verified?.screenshots.length ?? 0}{" "}
            screenshot references; images are not downloaded here.
          </p>
          <p>
            Release version and package details are not included in this catalog
            descriptor. These must be reviewed before a later client can offer
            installation.
          </p>
        </section>
      )}
      {draft && (
        <>
          <section className="panel prose">
            <h2>Setup and lifecycle</h2>
            <dl>
              <dt>Package type</dt>
              <dd>
                {draft.proposedPackageType ??
                  "Unknown — packaging review required."}
              </dd>
              <dt>Setup</dt>
              <dd>{draft.setupNotes}</dd>
              <dt>Updates</dt>
              <dd>{draft.updateNotes}</dd>
              <dt>Uninstall</dt>
              <dd>{draft.uninstallNotes}</dd>
            </dl>
            <h3>Limitations</h3>
            <ul>
              {draft.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </section>
          <section className="panel prose">
            <h2>Research and media</h2>
            <p>{draft.mediaNotes}</p>
            <p>
              {draft.screenshots.length
                ? "Reviewed media is available on the project website."
                : "No licensed screenshot has been published for this draft."}
            </p>
            <p>
              Review stage: {draft.review.stage.replaceAll("-", " ")} ·{" "}
              {formatDate(draft.review.reviewedAt)}
            </p>
            <p>{draft.review.notes}</p>
            <ul>
              {draft.research.map((source) => (
                <li key={source.url}>
                  {source.url} · accessed {formatDate(source.accessedAt)}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </article>
  );
}
function UpdateConfirmation({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog ref={dialog} onCancel={onCancel} aria-labelledby="update-title">
      <h2 id="update-title">{text.updateConfirm}</h2>
      <p>{text.updateConsent}</p>
      <div className="button-row">
        <button autoFocus className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button disabled={pending} onClick={onConfirm}>
          Confirm client update
        </button>
      </div>
    </dialog>
  );
}
function formatDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
function updateLabel(status: string) {
  return (
    (
      {
        "not-configured": "Updates are not configured",
        current: "You are up to date",
        available: "Approved update available",
        checking: "Checking for updates",
        downloaded: "Update downloaded",
        failed: "Update check failed",
        "restart-required": "Restart required",
      } as Record<string, string>
    )[status] ?? "Update status unavailable"
  );
}
