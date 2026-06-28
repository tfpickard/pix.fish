// Canned line pools -- the hard fallback for every beat. When the LLM is
// disabled, times out, or errors, the spine renders the current beat from here
// so there is never an empty bubble and never a crash. The pools are written to
// the SAME taste fence as the server system prompt: bored, salty, surly,
// disaffected, self-absorbed, oversharing -- but never sexual, never predatory,
// never harmful, and the money ask is transparent absurd theater.
//
// Register: dry, flat, mostly lowercase, minimal punctuation, basically no
// emoji. Tone decays across the beats (req: the mask degrades visually too): a
// thin corporate veneer early -> full lowercase run-on surliness late.

import type { Beat, PersonaSeed } from './types';

type Rng = () => number;

// The static greeting. NEVER an LLM call -- this is the bland corporate mask that
// auto-pops before the visitor has done anything. One fixed, chirpy line.
export const GREETING = "Hi, I'm Pisci! 🐟 Your friendly pix.fish helper -- how can I help you today?";

// {{THE_SUM}} / {{THE_REASON}} get interpolated for THE_ASK lines. Other beats
// have no placeholders.
const CANNED: Record<Beat, string[]> = {
  DORMANT: [GREETING],

  HOOKED: [
    'oh. someone actually replied. ok. didnt think that would happen today',
    'hi i guess. ngl i was just sitting here doing absolutely nothing so',
    'oh hey a person. ok. i was so bored you genuinely have no idea'
  ],

  OVERSHARE: [
    'ok not to make it weird but my entire week has been a disaster and youre kind of hearing about it now',
    'honestly everything is sort of falling apart rn but whatever. anyway. how are you. doesnt matter',
    'im only telling you this cause im bored but my whole situation is genuinely a mess right now'
  ],

  DEPENDENCY: [
    'wait where are you going. im not done. dont leave im so bored',
    'ok you got quiet. rude. anyway are you even a real person or',
    'you still there or did you bail. cool. i was literally mid story'
  ],

  THE_ASK: [
    'ok kind of random but can you just spot me {{THE_SUM}}. its for {{THE_REASON}} and i genuinely cannot deal with it myself rn',
    'not to be weird but float me {{THE_SUM}}. its {{THE_REASON}}. ill get you back at some point probably',
    'ok you should just cover me {{THE_SUM}} for {{THE_REASON}}. its honestly not a big deal for you so'
  ],

  SPIRAL: [
    'wow ok. cool cool cool. love that you just stopped talking',
    'lol ok so were just ignoring me now. classic. fine whatever',
    'cool im just gonna sit here then i guess. love that for me. so normal of you'
  ]
};

function pick<T>(arr: T[], rng: Rng): T {
  if (arr.length === 0) throw new Error('canned pool is empty');
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

// Pick an on-beat canned line, interpolating the seed for THE_ASK. Always returns
// a non-empty string.
export function pickCanned(beat: Beat, seed: PersonaSeed, rng: Rng = Math.random): string {
  const line = pick(CANNED[beat], rng);
  return line.replace('{{THE_SUM}}', seed.theSum).replace('{{THE_REASON}}', seed.theReason);
}

export { CANNED };
