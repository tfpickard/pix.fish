// Fixed-vocabulary fragments for the hybrid prompt composer. Each value is a
// short string that's concatenated into the generated template. The owner
// picks one option per axis (or none); compose.ts glues them together.
export const voices = {
  neutral: 'Keep voice neutral and matter-of-fact.',
  poetic: 'Use poetic, evocative, image-forward language.',
  terse: 'Be terse. Short, punchy phrasing. No filler.',
  whimsical: 'Be whimsical -- playful surprise in word choice.'
} as const;

export const lengths = {
  short: 'Keep each output under 8 words.',
  medium: 'Use 1 to 2 sentences.',
  long: 'Use 2 to 3 sentences; allow mild elaboration.'
} as const;

export const audiences = {
  general: 'Write for a general audience.',
  photographer: 'Write for a photographer -- light, composition, lens choices are fair game.',
  archivist: 'Write for an archivist -- note medium, era cues, provenance hints.'
} as const;

export const extras = {
  mention_palette: 'Where obvious, reference the dominant color palette.',
  mention_exif: 'Where obvious from the scene, reference the time of day or season.',
  avoid_speculation: 'Do not speculate about people, intent, or narrative beyond the image.'
} as const;

export type Voice = keyof typeof voices;
export type Length = keyof typeof lengths;
export type Audience = keyof typeof audiences;
export type Extra = keyof typeof extras;

export type Fragments = {
  voice?: Voice;
  length?: Length;
  audience?: Audience;
  extras?: Extra[];
};
