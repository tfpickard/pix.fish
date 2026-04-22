type Exif = Record<string, unknown>;

export function PaletteStrip({ colors }: { colors: string[] | null }) {
  if (!colors || colors.length === 0) return null;
  return (
    <div className="flex justify-center gap-1" aria-label="dominant colors">
      {colors.map((hex) => (
        <span
          key={hex}
          title={hex}
          className="h-4 w-8 rounded-sm ring-1 ring-inset ring-ink-900/60"
          style={{ backgroundColor: hex }}
        />
      ))}
    </div>
  );
}

// Pulls the few EXIF facts humans care about. Everything else stays in the
// jsonb blob for later, but we don't surface it visually until we know what
// to do with it.
export function ExifFacts({ exif }: { exif: Exif | null }) {
  if (!exif) return null;
  const parts: string[] = [];

  const body = [exif.Make, exif.Model].filter(Boolean).join(' ').trim();
  if (body) parts.push(body);
  if (typeof exif.LensModel === 'string' && exif.LensModel.trim()) parts.push(exif.LensModel);

  const settings: string[] = [];
  const focal = exif.FocalLength ?? exif.FocalLengthIn35mmFormat;
  if (typeof focal === 'number') settings.push(`${Math.round(focal)}mm`);
  if (typeof exif.FNumber === 'number') settings.push(`f/${exif.FNumber}`);
  if (exif.ExposureTime != null) settings.push(formatShutter(exif.ExposureTime));
  if (typeof exif.ISO === 'number') settings.push(`ISO ${exif.ISO}`);
  if (settings.length > 0) parts.push(settings.join(' · '));

  if (parts.length === 0) return null;

  return (
    <dl className="flex flex-col items-center gap-0.5 font-mono text-xs text-ink-500">
      {parts.map((p) => (
        <dd key={p}>{p}</dd>
      ))}
    </dl>
  );
}

function formatShutter(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(value);
  if (n >= 1) return `${n.toFixed(1)}s`;
  return `1/${Math.round(1 / n)}s`;
}
