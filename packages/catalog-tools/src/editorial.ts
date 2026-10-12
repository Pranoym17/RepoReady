import { z } from "zod";
import {
  Adapter,
  Category,
  GithubUrl,
  Id,
  Timestamp,
} from "@repoready/contracts";

export const PlainText = z
  .string()
  .trim()
  .min(1)
  .max(20000)
  .refine((value) => !/<\/?[a-z!][^>]*>/i.test(value), "HTML is not allowed");
export const SafeUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        !/[\s<>\\]/.test(value) &&
        !url.hostname.includes(":") &&
        !/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)
      );
    } catch {
      return false;
    }
  }, "A public HTTPS URL without credentials is required");
export const CandidateSchema = z.strictObject({
  id: Id,
  slug: Id,
  name: PlainText,
  summary: PlainText,
  description: PlainText,
  category: Category,
  tags: z.array(PlainText).min(1).max(30),
  useCases: z.array(PlainText).min(1).max(20),
  sourceUrl: GithubUrl,
  upstreamAuthor: PlainText,
  license: z.strictObject({
    spdx: PlainText.nullable(),
    notes: PlainText,
    evidenceUrl: SafeUrl,
  }),
  review: z.strictObject({
    stage: z.enum([
      "researching",
      "awaiting-license-review",
      "awaiting-packaging-review",
    ]),
    reviewedAt: Timestamp,
    notes: PlainText,
  }),
  requirements: z.strictObject({
    platform: PlainText,
    hardware: PlainText,
    disk: PlainText,
    modelDownloads: PlainText,
    network: PlainText,
    privacy: PlainText,
    apiCharges: PlainText,
  }),
  distribution: z.strictObject({
    capability: z.enum(["unknown", "standalone", "requires-repoready"]),
    notes: PlainText,
  }),
  limitations: z.array(PlainText).min(1).max(30),
  screenshots: z
    .array(
      z.strictObject({
        url: SafeUrl,
        alt: PlainText,
        credit: PlainText,
        sourceUrl: SafeUrl,
      }),
    )
    .max(12),
  mediaNotes: PlainText,
  research: z
    .array(z.strictObject({ url: SafeUrl, accessedAt: Timestamp }))
    .min(1)
    .max(30),
  proposedPackageType: Adapter.nullable(),
  setupNotes: PlainText,
  updateNotes: PlainText,
  uninstallNotes: PlainText,
});
export type Candidate = z.infer<typeof CandidateSchema>;
export function validateCandidates(input: unknown[]): Candidate[] {
  const ids = new Set<string>();
  const slugs = new Set<string>();
  return input.map((record, position) => {
    const parsed = CandidateSchema.safeParse(record);
    if (!parsed.success)
      throw new Error(
        `candidate[${position}]: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      );
    const candidate = parsed.data;
    if (
      [
        candidate.review.reviewedAt,
        ...candidate.research.map((entry) => entry.accessedAt),
      ].some((date) => Date.parse(date) > Date.now())
    )
      throw new Error(
        `candidate ${candidate.id}: review/research date is in the future`,
      );
    if (ids.has(candidate.id) || slugs.has(candidate.slug))
      throw new Error(`candidate ${candidate.id}: duplicate id or slug`);
    ids.add(candidate.id);
    slugs.add(candidate.slug);
    return candidate;
  });
}
