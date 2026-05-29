// Shared types for the geodesic path feature. Imported by both
// the API route (/api/path) and the client component (path-filmstrip).
// Kept in src/lib/ so the 'use client' filmstrip component can safely
// import the type without pulling in server-only code.

export type PathNode = {
  imageId: number;
  slug: string;
  blobUrl: string;
  // owner handle for /u/<handle>/<slug> canonical URLs; empty string means
  // fall back to the legacy /<slug> shape (pre-multiuser rows).
  handle: string;
  // Canonical caption: prefers the isSlugSource variant, else variant 1,
  // else the slug itself.
  caption: string;
};

export type PathResponse =
  | { found: true; path: PathNode[]; totalDist: number }
  | { found: false; reason: 'same-node' | 'no-path' | 'missing-embedding' };
