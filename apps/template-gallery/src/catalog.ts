export type TemplateCatalog = {
  schemaVersion: 1;
  templates: TemplateCatalogItem[];
};

export type TemplateCatalogItem = {
  slug: string;
  displayName: string;
  summary: string;
  license: string;
  provenance: "community" | "simulation";
  source: { repository: string; revision: string };
  sdk: { range: string; lastTestedVersion: string };
  hook: { name: string; type: "event" | "transform" | "policy" };
  capabilities: string[];
  egress: { mode: "deny" };
  configKeys: string[];
  review: { decision: "approve" };
};

export type GalleryFilters = {
  query: string;
  tag: string;
  capability: string;
};

export const NO_CAPABILITIES = "__none__";

export function getTemplateTags(template: TemplateCatalogItem): string[] {
  return [template.provenance, template.hook.type];
}

export function filterTemplates(
  templates: readonly TemplateCatalogItem[],
  filters: GalleryFilters
): TemplateCatalogItem[] {
  const query = filters.query.trim().toLocaleLowerCase("en-US");

  return templates.filter((template) => {
    const tags = getTemplateTags(template);
    const searchable = [
      template.displayName,
      template.summary,
      template.hook.name,
      ...tags,
      ...template.capabilities
    ]
      .join(" ")
      .toLocaleLowerCase("en-US");
    const matchesQuery = query.length === 0 || searchable.includes(query);
    const matchesTag = filters.tag.length === 0 || tags.includes(filters.tag);
    const matchesCapability =
      filters.capability.length === 0 ||
      (filters.capability === NO_CAPABILITIES
        ? template.capabilities.length === 0
        : template.capabilities.includes(filters.capability));

    return matchesQuery && matchesTag && matchesCapability;
  });
}

export function collectFilterOptions(templates: readonly TemplateCatalogItem[]): {
  tags: string[];
  capabilities: string[];
} {
  return {
    tags: [...new Set(templates.flatMap(getTemplateTags))].sort(),
    capabilities: [...new Set(templates.flatMap((template) => template.capabilities))].sort()
  };
}

export function getReviewedRevisionUrl(source: TemplateCatalogItem["source"]): string | undefined {
  const repository = new URL(source.repository);
  if (repository.hostname.toLowerCase() !== "github.com") return undefined;

  const pathname = repository.pathname.replace(/\/+$/u, "").replace(/\.git$/iu, "");
  repository.pathname = `${pathname}/tree/${source.revision}`;
  return repository.href;
}
