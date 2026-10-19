export { inspectWorkbook } from './workbook.ts';
import { groupMetricBlocks, qualitativeMetrics, type DASetting, type SECGroup } from './groups.ts';

export type AdminMetric = { id: string; label: string; unit: string; weight: number | null; target: number; actual: number; active: boolean; block: string; dataset?: 'sellout' | 'softbonus' };
export type ConfigVersion = { id: string; group: SECGroup['id']; setting: DASetting; effective: string; saved: string; note: string; metrics: AdminMetric[]; origin?: 'meeting-demo' | 'local' };
export type ImportPhase = 'TARGET_INITIALIZATION' | 'WEEKLY_PROGRESS' | 'MONTH_FINALIZATION';
export type ImportDatasetId = 'identity' | 'assignment' | 'snapshot' | 'sellout' | 'softbonus' | 'premium' | 'attendance' | 'annual';
export type ColumnDataType = 'auto' | 'text' | 'number' | 'percent' | 'currency' | 'date' | 'boolean';
export type SplitCategory = 'group' | 'setting' | 'block' | 'metric' | 'market' | 'person' | 'snapshot';
export type SourceColumnMapping = {
  id?: string;
  sourceSection?: string;
  column: string;
  sourceLabel: string;
  dataset: ImportDatasetId | 'ignore';
  field: string;
  dataType: ColumnDataType;
  required: boolean;
};
export type ImportVersion = {
  id: string;
  origin?: 'meeting-demo' | 'local';
  filename: string;
  group: SECGroup['id'];
  month: string;
  phase: ImportPhase;
  subtype: string;
  sheet: string;
  saved: string;
  status: 'preview' | 'released';
  fields: string[];
  mapping: Record<string, string>;
  columnMappings?: SourceColumnMapping[];
  datasets?: ImportDatasetId[];
  splitCategories?: SplitCategory[];
  changed: string[];
  carried: string[];
  closingSummary?: { records: number; otherMonths: number; warnings: number };
};
export type ExcelCell = { kind: 'value' | 'blank' | 'error' | 'uncached-formula'; value: string | number | boolean | null };
export type SheetPreview = { name: string; dimension: string; columns: { key: string; label: string; section?: string }[]; rows: number; headerRow?: number; date1904?: boolean; data?: { row: number; cells: Record<string, ExcelCell> }[] };

export const IMPORT_DATASETS: readonly { id: ImportDatasetId; label: string; short: string; description: string }[] = [
  { id: 'identity', label: 'SEC-Identität', short: 'Identität', description: 'Stabile interne und externe Personenkennungen.' },
  { id: 'assignment', label: 'Zuordnung', short: 'Zuordnung', description: 'Markt, Store, Rolle, Stunden und gültige Zuständigkeit.' },
  { id: 'snapshot', label: 'Datenstand', short: 'Datenstand', description: 'Berichtsmonat, EDI-Periode, Stichtag und Status.' },
  { id: 'sellout', label: 'Sell-out & KPI', short: 'Sell-out', description: 'Target, Ist, T/A und Gewicht je dynamischer KPI-Kategorie.' },
  { id: 'softbonus', label: 'Softbonus', short: 'Softbonus', description: 'Gesamtwert und qualitative Einzelkriterien.' },
  { id: 'premium', label: 'Prämie', short: 'Prämie', description: 'Maximal-, erreichtes und separates On-top-Ergebnis.' },
  { id: 'attendance', label: 'Attendance', short: 'Attendance', description: 'Anwesenheit, Abdeckung, Soll/Ist und Tagesstatus.' },
  { id: 'annual', label: 'Jahresstatus', short: 'Jahr', description: 'Monatspunkte, Jahrespunkte, Kategorie und Rang.' },
] as const;

export const SPLIT_CATEGORIES: readonly { id: SplitCategory; label: string; description: string }[] = [
  { id: 'group', label: 'Obergruppe', description: 'DA, HE, IM, LH oder ST' },
  { id: 'setting', label: 'Setting', description: 'z. B. DA R/VCF, Laundry/REF oder VC' },
  { id: 'block', label: 'KPI-Block', description: 'z. B. HE- und IM-Anteil bei LH' },
  { id: 'metric', label: 'KPI-Kategorie', description: 'Dynamisch aus der aktiven KPI-Version' },
  { id: 'market', label: 'Markt', description: 'Markt- oder Store-Zuordnung' },
  { id: 'person', label: 'SEC', description: 'Stabile interne Person-ID' },
  { id: 'snapshot', label: 'Datenstand', description: 'Monat, Phase und Stichtag' },
] as const;

