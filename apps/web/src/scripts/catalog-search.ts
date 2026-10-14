import {
  searchCatalog,
  catalogCategories,
  type SearchableCandidate,
} from "../../../../packages/catalog-tools/src/search";

const form = document.querySelector<HTMLFormElement>("#catalog-search");
const query = document.querySelector<HTMLInputElement>("#catalog-query");
const category = document.querySelector<HTMLSelectElement>("#catalog-category");
const count = document.querySelector<HTMLElement>("#catalog-count");
const empty = document.querySelector<HTMLElement>("#catalog-empty");
const data = document.querySelector("#catalog-search-data");
if (form && query && category && count && empty && data) {
  const candidates = JSON.parse(
    data.textContent ?? "[]",
  ) as SearchableCandidate[];
  const cards = [
    ...document.querySelectorAll<HTMLElement>("[data-catalog-card]"),
  ];
  const update = () => {
    const matches = searchCatalog(candidates, query.value, category.value);
    const slugs = new Set(matches.map((candidate) => candidate.slug));
    cards.forEach((card) => {
      card.hidden = !slugs.has(card.dataset.slug ?? "");
    });
    count.textContent = `${matches.length} catalog entr${matches.length === 1 ? "y" : "ies"}`;
    empty.hidden = matches.length > 0;
  };
  const restore = () => {
    const params = new URLSearchParams(location.search);
    query.value = (params.get("q") ?? "").slice(0, 200);
    const selected = params.get("category") ?? "";
    category.value = catalogCategories.some((value) => value === selected)
      ? selected
      : "";
    update();
  };
  const save = (replace = false) => {
    const url = new URL(location.href);
    if (query.value.trim()) url.searchParams.set("q", query.value.trim());
    else url.searchParams.delete("q");
    if (category.value) url.searchParams.set("category", category.value);
    else url.searchParams.delete("category");
    if (url.href !== location.href) {
      if (replace) history.replaceState(null, "", url);
      else history.pushState(null, "", url);
    }
    update();
  };
  form.hidden = false;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save();
  });
  query.addEventListener("input", () => save(true));
  category.addEventListener("change", () => save());
  form.addEventListener("reset", () => {
    query.value = "";
    category.value = "";
    save();
  });
  window.addEventListener("popstate", restore);
  restore();
}
