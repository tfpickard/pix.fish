// Per-session persona seed generator. Pure, with an injectable RNG so the test
// suite is deterministic and a session stays internally consistent. Generated
// once at session start (client side), stashed in sessionStorage, and sent to
// the server each turn so the LLM elaborates from the SAME fake crisis all
// conversation long.
//
// Everything in here is fiction by construction. The money ask is transparent
// absurd theater: a small, specific, ridiculous sum and a pathetic reason. It
// never routes to a real payment method and never collects real info.

import type { PersonaSeed } from './types';

type Rng = () => number;

const LIVING_SITUATIONS = [
  'currently living in my cousin Dwayne\'s sunroom, which is technically a porch',
  'house-sitting a place whose owners stopped answering my texts three weeks ago',
  'between apartments, which is a generous way of saying I sleep in my Corolla',
  'subletting a room from a man named Gary who only communicates in sticky notes',
  'back at my mom\'s, in the room she now calls "the craft space"'
];

const SOB_STORIES = [
  'my fiance left me for our couples therapist, who I had recommended',
  'I got let go from the aquarium gift shop after fourteen loyal years',
  'my band kicked me out the week before our first paid gig, over "vibes"',
  'my sister stopped speaking to me in March and I still don\'t know what I did',
  'I missed my own surprise party because nobody told me where it was'
];

const PETS = [
  'my betta fish, Sir Reginald, who is the only one who never judged me',
  'a senior chihuahua named Pasta who I am not technically allowed to have here',
  'a parakeet that only says my ex\'s name',
  'a goldfish I won at a fair in 2019 that has outlived everything else in my life',
  'a cat named Brenda who I am fairly sure is plotting against me'
];

const GRIEVANCES = [
  'my landlord changed the locks while I was at the laundromat',
  'my old boss still has my good stapler and will not return my calls',
  'the group chat made a new group chat without me in it',
  'my neighbor reported my wind chimes and I have never recovered',
  'the DMV lost my paperwork twice and somehow blamed me both times'
];

// Small, specific, absurd. Never a round number, never large enough to be real
// stakes -- the whole point is that it's pathetic.
const SUMS = ['$7', '$11.50', '$14.50', '$9.25', '$18', '$6.75', '$12.40'];

const REASONS = [
  'to get my betta fish\'s tank heater out of layaway',
  'to renew the parking permit for a car that no longer runs',
  'to buy back my own bowling ball from a pawn shop before Friday',
  'to cover the late fee on a library book about moving on',
  'to ship a sweater to someone who has asked me to stop',
  'to reactivate the phone plan my mother is on so she can call me',
  'for a bus ticket to a job interview I am 80 percent sure is a scam'
];

function pick<T>(arr: T[], rng: Rng): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

export function makeSeed(rng: Rng = Math.random): PersonaSeed {
  return {
    livingSituation: pick(LIVING_SITUATIONS, rng),
    sobStory: pick(SOB_STORIES, rng),
    pet: pick(PETS, rng),
    grievance: pick(GRIEVANCES, rng),
    theSum: pick(SUMS, rng),
    theReason: pick(REASONS, rng)
  };
}

// Flatten the seed into the {{PERSONA_SEED}} block the system prompt expects.
// Kept here (not in the server module) so the canned pools and the prompt share
// one source of truth for the fake biography.
export function seedToNarrative(seed: PersonaSeed): string {
  return [
    `You are ${seed.livingSituation}.`,
    `The thing that broke you recently: ${seed.sobStory}.`,
    `The one constant in your life is ${seed.pet}.`,
    `A grievance you cannot let go of: ${seed.grievance}.`
  ].join(' ');
}
