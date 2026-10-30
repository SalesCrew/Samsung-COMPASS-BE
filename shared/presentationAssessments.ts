/** Explicit, fictional presentation examples, never an inferred real assessment schedule. */
const assessmentByMonth: Readonly<Record<string, string>> = {
  '2026-08': 'Wissenstest',
  '2026-09': 'Mystery Shopping',
};

export function presentationAssessmentLabel(month: string, fallback: string): string {
  return assessmentByMonth[month] ?? fallback;
}
