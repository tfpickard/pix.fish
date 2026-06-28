// Boids-style steering for the wandering state. Pure math: given a fish, the
// other fish, the viewport bounds, and a wander target, return an acceleration
// vector (px/s^2) for this frame. The single rAF loop integrates it.
//
// Reynolds model: each rule contributes a desired-direction vector; their
// weighted sum is turned into a desired velocity (MAX_SPEED in that direction),
// and the returned steering is (desiredVel - currentVel) capped to MAX_FORCE, so
// the result stays bounded no matter how many rules fire at once. Chase/avoid is
// folded in here too: predator-leaning fish steer toward smaller nearby fish,
// prey-leaning fish flee larger ones.

import type { EntityRuntime, Vec2 } from './entity';
import {
  AVOID_WEIGHT,
  CHASE_RADIUS,
  CHASE_SIZE_RATIO,
  CHASE_WEIGHT,
  EDGE_MARGIN,
  EDGE_WEIGHT,
  MAX_FORCE,
  MAX_SPEED,
  NEIGHBOR_RADIUS,
  SEPARATION_RADIUS,
  TEMPERAMENT_DEADZONE,
  WANDER_WEIGHT
} from './sim-config';

export function vlen(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function vnorm(v: Vec2): Vec2 {
  const l = vlen(v);
  return l > 1e-6 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
}

export function vclamp(v: Vec2, max: number): Vec2 {
  const l = vlen(v);
  return l > max ? { x: (v.x / l) * max, y: (v.y / l) * max } : v;
}

interface SteerInput {
  self: EntityRuntime;
  others: EntityRuntime[];
  bounds: { w: number; h: number };
  wanderTarget: Vec2;
}

export function computeSteering({ self, others, bounds, wanderTarget }: SteerInput): Vec2 {
  const f: Vec2 = { x: 0, y: 0 };
  const social = 0.4 + self.genotype.sociability;

  // Separation -- push away from anyone too close, stronger the closer they are.
  const sep: Vec2 = { x: 0, y: 0 };
  let sepN = 0;
  // Alignment / cohesion accumulators over the wider neighbor radius.
  const avgVel: Vec2 = { x: 0, y: 0 };
  const center: Vec2 = { x: 0, y: 0 };
  let neighN = 0;
  // Chase / avoid candidate.
  let bestTargetDist = Infinity;
  let chaseDir: Vec2 | null = null;

  const temperament = self.genotype.temperament;
  const wantsChase = temperament > TEMPERAMENT_DEADZONE;
  const wantsAvoid = temperament < -TEMPERAMENT_DEADZONE;

  for (const o of others) {
    const dx = self.pos.x - o.pos.x;
    const dy = self.pos.y - o.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-3) continue;

    if (dist < SEPARATION_RADIUS) {
      const strength = 1 - dist / SEPARATION_RADIUS;
      sep.x += (dx / dist) * strength;
      sep.y += (dy / dist) * strength;
      sepN++;
    }

    if (dist < NEIGHBOR_RADIUS) {
      avgVel.x += o.vel.x;
      avgVel.y += o.vel.y;
      center.x += o.pos.x;
      center.y += o.pos.y;
      neighN++;
    }

    if ((wantsChase || wantsAvoid) && dist < CHASE_RADIUS) {
      const smallerOther = self.currentSize >= o.currentSize * CHASE_SIZE_RATIO;
      const largerOther = o.currentSize >= self.currentSize * CHASE_SIZE_RATIO;
      if ((wantsChase && smallerOther) || (wantsAvoid && largerOther)) {
        if (dist < bestTargetDist) {
          bestTargetDist = dist;
          // Chase: toward the other. Avoid: away from it.
          chaseDir = wantsChase
            ? { x: -dx / dist, y: -dy / dist }
            : { x: dx / dist, y: dy / dist };
        }
      }
    }
  }

  if (sepN > 0) {
    const d = vnorm(sep);
    f.x += d.x * self.boids.separation;
    f.y += d.y * self.boids.separation;
  }

  if (neighN > 0) {
    // Alignment.
    const ad = vnorm({ x: avgVel.x / neighN, y: avgVel.y / neighN });
    f.x += ad.x * self.boids.alignment * social;
    f.y += ad.y * self.boids.alignment * social;
    // Cohesion -- toward the local center of mass.
    const cd = vnorm({
      x: center.x / neighN - self.pos.x,
      y: center.y / neighN - self.pos.y
    });
    f.x += cd.x * self.boids.cohesion * social;
    f.y += cd.y * self.boids.cohesion * social;
  }

  if (chaseDir) {
    const w = wantsChase ? CHASE_WEIGHT * temperament : AVOID_WEIGHT * -temperament;
    f.x += chaseDir.x * w;
    f.y += chaseDir.y * w;
  }

  // Wander -- drift toward the loose wander target.
  const wd = vnorm({ x: wanderTarget.x - self.pos.x, y: wanderTarget.y - self.pos.y });
  const wanderW = WANDER_WEIGHT * (0.5 + self.genotype.wanderlust);
  f.x += wd.x * wanderW;
  f.y += wd.y * wanderW;

  // Soft edges -- a turn-back force that ramps up within the margin.
  if (self.pos.x < EDGE_MARGIN) f.x += (1 - self.pos.x / EDGE_MARGIN) * EDGE_WEIGHT;
  else if (self.pos.x > bounds.w - EDGE_MARGIN)
    f.x -= (1 - (bounds.w - self.pos.x) / EDGE_MARGIN) * EDGE_WEIGHT;
  if (self.pos.y < EDGE_MARGIN) f.y += (1 - self.pos.y / EDGE_MARGIN) * EDGE_WEIGHT;
  else if (self.pos.y > bounds.h - EDGE_MARGIN)
    f.y -= (1 - (bounds.h - self.pos.y) / EDGE_MARGIN) * EDGE_WEIGHT;

  // Turn the summed desire into a capped steering acceleration.
  const desired = vnorm(f);
  const steer: Vec2 = {
    x: desired.x * MAX_SPEED - self.vel.x,
    y: desired.y * MAX_SPEED - self.vel.y
  };
  return vclamp(steer, MAX_FORCE);
}
