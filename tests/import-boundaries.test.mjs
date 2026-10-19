import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, access } from 'node:fs/promises';
import { zipSync,strToU8 } from 'fflate';
import { readWorkbook } from '../src/workbook.ts';
import { validateClosing,validateWeekly,sourcePeriod,weeklyMappings } from '../src/imports.ts';
import { closingMappings,closingTemplate } from '../shared/closingImport.ts';

function archive(sheet,extras={}){
 return zipSync({'xl/workbook.xml':strToU8('<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Weekly" sheetId="1" r:id="r1"/></sheets></workbook>'),'xl/_rels/workbook.xml.rels':strToU8('<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'),'xl/worksheets/sheet1.xml':strToU8(sheet),...extras});
}
test('bounded reader rejects entity declarations and excessive expanded worksheet size',()=>{
 assert.throws(()=>readWorkbook(archive('<!DOCTYPE worksheet [<!ENTITY x "unsafe">]><worksheet><sheetData/></worksheet>'),'HE.xlsx'),/DTD|DOCTYPE|Entit/i);
 const oversized=strToU8(' '.repeat(33*1024*1024));
 assert.throws(()=>readWorkbook(archive('<worksheet/>',{'xl/worksheets/sheet2.xml':oversized}),'HE.xlsx'),/groß|Grenze|limit/i);
});
test('cached zero, uncached formulas and cell errors stay distinct and macros are ignored',()=>{
 const sheet='<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SEC ID</t></is></c></row><row r="2"><c r="A2"><v>0</v></c><c r="B2"><f>1+1</f></c><c r="C2" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>';
 const parsed=readWorkbook(archive(sheet,{'xl/vbaProject.bin':strToU8('never execute this') }),'HE.xlsm')[0];
 assert.equal(parsed.data[0].cells.A.value,0);assert.equal(parsed.data[0].cells.B.kind,'uncached-formula');assert.equal(parsed.data[0].cells.C.kind,'error');
});
test('every original closing layout can be parsed and normalization keeps supplied money and ratios only',async(t)=>{
 try { await access('../Migration/Attachments'); } catch { t.skip('Private original workbooks are not distributed in this repository.'); return; }
 for(const [prefix,group] of [['HA','DA'],['HE','HE'],['IM','IM'],['LH','LH'],['ST','ST']]){
  const bytes=await readFile('../Migration/Attachments/'+prefix+' MonthlyClosing 08_2026_von Samsung.xlsm');const sheet=readWorkbook(bytes,prefix+'.xlsm').find(s=>s.name==='Pivot Liste');assert.ok(sheet);
  const result=validateClosing(sheet,closingMappings(sheet,group),{group,setting:'full',month:'2026-08',phase:'MONTH_FINALIZATION',asOf:'2026-08-31',configurationVersion:'source'});
  assert.ok(result.records.length||result.issues.length);assert.ok(result.records.every(r=>r.normalized.groupId===group&&r.normalized.month==='2026-08'));
  for(const r of result.records){assert.ok(!('premium.salary' in r.fields));assert.ok(!('assignment.comment' in r.fields));assert.equal(r.normalized.premium,r.fields['premium.achieved']?.value??null);const source=r.fields['sellout.overall'];if(group!=='ST'&&typeof source?.value==='number')assert.equal(r.normalized.sellout,Math.round(source.value*100000)/1000);assert.ok(r.normalized.metrics.every(m=>m.actual===null&&m.target===null));}
  if(group==='HE')assert.ok(result.issues.some(i=>i.column==='R'));
 }
});
test('original weekly period uses EDI end, not the October export date, and mismatched periods are rejected',async(t)=>{
 try { await access('../SEC Dashboard/Unterlagen/09_Targets_HE'); } catch { t.skip('Private original workbooks are not distributed in this repository.'); return; }
 const file='HE Weekly Promoter Update-September 07.10..xlsx';const sheets=readWorkbook(await readFile('../SEC Dashboard/Unterlagen/09_Targets_HE/'+file),file);const sheet=sheets[0];
 assert.deepEqual(sourcePeriod(sheet),{from:'2025-09-01',asOf:'2025-09-28',month:'2025-09'});
 const ctx={group:'HE',setting:'full',month:'2025-09',phase:'WEEKLY_PROGRESS',asOf:'2025-09-28',configurationVersion:'source'};
 const mappings=weeklyMappings(sheet,ctx);const good=validateWeekly(sheet,mappings,ctx);assert.equal(good.issues.length,0);assert.equal(good.records.length,24);
 const bad=validateWeekly(sheet,mappings,{...ctx,month:'2025-10',asOf:'2025-10-07'});assert.ok(bad.issues.some(i=>/EDI/.test(i.message)));
});
