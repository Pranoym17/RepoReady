import { canonicalGithubRepository } from "../../../../packages/catalog-tools/src/search";

const form = document.querySelector<HTMLFormElement>("#request-check");
const input = document.querySelector<HTMLInputElement>("#repository-url");
const result = document.querySelector<HTMLElement>("#repository-result");
if (form && input && result) {
  form.hidden = false;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const canonical = canonicalGithubRepository(input.value);
    input.setAttribute("aria-invalid", String(!canonical));
    result.textContent = canonical
      ? `Valid repository format: ${canonical}. Nothing was submitted or saved; intake is unavailable.`
      : "Use a public HTTPS github.com/owner/project URL without credentials, a query, fragment, or subpage.";
  });
}
