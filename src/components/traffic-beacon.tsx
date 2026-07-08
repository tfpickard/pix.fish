'use client';

import { useEffect } from 'react';
import { sendTrafficWalk } from '@/lib/traffic-client';

// Records a completed geodesic walk as edge traffic, once per rendered path.
// Rendered by the server /connect page when it resolves a found path; this
// client component fires the beacon on mount (consent-gated, de-duped per tab).
// It renders nothing.
export function TrafficBeacon({ nodeIds }: { nodeIds: number[] }) {
  useEffect(() => {
    sendTrafficWalk(nodeIds);
    // Serialize the ids into the dep so a genuinely different walk re-fires.
  }, [nodeIds.join('-')]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
