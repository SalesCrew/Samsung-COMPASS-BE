export type HistoryScope = 'division' | 'assignment';
export type DashboardHistory = { historyScope: HistoryScope; pointHistory: unknown[]; levelHistory: unknown[] };

/** Monthly reports are already assignment-scoped; the rolling premium must use the same market. */
export function dashboardPremiumRows<T extends { assignment_id: string }>(rows: readonly T[], scope: HistoryScope, assignment: string) {
  return scope === 'assignment' ? rows.filter(row => row.assignment_id === assignment) : rows;
}

/** A separate-market display does not silently define a new cohort or count a person twice. */
export function pendingMarketRanking() {
  return { pool: 0, rank: null, outsideTopTen: false, reason: 'market-scope' as const };
}

export const emptyDashboardHistory: DashboardHistory = { historyScope: 'division', pointHistory: [], levelHistory: [] };
