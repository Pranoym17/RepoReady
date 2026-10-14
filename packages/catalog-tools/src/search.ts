export const catalogCategories = [
  "ai",
  "productivity",
  "media",
  "utilities",
] as const;

export interface SearchableCandidate {
  name: string;
  slug: string;
  summary: string;
  description: string;
  category: string;
  tags: string[];
  useCases: string[];
}

export function normalizeSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function searchCatalog<T extends SearchableCandidate>(
  candidates: readonly T[],
  query = "",
  category = "",
): T[] {
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
  return candidates
    .filter((candidate) => {
      if (category && candidate.category !== category) return false;
      const text = normalizeSearch(
        [
          candidate.name,
          candidate.summary,
          candidate.description,
          ...candidate.tags,
          ...candidate.useCases,
        ].join(" "),
      );
      return terms.every((term) => text.includes(term));
    })
    .sort(
      (a, b) =>
        normalizeSearch(a.name).localeCompare(normalizeSearch(b.name), "en") ||
        a.slug.localeCompare(b.slug, "en"),
    );
}

/** M1 validates locally; no URL is transmitted or persisted. */
export function canonicalGithubRepository(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const parts = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
    if (
      parts.length !== 2 ||
      parts.some(
        (part) =>
          !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..",
      )
    )
      return null;
    if (parts[1].endsWith(".git")) parts[1] = parts[1].slice(0, -4);
    if (!parts[1]) return null;
    return `https://github.com/${parts.join("/")}`;
  } catch {
    return null;
  }
}
