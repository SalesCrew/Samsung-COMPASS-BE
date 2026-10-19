export type SECGroup = {
  id: 'HE' | 'DA' | 'IM' | 'LH' | 'ST';
  description: string;
  showPointsRules: boolean;
  template: 'HE' | 'configured';
};

export type PerformanceTier = 'gold' | 'silver' | 'bronze' | 'unresolved' | 'unavailable';

export function performanceTier(group: SECGroup['id'], sellout: number | null, softbonus: number | null): PerformanceTier {
  if (softbonus === null || (group !== 'ST' && sellout === null)) return 'unavailable';
  if (group === 'ST') return softbonus >= 95 ? 'gold' : softbonus >= 90 ? 'silver' : 'bronze';
  if (sellout! >= 95 && softbonus >= 95) return 'gold';
  if (sellout! >= 90 && softbonus >= 90) return 'silver';
  if (sellout! < 90 && softbonus < 90) return 'bronze';
  return 'unresolved';
}

export const TIER_LABELS: Record<PerformanceTier, string> = {
  gold: 'Gold', silver: 'Silber', bronze: 'Bronze', unresolved: 'Kategorie offen', unavailable: 'Noch kein Ergebnis',
};

export function premiumModel(group: SECGroup['id']) {
  if (group === 'ST') return { formula: '100% Softbonus', detail: 'Closing-Modell · Geldfreigabe offen', hasOnTop: false };
  if (group === 'LH') return { formula: '85% Leistung · 15% Softbonus', detail: 'Leistung: 50% HE · 50% IM', hasOnTop: false };
  return { formula: '85% Leistung · 15% Softbonus', detail: group === 'DA' ? 'VC On-top separat' : 'On-top separat', hasOnTop: true };
}

// The accepted HE sample is retained. Other groups expose source-backed
// configurations without reusing HE results or publishing personal source data.
export const SEC_GROUPS: readonly SECGroup[] = [
  { id: 'HE', description: 'TV/AV Promotoren', showPointsRules: true, template: 'HE' },
  { id: 'DA', description: 'Haushaltsabteilung', showPointsRules: true, template: 'configured' },
  { id: 'IM', description: 'Handy Promotoren', showPointsRules: true, template: 'configured' },
  { id: 'LH', description: 'HE + IM · 4 Personen', showPointsRules: true, template: 'configured' },
  { id: 'ST', description: 'SmartHome Promotor', showPointsRules: false, template: 'configured' },
];

export type DASetting = 'full' | 'laundry-ref' | 'vc';
export type MetricDefinition = { key: string; label: string; weight: number | null; icon: 'tv' | 'speaker' | 'euro' | 'home' | 'phone' | 'watch' | 'tablet' | 'headphones' | 'laundry' | 'fridge' | 'vacuum' | 'check'; unit: string; block?: string };
export type MetricBlock = { label: string; note: string; metrics: readonly MetricDefinition[] };

export const DA_SETTINGS: { value: DASetting; label: string }[] = [
  { value: 'full', label: 'R/VCF · Laundry, REF & VC' },
  { value: 'laundry-ref', label: 'Laundry / REF' },
  { value: 'vc', label: 'VC · Stick & Premium' },
];

// HE closing June 2026 / accepted UI. The Level-Up PDF swaps ASP and AV;
// do not silently resolve this source conflict or calculate a new overall score.
export const HE_METRICS: readonly MetricDefinition[] = [
  { key: 'units', label: 'TV Units', weight: 30, icon: 'tv', unit: 'Stück' },
  { key: 'soundbar', label: 'Soundbar / AV', weight: 15, icon: 'speaker', unit: 'Stück' },
  { key: 'asp', label: 'TV ASP', weight: 20, icon: 'euro', unit: '€' },
  { key: 'share', label: 'In-house Share', weight: 35, icon: 'home', unit: '%' },
];
export const IM_METRICS: readonly MetricDefinition[] = [
  { key: 'flagship', label: 'Flagship / Premium', weight: 40, icon: 'phone', unit: 'Stück' },
  { key: 'a-series', label: 'A-Series', weight: 20, icon: 'phone', unit: 'Stück' },
  { key: 'hhp-asp', label: 'HHP ASP', weight: 10, icon: 'euro', unit: '€' },
  { key: 'wear', label: 'Wear & TWS', weight: 10, icon: 'watch', unit: 'Stück' },
  { key: 'tablet', label: 'Tablet', weight: 10, icon: 'tablet', unit: 'Stück' },
  { key: 'accessories', label: 'Accessories', weight: 10, icon: 'headphones', unit: 'Stück' },
];
const DA_METRICS: readonly MetricDefinition[] = [
  { key: 'laundry', label: 'Laundry TTL', weight: 30, icon: 'laundry', unit: 'Stück' },
  { key: 'ref', label: 'REF TTL', weight: 30, icon: 'fridge', unit: 'Stück' },
  { key: 'vc-stick', label: 'VC Stick', weight: 30, icon: 'vacuum', unit: 'Stück' },
  { key: 'vc-premium', label: 'VC Stick Premium', weight: 10, icon: 'vacuum', unit: 'Stück' },
];
export const ST_METRICS: readonly MetricDefinition[] = [
  { key: 'satisfaction', label: 'Marktzufriedenheit', weight: 35, icon: 'check', unit: '%' },
  { key: 'pos', label: 'POS-Bewertung', weight: 25, icon: 'home', unit: '%' },
  { key: 'samsung-plus', label: 'Samsung+-Aktivität', weight: 15, icon: 'phone', unit: '%' },
  { key: 'knowledge', label: 'Mystery Shopping / Wissenstest', weight: 25, icon: 'check', unit: '%' },
];

