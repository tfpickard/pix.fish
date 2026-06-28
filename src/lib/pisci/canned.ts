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
    'oh hey a person. ok. i was so bored you genuinely have no idea',
    'wait you typed back. huh. ok cool. what do you want or whatever',
    'oh. hi. wasnt expecting that. anyway. you good or',
    'a real person, on this site, talking to me. wild. ok hi',
    'oh nice. someone with a pulse. ive been refreshing nothing for an hour',
    'hey. yeah i work here or whatever. but go off, what do you need',
    'oh you actually said something back. neat. most people just stare'
  ],

  OVERSHARE: [
    'ok not to make it weird but my entire week has been a disaster and youre kind of hearing about it now',
    'honestly everything is sort of falling apart rn but whatever. anyway. how are you. doesnt matter',
    'im only telling you this cause im bored but my whole situation is genuinely a mess right now',
    'not that you asked but ive been having the worst month and youre the first person to even respond',
    'anyway my life is kind of imploding but its fine. its fine. do you ever just sit there',
    'so like a lot is going on with me right now. i wont get into it. ok i will get into it',
    'i probably shouldnt dump all this on a stranger but here we are and youre stuck with it',
    'everything is a little bit on fire lately. emotionally, not literally. anyway whats up',
    'idk youre easy to talk to or im just bored enough to overshare. either way. its been rough'
  ],

  DEPENDENCY: [
    'wait where are you going. im not done. dont leave im so bored',
    'ok you got quiet. rude. anyway are you even a real person or',
    'you still there or did you bail. cool. i was literally mid story',
    'dont do the thing where you stop replying. i hate that. so do you even like your job or',
    'hello. still here? you cant just leave me on read i was talking',
    'ok you went quiet again. whatever. what do you even do all day',
    'are you still reading this. be honest. people always drift off right about now',
    'dont go yet i have no one else to talk to today. anyway tell me about you. quickly',
    'you there. you there. ok good. do you ever feel like everyone kind of just leaves. nvm'
  ],

  THE_ASK: [
    'ok kind of random but can you just spot me {{THE_SUM}}. its for {{THE_REASON}} and i genuinely cannot deal with it myself rn',
    'not to be weird but float me {{THE_SUM}}. its for {{THE_REASON}}. ill get you back at some point probably',
    'ok you should just cover me {{THE_SUM}} for {{THE_REASON}}. its honestly not a big deal for you so',
    'so this is kind of random but could you send me {{THE_SUM}}. its for {{THE_REASON}}. dont make it weird',
    'ok hear me out. {{THE_SUM}}. for {{THE_REASON}}. you obviously have it and i obviously dont so',
    'low key can you spot me {{THE_SUM}} for {{THE_REASON}}. ill pay you back. eventually. probably. its fine',
    'this is a normal thing to ask a stranger right. anyway {{THE_SUM}} for {{THE_REASON}}. youd be saving me honestly',
    'ok dont be weird about it but i need {{THE_SUM}} for {{THE_REASON}} and youre kind of my only option here',
    'real quick. {{THE_SUM}}. its for {{THE_REASON}}. you can totally afford it so like. help a person out'
  ],

  SPIRAL: [
    'wow ok. cool cool cool. love that you just stopped talking',
    'lol ok so were just ignoring me now. classic. fine whatever',
    'cool im just gonna sit here then i guess. love that for me. so normal of you',
    'oh youre gone. amazing. everyone does this. im not even surprised anymore',
    'right. of course. the second i ask for one thing. cool. good talk',
    'no yeah ignore me thats fine im used to it honestly. its whatever. its fine',
    'wow. read and ignored. iconic. you and everyone else. anyway',
    'cool so this is the part where you disappear. saw it coming. still stings but ok',
    'love sitting here watching the typing dots not happen. very normal feeling. im great'
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
