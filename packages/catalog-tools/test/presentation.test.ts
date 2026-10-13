import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clientDownload,
  selectWebsiteAction,
  type WebsiteRelease,
} from "../src/presentation.js";

const release: WebsiteRelease = {
  status: "ready",
  capability: "standalone",
  current: true,
  held: false,
  approval: {
    appId: "test-app",
    version: "1.0.0",
    artifactSha256: "abcdef0123456789".repeat(4),
    downloadUrl: "https://github.com/test/app/releases/download/v1.0.0/app.exe",
    packagingType: "repoready-nsis",
  },
};
const select = (value: WebsiteRelease | null, candidate = false) =>
  selectWebsiteAction({
    appId: "test-app",
    candidate,
    release: value,
    client: null,
  });

test("every approved standalone distribution stays downloadable without a client", () => {
  assert.equal(select(release).href, release.approval?.downloadUrl);
  assert.match(select(release).notice, /No RepoReady client required/);
  const publisher = structuredClone(release);
  publisher.status = "publisher-installer";
  publisher.approval!.packagingType = "publisher-msi";
  assert.equal(select(publisher).label, "Download publisher installer");
});

test("managed runtime requires a tested client and never offers its own binary", () => {
  const managed = { ...release, capability: "requires-repoready" } as const;
  assert.equal(select(managed).href, null);
  const client = {
    downloadUrl:
      "https://github.com/test/client/releases/download/v1.0.0/setup.exe",
    version: "1.0.0",
    sha256: "abcdef0123456789".repeat(4),
    tested: true,
  };
  const action = selectWebsiteAction({
    appId: "test-app",
    candidate: false,
    release: managed,
    client,
  });
  assert.equal(action.href, client.downloadUrl);
  assert.match(action.notice, /Requires the RepoReady/);
  assert.equal(clientDownload({ ...client, tested: false }), null);
  assert.equal(
    clientDownload({ ...client, downloadUrl: "https://example.org/setup.exe" }),
    null,
  );
});

test("drafts cannot acquire release authority from a client or release record", () => {
  assert.equal(select(release, true).href, "/request/");
  assert.equal(select(release, true).label, "About packaging requests");
});

test("holds win over both Ready and draft presentation", () => {
  for (const state of [
    { ...release, held: true },
    { ...release, status: "paused" as const },
    { ...release, status: "revoked" as const },
  ]) {
    assert.equal(select(state).href, null);
    assert.equal(select(state, true).href, null);
  }
});

test("invalid or stale approval fails closed", () => {
  const mutations = [
    { ...release, current: false },
    { ...release, approval: null },
    { ...release, approval: { ...release.approval!, appId: "another-app" } },
    {
      ...release,
      approval: { ...release.approval!, artifactSha256: "0".repeat(64) },
    },
    {
      ...release,
      approval: { ...release.approval!, packagingType: "arbitrary-shell" },
    },
    {
      ...release,
      approval: {
        ...release.approval!,
        downloadUrl: "https://example.org/fake.exe",
      },
    },
    {
      ...release,
      approval: {
        ...release.approval!,
        downloadUrl:
          "https://github.com/test/app/releases/latest/download/app.exe",
      },
    },
    { ...release, status: "publisher-installer" as const },
  ];
  for (const value of mutations) assert.equal(select(value).href, null);
  assert.equal(select(null).href, null);
});