export function groupMetricBlocks(group: SECGroup['id'], setting: DASetting = 'full'): MetricBlock[] {
  if (group === 'HE') return [{ label: 'HE Sell-out', note: 'Closing-Gewichte · ASP/AV noch abzugleichen', metrics: HE_METRICS }];
  if (group === 'DA') {
    const metrics = setting === 'laundry-ref' ? DA_METRICS.slice(0, 2).map(metric => ({ ...metric, weight: 50 }))
      : setting === 'vc' ? DA_METRICS.slice(2).map((metric, i) => ({ ...metric, weight: i === 0 ? 90 : 10 })) : DA_METRICS;
    return [{ label: DA_SETTINGS.find(option => option.value === setting)!.label, note: 'Gewichtung innerhalb Sell-out · Level Up 2026', metrics }];
  }
  if (group === 'IM') return [{ label: 'IM Sell-out', note: 'Gewichtung innerhalb Sell-out · Level Up 2026', metrics: IM_METRICS }];
  if (group === 'LH') return [
    { label: 'HE · 50% des Sell-outs', note: 'Closing Juni 2026 · ASP/AV-Gewichte noch offen', metrics: HE_METRICS.map(metric => ({ ...metric, key: `he-${metric.key}` })) },
    { label: 'IM · 50% des Sell-outs', note: 'Gewichte innerhalb IM · Kombination laut Closing', metrics: IM_METRICS.map(metric => ({ ...metric, key: `im-${metric.key}` })) },
  ];
  return [{ label: 'Deine Bewertung', note: 'Closing Juni 2026 · aktuelles Kriterienmodell zu bestätigen', metrics: ST_METRICS }];
}

export function qualitativeMetrics(group: SECGroup['id']): readonly MetricDefinition[] {
  if (group === 'ST') return ST_METRICS;
  if (group === 'LH') return [
    { key: 'lh-pos', label: 'POS & Auftreten', weight: null, icon: 'home', unit: '%' },
    { key: 'lh-tasks', label: 'Meldungen & Aufgaben', weight: null, icon: 'check', unit: '%' },
    { key: 'lh-plus', label: 'Samsung+-Aktivität', weight: null, icon: 'phone', unit: '%' },
    { key: 'lh-reporting', label: 'Reporting & HE-Planogramm', weight: null, icon: 'check', unit: '%' },
  ];
  return [
    { key: 'project', label: 'Projektleiterbewertung', weight: 100 / 3, icon: 'check', unit: '%' },
    { key: 'knowledge', label: 'Wissenstest / Mystery Shopping', weight: 100 / 3, icon: 'check', unit: '%' },
    { key: 'reporting', label: group === 'IM' ? 'Reporting / Surveys' : 'Reporting / Surveys / Planogramm', weight: 100 / 3, icon: 'check', unit: '%' },
  ];
}

export function groupKpiOptions(group: SECGroup['id'], setting: DASetting) {
  return [
    { value: 'all', label: group === 'ST' ? 'Alle Kriterien' : 'Alle KPIs' },
    { value: 'below', label: 'Unter 100 %' },
    ...groupMetricBlocks(group, setting).flatMap(block => block.metrics.map(metric => ({ value: metric.key, label: group === 'LH' ? `${block.label.slice(0, 2)} · ${metric.label}` : metric.label }))),
  ];
}

export const GROUP_GAPS: Record<SECGroup['id'], readonly string[]> = {
  HE: ['ASP/AV: Level-Up-PDF 15/20 %, Closing & bisherige UI 20/15 %. Welche Gewichte gelten?', 'Welche anonymisierten Monats-/Jahres-Prämienwerte dürfen in die Vorschau? On-top weiterhin separat?'],
  DA: ['Soll die UI-Gruppe DA heißen, obwohl die Originalquellen HA verwenden? Welches der drei KPI-Settings gilt je SEC/Markt?', 'VC-Stretch gilt bei mehr als 150 %. Höhe, Caps und Auszahlungsregel fehlen.'],
  IM: ['Gilt für Jahrespunkte das Kalenderjahr? Der separate SOTY-Zeitraum läuft November–Oktober.', 'Welche anonymisierten Ergebnis- und Prämienwerte dürfen in die Vorschau?'],
  LH: ['Bleibt die Kombination 50 % HE / 50 % IM? Wie lauten die aktuellen Softbonus-Untergewichte?', 'Ranking erst ab zehn Personen, nur Top 10. Bleibt der Vergleichspool auf LH begrenzt oder wird er divisionsübergreifend gebildet?'],
  ST: ['Sind die Kriterien 35/25/15/25 % aus Juni 2026 weiterhin gültig?', 'Gelten Jahrespunkte/Kategorien und gibt es eine Geldprämie? Meeting und Closing widersprechen sich.'],
};

// Display the supplied rules literally. In particular, do not infer a Bronze
// fallback when only one of Sell-out / Softbonus is below 90%.
export const MONTHLY_POINTS_RULES = [
  { label: 'Bronze', points: 1, sellout: '< 90%', softbonus: '< 90%' },
  { label: 'Silber', points: 2, sellout: '≥ 90%', softbonus: '≥ 90%' },
  { label: 'Gold', points: 3, sellout: '≥ 95%', softbonus: '≥ 95%' },
] as const;

export const ANNUAL_CATEGORY_RULES = [
  { label: 'SEC', range: '0–20 Punkte' },
  { label: 'SEC+', range: '21–31 Punkte' },
  { label: 'SEC Pro', range: 'ab 32 Punkten' },
] as const;
