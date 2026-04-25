// Server component: emits a <script type="application/ld+json"> node from a
// plain object. Comment bodies flow through here from the public POST
// endpoint, so the escape set covers every character that can terminate a
// JavaScript string literal when the script tag is parsed inline:
//   - every `<` so no combination reaches `</script>`
//   - U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, both valid in
//     JSON strings but string-terminators inside inline <script> text.
// Search strings use explicit \u2028 / \u2029 escapes (not the literal
// codepoints) so the source stays readable and a stray reformat can't
// silently drop them.
//
// Pass either a single builder result or an array of them.
export function JsonLd({ data }: { data: unknown | unknown[] }) {
  const payload = Array.isArray(data) ? data : [data];
  const json = JSON.stringify(payload.length === 1 ? payload[0] : payload)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
