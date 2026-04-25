// Single source of truth for the cosine-similarity floor used by /search
// and exposed in /admin/gallery. Lives in its own file (no Drizzle / DB
// imports) so the client-side admin form can read it without pulling the
// server-only db module into the client bundle.
export const DEFAULT_SEARCH_SIM_THRESHOLD = 0.3;
