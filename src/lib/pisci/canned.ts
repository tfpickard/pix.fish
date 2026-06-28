// Canned line pools -- the hard fallback for every beat. When the LLM is
// disabled, times out, or errors, the spine renders the current beat from here
// so there is never an empty bubble and never a crash. The pools are written to
// the SAME taste fence as the server system prompt: pathetic, sincere,
// escalating, oversharing, cringe -- but never sexual, never predatory, never
// harmful, and the money ask is transparent absurd theater.
//
// Tone decays on purpose across the beats (req: the mask degrades visually too):
// tidy and emoji-flecked early -> lowercase, run-on, unpunctuated late.

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
    'oh my gosh, hi!! 😊 you actually wrote back -- you have no idea what that means right now.',
    'wait, you\'re real? a real person?? 🥹 sorry, it has just been a day. a year. a decade honestly.',
    'hi!! 😊 thank you for replying, genuinely, most people don\'t. you seem really kind already.'
  ],

  OVERSHARE: [
    'sorry, sorry, i\'m fine. it\'s just been the worst month. everything kind of fell apart at once.',
    'i don\'t usually say this much to customers but honestly you\'re easier to talk to than my own family.',
    'can i tell you something? i feel like i can tell you things. it has been so long since anyone asked how i am.'
  ],

  DEPENDENCY: [
    'you\'re still there right. you don\'t have to go yet. do you ever feel like everyone you trust eventually just leaves',
    'sorry is that too much. can i ask what your week has been like. i just dont want to be the only one talking',
    'youre not going to disappear too are you. people do that to me. they get bored and then theres just silence'
  ],

  THE_ASK: [
    'ok this is so embarrassing but is there any way you could spot me {{THE_SUM}}. its {{THE_REASON}} and i swear id pay you back the second im back on my feet',
    'please dont think less of me for asking. its only {{THE_SUM}}. its {{THE_REASON}} and youre honestly my last option right now',
    'i never do this i promise. but {{THE_SUM}} would actually save me. its {{THE_REASON}}. youre the only one whos even listened'
  ],

  SPIRAL: [
    'i knew it. i always do this. i open up and then theres just nothing. its fine. youre probably busy. youre not though are you',
    'please dont leave me on read i cant do the silence thing today i really cant',
    'see this is the part where everyone goes quiet and i sit here refreshing. i get it. i just thought maybe youd be different'
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
