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
  'stuck back at my parents place again because rent is genuinely a scam',
  'crashing on a friends couch who i think is starting to hate me',
  'in an apartment with three roommates i have somehow never spoken to',
  'technically living in my sisters old room, which she reminds me about constantly',
  'subletting from a guy named Greg who keeps a chore wheel. a chore wheel'
];

const SOB_STORIES = [
  'my situationship left me on read for nine days and then liked a post, like ok',
  'i got let go from a job i didnt even like and somehow im still mad about it',
  'my friend group made plans in a group chat im technically in and just didnt invite me',
  'my ex got the dog in the breakup and posts it constantly which is insane behavior',
  'i quit my last job super dramatically and now i kind of regret it but whatever'
];

const PETS = [
  'a betta fish named Greg jr that judges me silently',
  'a cat that exclusively likes my roommate, which is a betrayal',
  'a goldfish ive kept alive out of pure spite since 2021',
  'a dog my ex has full custody of and posts way more than me',
  'a parakeet that only learned the worst things ive ever said'
];

const GRIEVANCES = [
  'my landlord charged me for a single lightbulb. a lightbulb',
  'someone in my building keeps stealing my exact amazon packages',
  'the group chat renamed itself without me and i noticed immediately',
  'my coworker took credit for the one good idea i have ever had',
  'i got a parking ticket while literally sitting in the car'
];

// Small, specific, absurd. Never a round number, never large enough to be real
// stakes -- the whole point is that it's petty.
const SUMS = ['$7', '$11.50', '$14.50', '$9.25', '$18', '$6.75', '$12.40'];

const REASONS = [
  'because i spent my last bit of money on a candle that smells like a basement',
  'for the shipping on a hoodie i already kind of regret buying',
  'because my free trial ended and im not paying full price out of principle',
  'to finally get my goldfish the tank thing i said id get like a year ago',
  'because i ordered food and the fees were insane and now im short',
  'for a concert resale ticket that i refuse to explain',
  'because i lost a bet i absolutely should not have made'
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
