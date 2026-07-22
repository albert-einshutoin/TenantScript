import { useMemo, useState } from "react";
import {
  collectFilterOptions,
  filterTemplates,
  getReviewedRevisionUrl,
  getTemplateTags,
  NO_CAPABILITIES,
  type TemplateCatalog,
  type TemplateCatalogItem
} from "./catalog.js";

type AppProps = { catalog: TemplateCatalog };

export function App({ catalog }: AppProps) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [capability, setCapability] = useState("");
  const options = useMemo(() => collectFilterOptions(catalog.templates), [catalog.templates]);
  const templates = useMemo(
    () => filterTemplates(catalog.templates, { query, tag, capability }),
    [capability, catalog.templates, query, tag]
  );
  const hasFilters = query.length > 0 || tag.length > 0 || capability.length > 0;

  const clearFilters = () => {
    setQuery("");
    setTag("");
    setCapability("");
  };

  return (
    <div className="site-shell">
      <a className="skip-link" href="#catalog-results">
        Skip to templates
      </a>
      <header className="site-header">
        <a className="brand" href="/" aria-label="TenantScript template gallery home">
          <span className="brand-mark" aria-hidden="true">
            TS
          </span>
          <span>TenantScript</span>
        </a>
        <a className="header-link" href="https://github.com/albert-einshutoin/TenantScript">
          GitHub
        </a>
      </header>

      <main>
        <section className="hero" aria-labelledby="gallery-heading">
          <p className="eyebrow">Reviewed template catalog</p>
          <h1 id="gallery-heading">Start from a smaller, inspectable permission surface.</h1>
          <p className="hero-copy">
            Browse templates whose source, SDK range, capabilities, and deny-only egress policy
            passed the repository review contract.
          </p>
          <p className="boundary-note">
            Repository-tested compatibility is evidence, not live registry certification.
          </p>
        </section>

        <section className="catalog-panel" aria-labelledby="filter-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Explore</p>
              <h2 id="filter-heading">Template catalog</h2>
            </div>
            <p className="result-count" aria-live="polite">
              {templates.length} {templates.length === 1 ? "template" : "templates"} found
            </p>
          </div>

          <form
            className="filters"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <label className="search-field">
              <span>Search templates</span>
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                }}
                placeholder="Name, hook, or capability"
              />
            </label>
            <label>
              <span>Tag</span>
              <select
                value={tag}
                onChange={(event) => {
                  setTag(event.currentTarget.value);
                }}
              >
                <option value="">All tags</option>
                {options.tags.map((option) => (
                  <option key={option} value={option}>
                    {formatLabel(option)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Capability</span>
              <select
                value={capability}
                onChange={(event) => {
                  setCapability(event.currentTarget.value);
                }}
              >
                <option value="">All capabilities</option>
                <option value={NO_CAPABILITIES}>No capabilities</option>
                {options.capabilities.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="clear-button"
              type="button"
              disabled={!hasFilters}
              onClick={clearFilters}
            >
              Clear filters
            </button>
          </form>

          <div id="catalog-results" className="catalog-results" tabIndex={-1}>
            {templates.length === 0 ? (
              <div className="empty-state">
                <h3>No templates match these filters.</h3>
                <p>Try a broader search or clear the selected filters.</p>
                <button type="button" onClick={clearFilters}>
                  Reset and show all templates
                </button>
              </div>
            ) : (
              <div className="card-grid">
                {templates.map((template) => (
                  <TemplateCard key={template.slug} template={template} />
                ))}
              </div>
            )}
          </div>
        </section>
      </main>

      <footer>
        <p>Apache-2.0 · Static catalog · No analytics</p>
      </footer>
    </div>
  );
}

function TemplateCard({ template }: { template: TemplateCatalogItem }) {
  const headingId = `template-${template.slug}`;
  const reviewedRevisionUrl = getReviewedRevisionUrl(template.source);

  return (
    <article className="template-card" aria-labelledby={headingId}>
      <div className="card-topline">
        <div className="tag-list" aria-label="Template tags">
          {getTemplateTags(template).map((tag) => (
            <span className="tag" key={tag}>
              {formatLabel(tag)}
            </span>
          ))}
        </div>
        <span className="review-status">Reviewed: approved</span>
      </div>
      <h3 id={headingId}>{template.displayName}</h3>
      <p className="summary">{template.summary}</p>

      <dl className="facts">
        <div>
          <dt>Hook</dt>
          <dd>
            <code>{template.hook.name}</code>
          </dd>
        </div>
        <div>
          <dt>SDK range</dt>
          <dd>{template.sdk.range}</dd>
        </div>
        <div>
          <dt>Last tested</dt>
          <dd>{template.sdk.lastTestedVersion}</dd>
        </div>
        <div>
          <dt>Egress</dt>
          <dd>No outbound egress</dd>
        </div>
      </dl>

      <div className="capability-block">
        <p>Capabilities</p>
        {template.capabilities.length === 0 ? (
          <span className="muted">None requested</span>
        ) : (
          <ul>
            {template.capabilities.map((capability) => (
              <li key={capability}>
                <code>{capability}</code>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card-footer">
        <span>
          {template.license} · Reviewed revision{" "}
          <code>{template.source.revision.slice(0, 12)}</code>
        </span>
        <a
          href={reviewedRevisionUrl ?? template.source.repository}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={
            reviewedRevisionUrl === undefined
              ? `View source repository for ${template.displayName}; reviewed revision ${template.source.revision}`
              : `View reviewed source for ${template.displayName}`
          }
        >
          {reviewedRevisionUrl === undefined ? "View repository" : "View reviewed source"}
        </a>
      </div>
    </article>
  );
}

function formatLabel(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
