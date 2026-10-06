export function normalizeGithubUrl(input: string): string {
  // Parse only canonical repository identities; never accept arbitrary fetch targets.
  if (
    input.length > 256 ||
    !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/?$/i.test(input)
  )
    throw new Error("Use a public GitHub project link");
  const url = new URL(input);
  const [owner, rawRepo] = url.pathname.replace(/\/$/, "").slice(1).split("/");
  const repo = rawRepo?.replace(/\.git$/i, "");
  if (
    !owner ||
    !repo ||
    [".", ".."].includes(repo) ||
    owner.startsWith("-") ||
    owner.endsWith("-") ||
    owner.length > 39 ||
    repo.length > 100
  )
    throw new Error("Invalid GitHub identity");
  return `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`;
}
