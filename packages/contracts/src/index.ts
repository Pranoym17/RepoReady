import { z } from "zod";

export const Id = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(80);
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const Commit = z.string().regex(/^[a-f0-9]{40}$/);
export const HttpsUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[a-zA-Z0-9.-]+(?::443)?(?:\/[^\s#]*)?$/);
export const GithubUrl = z
  .string()
  .regex(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/)
  .max(256);
export const Version = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
  .max(80);
export const Timestamp = z.iso.datetime();
export const Category = z.enum(["ai", "productivity", "media", "utilities"]);
export const Status = z.enum([
  "ready",
  "publisher-installer",
  "requested",
  "unavailable",
  "paused",
  "revoked",
]);
export const Adapter = z.enum([
  "managed-folder",
  "repoready-nsis",
  "publisher-msi",
  "publisher-exe",
]);
export const ErrorCode = z.enum([
  "INVALID_INPUT",
  "NOT_AVAILABLE",
  "UNTRUSTED_CATALOG",
  "STALE_CATALOG",
  "INCOMPATIBLE",
  "INSUFFICIENT_DISK",
  "DOWNLOAD_FAILED",
  "HASH_MISMATCH",
  "INSTALL_FAILED",
  "RECOVERY_REQUIRED",
  "CREDENTIAL_FAILED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);
export const PublicError = z.strictObject({
  code: ErrorCode,
  retryable: z.boolean(),
});
export const Requirements = z.strictObject({
  minWindowsBuild: z.number().int().min(22000).max(999999),
  minRamMb: z.number().int().min(0).max(1048576),
  diskMb: z.number().int().positive().max(16777216),
  gpuNotes: z.string().max(1000),
  internetRequired: z.boolean(),
  externalApiProviders: z.array(Id).max(10),
  apiChargesDisclosed: z.boolean(),
  extraDownloadBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export const App = z.strictObject({
  id: Id,
  slug: Id,
  name: z.string().min(1).max(100),
  summary: z.string().min(1).max(240),
  description: z.string().min(1).max(20000),
  category: Category,
  tags: z.array(z.string().min(1).max(50)).max(30),
  sourceUrl: GithubUrl,
  upstreamAuthor: z.string().min(1).max(200),
  licenseSpdx: z.string().min(1).max(100),
  status: Status,
  screenshots: z.array(HttpsUrl).max(12),
  requirements: Requirements,
  verifiedAt: Timestamp.nullable(),
  supportUrl: HttpsUrl,
});
export const AppVersion = z.strictObject({
  appId: Id,
  version: Version,
  sourceCommit: Commit,
  packagingType: Adapter,
  os: z.literal("windows"),
  architecture: z.literal("x64"),
  releaseNotes: z.string().min(1).max(20000),
  approvedAt: Timestamp,
  status: Status,
});
export const Artifact = z.strictObject({
  appId: Id,
  version: Version,
  downloadUrl: HttpsUrl,
  sha256: Sha256,
  sizeBytes: z.number().int().positive().max(2147483648),
  signerIdentity: z.string().min(1).max(200).nullable(),
  requiredPrivileges: z.enum(["user", "administrator"]),
  adapter: Adapter,
  uninstallAdapter: Adapter,
  credentialIntegration: z.enum(["none", "owned-launcher-v1"]),
});
export const Verification = z.strictObject({
  appId: Id,
  version: Version,
  artifactSha256: Sha256,
  testDate: Timestamp,
  tester: z.string().min(1).max(200),
  testMatrixId: Id,
  checklistVersion: z.literal("beta-1"),
  licenseReview: z.literal("passed"),
  securityReview: z.literal("passed"),
  coreTaskResult: z.literal("passed"),
  lifecycleResult: z.literal("passed"),
  evidenceSha256: Sha256,
});
export const InstallManifest = z.strictObject({
  schemaVersion: z.literal(1),
  app: App,
  release: AppVersion,
  artifact: Artifact,
  verification: Verification,
});
export const DetailReference = z.strictObject({
  appId: Id,
  version: Version,
  sha256: Sha256,
});
export const Hold = z.strictObject({
  appId: Id,
  version: Version,
  status: z.enum(["paused", "revoked"]),
  reason: z.string().min(1).max(1000),
});
export const CatalogIndex = z.strictObject({
  schemaVersion: z.literal(1),
  channel: z.literal("stable"),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  details: z.array(DetailReference).max(100),
  holds: z.array(Hold).max(1000),
});
export const SignedEnvelope = z.strictObject({
  schemaVersion: z.literal(1),
  keyId: Id,
  payload: z
    .string()
    .min(4)
    .max(1400000)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  signature: z
    .string()
    .length(128)
    .regex(/^[a-f0-9]{128}$/),
});
export const RequestState = z.enum([
  "NEW",
  "TRIAGE",
  "APPROVED_FOR_REVIEW",
  "REJECTED",
  "DUPLICATE",
  "PACKAGING",
  "QA",
  "READY",
  "FAILED",
  "ON_HOLD",
]);
export const Submission = z.strictObject({
  publicId: z.string().regex(/^[a-f0-9]{32}$/),
  sourceUrl: GithubUrl,
  count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: RequestState,
  createdAt: Timestamp,
  lastRequestedAt: Timestamp,
});
export const RequestInput = z.strictObject({
  sourceUrl: GithubUrl,
  turnstileToken: z.string().min(1).max(2048),
  idempotencyKey: z.string().uuid(),
});
export const Preview = z.strictObject({
  sourceUrl: GithubUrl,
  description: z.string().max(2000).nullable(),
  languages: z.array(z.string().max(100)).max(100),
  licenseIndicator: z.string().max(100).nullable(),
  hasReleases: z.boolean(),
  archived: z.boolean(),
  updatedAt: Timestamp,
  installability: z.literal("not-verified"),
});
export const OperationStage = z.enum([
  "preflight",
  "downloading",
  "verifying",
  "staging",
  "installing",
  "checking",
  "committing",
  "installed",
  "canceled",
  "failed",
  "recovery-required",
]);
export const InstallTransaction = z.strictObject({
  id: z.string().uuid(),
  appId: Id,
  version: Version,
  stage: OperationStage,
  bytesDownloaded: z.number().int().min(0).max(2147483648),
  errorCode: ErrorCode.nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  recoveryState: z.enum(["none", "inspect", "retry", "guided-recovery"]),
});
export const InstalledApp = z.strictObject({
  appId: Id,
  version: Version,
  installPath: z.string().min(1).max(32767),
  installMethod: Adapter,
  installedAt: Timestamp,
  lastLaunchAt: Timestamp.nullable(),
  updateStatus: z.enum(["unknown", "current", "available", "held"]),
  artifactSha256: Sha256,
});
const RelativePath = z
  .string()
  .max(240)
  .regex(
    /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*(?:\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)*$/,
  );
export const BuildRecipe = z.strictObject({
  schemaVersion: z.literal(1),
  appId: Id,
  sourceUrl: GithubUrl,
  sourceCommit: Commit,
  adapter: z.enum(["pyinstaller", "upstream-packager", "reviewed-launcher"]),
  adapterVersion: Version,
  lockfiles: z
    .array(z.strictObject({ path: RelativePath, sha256: Sha256 }))
    .min(1)
    .max(50),
  expectedOutputs: z.array(RelativePath).min(1).max(20),
  notices: z.array(RelativePath).min(1).max(50),
  configuration: z.strictObject({
    credentialIntegration: z.enum(["none", "owned-launcher-v1"]),
    providers: z.array(Id).max(10),
  }),
  manualProtocol: RelativePath,
});
export const schemas = {
  App,
  AppVersion,
  Artifact,
  Requirements,
  Verification,
  InstallManifest,
  CatalogIndex,
  SignedEnvelope,
  Submission,
  RequestInput,
  Preview,
  InstallTransaction,
  InstalledApp,
  BuildRecipe,
  PublicError,
};
export type Manifest = z.infer<typeof InstallManifest>;
export { normalizeGithubUrl } from "./github.js";
export { canTransition, reconcileStage, isTerminal } from "./operations.js";

// Shape validation is necessary, but only a verified signed index may authorize this manifest.
export function validateManifest(input: unknown): Manifest {
  const value = InstallManifest.parse(input);
  const { app, release, artifact, verification } = value;
  if (
    ![release.appId, artifact.appId, verification.appId].every(
      (id) => id === app.id,
    )
  )
    throw new Error("Manifest identity mismatch");
  if (
    artifact.version !== release.version ||
    verification.version !== release.version
  )
    throw new Error("Manifest version mismatch");
  if (
    artifact.adapter !== release.packagingType ||
    artifact.uninstallAdapter !== artifact.adapter
  )
    throw new Error("Adapter mismatch");
  if (artifact.sha256 !== verification.artifactSha256)
    throw new Error("Uncertified artifact");
  if (
    !["ready", "publisher-installer"].includes(app.status) ||
    release.status !== app.status ||
    app.verifiedAt === null
  )
    throw new Error("Not installable");
  if (
    app.requirements.externalApiProviders.length > 0 &&
    !app.requirements.apiChargesDisclosed
  )
    throw new Error("Missing cost disclosure");
  if (
    artifact.credentialIntegration === "owned-launcher-v1" &&
    !["managed-folder", "repoready-nsis"].includes(artifact.adapter)
  )
    throw new Error("Unsupported credential integration");
  if (artifact.adapter !== "managed-folder" && artifact.signerIdentity === null)
    throw new Error("Missing publisher verification");
  if (
    (app.status === "publisher-installer") !==
    artifact.adapter.startsWith("publisher-")
  )
    throw new Error("Misleading distribution status");
  return value;
}