export function defaultDatasets(phase: ImportPhase, subtype: string, group: SECGroup['id']): ImportDatasetId[] {
  const base: ImportDatasetId[] = ['identity', 'assignment', 'snapshot'];
  if (phase === 'TARGET_INITIALIZATION') return [...base, group === 'ST' ? 'softbonus' : 'sellout'];
  if (phase === 'WEEKLY_PROGRESS') return [...base, group === 'ST' ? 'softbonus' : 'sellout'];
  if (/closing/i.test(subtype)) return [...base, ...(group === 'ST' ? [] : ['sellout' as const]), 'softbonus', 'premium', 'attendance', 'annual'];
  return [...base, group === 'ST' ? 'softbonus' : 'sellout'];
}

export function defaultSplitCategories(group: SECGroup['id']): SplitCategory[] {
  return ['group', ...(group === 'DA' ? ['setting' as const] : []), ...(group === 'LH' ? ['block' as const] : []), 'metric', 'market', 'person', 'snapshot'];
}

type MappingField = { value: string; label: string; keywords?: string[] };
const staticFields: Record<Exclude<ImportDatasetId, 'sellout' | 'softbonus'>, MappingField[]> = {
  identity: [
    { value: 'person.internalId', label: 'Interne Person-ID', keywords: ['internal id'] },
    { value: 'person.externalId', label: 'SEC-Quell-ID', keywords: ['sec id', 'promoter id', 'user id'] },
    { value: 'person.name', label: 'Name', keywords: ['name'] },
  ],
  assignment: [
    { value: 'assignment.market', label: 'Markt', keywords: ['market', 'markt'] },
    { value: 'assignment.store', label: 'Store', keywords: ['store', 'shop'] },
    { value: 'assignment.secType', label: 'SEC-Typ', keywords: ['sec type', 'sec typ', 'sec'] },
    { value: 'assignment.group', label: 'Obergruppe', keywords: ['division', 'group', 'gruppe'] },
    { value: 'assignment.setting', label: 'Setting / Kategorie', keywords: ['setting', 'category'] },
    { value: 'assignment.hoursRaw', label: 'Stunden (Original)', keywords: ['hours', 'stunden'] },
    { value: 'assignment.employment', label: 'Beschäftigung', keywords: ['employment', 'anstellung'] },
  ],
  snapshot: [
    { value: 'snapshot.reportMonth', label: 'Berichtsmonat', keywords: ['monthly', 'month', 'monat'] },
    { value: 'snapshot.dataDate', label: 'Datenstichtag', keywords: ['date', 'stand'] },
    { value: 'snapshot.ediFrom', label: 'EDI von', keywords: ['edi from', 'period from'] },
    { value: 'snapshot.ediTo', label: 'EDI bis', keywords: ['edi data period', 'edi to', 'period to'] },
    { value: 'snapshot.progress', label: 'Fortschritt', keywords: ['progress'] },
    { value: 'snapshot.status', label: 'Importstatus', keywords: ['status'] },
  ],
  premium: [
    { value: 'premium.maximum', label: 'Maximalprämie', keywords: ['maximum bonus', 'max bonus'] },
    { value: 'premium.achieved', label: 'Erreichte Prämie', keywords: ['achieved bonus', 'bonus achieved'] },
    { value: 'premium.onTop', label: 'On-top / Sales Race', keywords: ['on top', 'sales race'] },
    { value: 'premium.factor', label: 'Bonusfaktor', keywords: ['bonus factor'] },
    { value: 'premium.ytd', label: 'Auszahlung Kalenderjahr', keywords: ['ytd bonus', 'annual bonus'] },
  ],
  attendance: [
    { value: 'attendance.rate', label: 'Attendance %', keywords: ['attendance'] },
    { value: 'attendance.planned', label: 'Soll-Abdeckung', keywords: ['planned', 'soll'] },
    { value: 'attendance.actual', label: 'Ist-Abdeckung', keywords: ['coverage', 'ist'] },
    { value: 'attendance.code', label: 'Tages-/Abwesenheitscode', keywords: ['absence', 'anwesenheit', 'code'] },
  ],
  annual: [
    { value: 'annual.monthPoints', label: 'Monatspunkte', keywords: ['month points', 'monatspunkte'] },
    { value: 'annual.points', label: 'Jahrespunkte', keywords: ['annual points', 'jahrespunkte'] },
    { value: 'annual.category', label: 'Jahreskategorie', keywords: ['category', 'kategorie'] },
    { value: 'annual.rank', label: 'Rang', keywords: ['rank', 'rang'] },
  ],
};

