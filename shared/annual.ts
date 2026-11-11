export const ANNUAL_MAXIMUM = 36;
export const LEADERBOARD_LIMIT = 10;

export function annualCategory(points: number): 'SEC' | 'SEC+' | 'SEC Pro' {
  return points >= 32 ? 'SEC Pro' : points >= 21 ? 'SEC+' : 'SEC';
}

/** Level history colours describe the SEC level, independently of monthly performance. */
export function secLevelTier(level: string): 'bronze' | 'silver' | 'gold' | 'unavailable' {
  return level === 'SEC' ? 'bronze' : level === 'SEC+' ? 'silver' : level === 'SEC Pro' ? 'gold' : 'unavailable';
}

export function annualDots(points: number) {
  const completed = Math.max(0, Math.min(ANNUAL_MAXIMUM, Math.floor(points)));
  const remaining = ANNUAL_MAXIMUM - completed;
  const regularDotSize = 15.2;
  return Array.from({ length: ANNUAL_MAXIMUM }, (_, index) => {
    const inactive = index < remaining;
    const current = !inactive && index === remaining;
    const previous = !inactive && index === remaining + 1;
    const third = !inactive && index === remaining + 2;
    return {
      angle: 40 + index * 10, inactive, current, previous, third,
      size: current ? regularDotSize * 1.3 : previous ? regularDotSize * 1.07 : third ? regularDotSize * 1.03 : regularDotSize,
    };
  });
}

// Preserve the accepted HE rail's categorical spacing, including 27 at 68%.
export function categoryRailPosition(points: number) {
  const stops = [[20, 0], [21, 34], [27, 68], [32, 100]];
  if (points <= 20) return 0;
  for (let index = 1; index < stops.length; index++) {
    const [value, position] = stops[index];
    const [previousValue, previousPosition] = stops[index - 1];
    if (points <= value) return previousPosition + (points - previousValue) / (value - previousValue) * (position - previousPosition);
  }
  return 100;
}

export function leaderboardState(pool: number, rank: number | null) {
  return {
    visible: pool >= LEADERBOARD_LIMIT,
    places: pool >= LEADERBOARD_LIMIT ? Array.from({ length: LEADERBOARD_LIMIT }, (_, index) => index + 1) : [],
    ownRank: rank !== null && rank >= 1 && rank <= LEADERBOARD_LIMIT && rank <= pool ? rank : null,
    outside: rank !== null && rank > LEADERBOARD_LIMIT,
  };
}
