import {
  CandidateSchema,
  type Candidate,
} from "../../../packages/catalog-tools/src/editorial";
import type { Snapshot } from "./bridge";

const files = import.meta.glob("../../../catalog/candidates/*.json", {
  eager: true,
  import: "default",
});
export const drafts = Object.values(files).map((record) =>
  CandidateSchema.parse(record),
);
export type Entry = {
  id: string;
  slug: string;
  name: string;
  summary: string;
  description: string;
  category: string;
  tags: string[];
  useCases: string[];
  draft: Candidate | null;
  verified: Snapshot["catalog"]["items"][number] | null;
};
export function entriesFor(snapshot: Snapshot | null): Entry[] {
  const verified = snapshot?.catalog.items ?? [];
  const ids = new Set(verified.map((app) => app.id));
  return [
    ...verified.map((app) => ({
      ...app,
      useCases: [],
      draft: null,
      verified: app,
    })),
    ...drafts
      .filter((app) => !ids.has(app.id))
      .map((app) => ({ ...app, draft: app, verified: null })),
  ];
}