export function mappingFieldsFor(dataset: ImportDatasetId, group: SECGroup['id'], setting: DASetting, metrics?: AdminMetric[]): MappingField[] {
  if (dataset === 'sellout') {
    const configured = (metrics?.length ? metrics : initialMetrics(group, setting)).filter(metric => metric.active && metric.dataset !== 'softbonus');
    return configured.flatMap(metric => [
      { value: `${metric.id}.target`, label: `${metric.label} · Target`, keywords: [metric.label, 'target'] },
      { value: `${metric.id}.actual`, label: `${metric.label} · Ist`, keywords: [metric.label, 'actual', 'achieved'] },
      { value: `${metric.id}.achievement`, label: `${metric.label} · T/A %`, keywords: [metric.label, 't/a', 'achievement'] },
      { value: `${metric.id}.weight`, label: `${metric.label} · Gewicht`, keywords: [metric.label, 'weight', 'gewicht'] },
    ]);
  }
  if (dataset === 'softbonus') {
    const configured = metrics?.filter(metric => metric.active && (metric.dataset === 'softbonus' || group === 'ST')) ?? [];
    const definitions = [...qualitativeMetrics(group).filter(metric => !configured.some(item => item.id === metric.key)).map(metric => ({ id: metric.key, label: metric.label })), ...configured];
    return [
      { value: 'softbonus.overall', label: 'Softbonus gesamt', keywords: ['softbonus', 'qualitative'] },
      ...definitions.flatMap(metric => [
        { value: `${metric.id}.actual`, label: `${metric.label} · Ist`, keywords: [metric.label, 'actual', 'achieved'] },
        { value: `${metric.id}.target`, label: `${metric.label} · Ziel`, keywords: [metric.label, 'target'] },
      ]),
    ];
  }
  return staticFields[dataset];
}

function suggestedDataType(label: string): ColumnDataType {
  const value = label.toLowerCase();
  if (/%|achievement|t\/a|attendance|share|ihs/.test(value)) return 'percent';
  if (/asp|bonus|premium|prämie|€|eur/.test(value)) return 'currency';
  if (/date|period|monat|month/.test(value)) return 'date';
  if (/hours|pcs|target|actual|achieved|points|weight/.test(value)) return 'number';
  return 'auto';
}

export function suggestColumnMappings(sheet: SheetPreview, group: SECGroup['id'], setting: DASetting, metrics?: AdminMetric[]): SourceColumnMapping[] {
  const datasets = IMPORT_DATASETS.map(item => item.id);
  const usedDestinations = new Set<string>();
  return sheet.columns.map(column => {
    const label = column.label.toLowerCase();
    let match: { dataset: ImportDatasetId; field: MappingField; score: number } | undefined;
    for (const dataset of datasets) {
      const fields = mappingFieldsFor(dataset, group, setting, metrics);
      for (const field of fields) {
        if (usedDestinations.has(`${dataset}:${field.value}`)) continue;
        const keywords = field.keywords?.map(keyword => keyword.toLowerCase()) ?? [];
        const hits = keywords.filter(keyword => label.includes(keyword));
        const isMetricField = dataset === 'sellout' || (dataset === 'softbonus' && field.value !== 'softbonus.overall');
        if (!hits.length || (isMetricField && hits.length < Math.min(2, keywords.length))) continue;
        const score = hits.reduce((total, keyword) => total + keyword.length, 0) + hits.length * 8;
        if (!match || score > match.score) match = { dataset, field, score };
      }
    }
    if (match) usedDestinations.add(`${match.dataset}:${match.field.value}`);
    return {
      column: column.key,
      sourceLabel: column.label,
      dataset: match?.dataset ?? 'ignore',
      field: match?.field.value ?? '',
      dataType: suggestedDataType(column.label),
      required: Boolean(match && ['person.externalId', 'assignment.market'].includes(match.field.value)),
    };
  });
}

export function initialMetrics(group: SECGroup['id'], setting: DASetting): AdminMetric[] {
  return groupMetricBlocks(group, setting).flatMap(block => block.metrics.map(metric => ({
    id: metric.key, label: metric.label, unit: metric.unit, weight: metric.weight, target: metric.unit === '€' ? 900 : metric.unit === '%' ? 95 : 50,
    actual: metric.unit === '€' ? 927 : metric.unit === '%' ? 93 : 48, active: true, block: block.label, dataset: group === 'ST' ? 'softbonus' : 'sellout',
  })));
}

export function weightChecks(metrics: AdminMetric[]) {
  return Object.entries(Object.groupBy(metrics.filter(metric => metric.active), metric => metric.block)).map(([block, items]) => ({
    block, total: Math.round((items ?? []).reduce((sum, item) => sum + (item.weight ?? 0), 0) * 100) / 100,
    unresolved: (items ?? []).some(item => item.weight === null),
  }));
}
