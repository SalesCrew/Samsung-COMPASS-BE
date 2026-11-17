import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {zipSync,strToU8} from 'fflate';
import {readWorkbook} from '../src/workbook.ts';
import {normalizeClosing,validateClosing,validateWeekly} from '../src/imports.ts';
import {withReportComments} from '../src/reportComments.ts';
import {closingMappings} from '../shared/closingImport.ts';
import {PROJECT_ASSESSMENT_ITEMS} from '../shared/projectAssessment.ts';

const rel=(id,type,target,extra='')=>'<Relationship Id="'+id+'" Type="https://schemas.test/'+type+'" Target="'+target+'" '+extra+'/>';
function workbook({classic='',threaded='',relations='',extra={}}={}){
 return zipSync(Object.fromEntries(Object.entries({
  'xl/workbook.xml':'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Pivot Liste" sheetId="1" r:id="s1"/><sheet name="Other" sheetId="2" r:id="s2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="s1" Target="worksheets/sheet1.xml"/><Relationship Id="s2" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row r="2"><c r="N2" t="inlineStr"><is><t>Wissenstest</t></is></c></row><row r="3"><c r="N3"><v>0</v></c></row><row r="4"><c r="N4"><v>1</v></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml':'<worksheet><sheetData><row r="3"><c r="N3"><v>1</v></c></row></sheetData></worksheet>',
  'xl/worksheets/_rels/sheet1.xml.rels':'<Relationships>'+rel('c','comments','../comments/comment1.xml')+(threaded?rel('t','threadedComment','../threadedComments/thread1.xml'):'')+relations+'</Relationships>',
  'xl/comments/comment1.xml':classic||'<comments/>',
  ...(threaded?{'xl/threadedComments/thread1.xml':threaded}:{}),...extra,
 }).map(([path,text])=>[path,strToU8(text)])));
}
const note=(ref,text)=>'<comment ref="'+ref+'" authorId="0"><text><r><t>Author:</t></r><r><t>'+text+'</t></r></text></comment>';
const classic=items=>'<comments><authors><author>Author</author></authors><commentList>'+items+'</commentList></comments>';
const modern=text=>'<ThreadedComments><threadedComment ref="N3" personId="private-author-id"><text>'+text+'</text></threadedComment></ThreadedComments>';
const cell=(sheet,row,col)=>sheet.allRows.find(r=>r.row===row).cells[col];

test('threaded hover comments replace classic fallback copies, retain replies once and never include authors',()=>{
 const sheets=readWorkbook(workbook({classic:classic(note('N3','[Threaded comment] compatibility copy')),threaded:modern('Verified reason') .replace('</ThreadedComments>','<threadedComment ref="N3" parentId="root" personId="another"><text>Follow-up</text></threadedComment><threadedComment ref="N3" personId="another"><text>Follow-up</text></threadedComment></ThreadedComments>')}),'HE.xlsx');
 assert.deepEqual(cell(sheets[0],3,'N'),{kind:'value',value:0,comments:[{text:'Verified reason',sheet:'Pivot Liste',cell:'N3'},{text:'Follow-up',sheet:'Pivot Liste',cell:'N3'}]});
 assert.equal(cell(sheets[0],4,'N').comments,undefined);assert.equal(cell(sheets[1],3,'N').comments,undefined);
 assert.doesNotMatch(JSON.stringify(cell(sheets[0],3,'N').comments),/Author|personId|private-author|compatibility/);
});
test('classic rich text, newlines and notes on empty cells keep their exact source, without cross-row inheritance',()=>{
 const sheet=readWorkbook(workbook({classic:classic(note('N3','First line\nSecond line')+note('O3','Empty result explanation')+note('N2','Header only'))}),'HE.xlsx')[0];
 assert.equal(cell(sheet,3,'N').comments[0].text,'First line\nSecond line');assert.equal(cell(sheet,3,'O').kind,'blank');
 assert.equal(cell(sheet,3,'O').comments[0].cell,'O3');assert.equal(cell(sheet,4,'N').comments,undefined);
});
test('unlinked and external comment parts cannot attach notes; unsupported fallback and unsafe XML block import',()=>{
 const bytes=workbook({classic:classic(note('N3','Safe')),relations:rel('outside','comments','https://outside.invalid/comments.xml','TargetMode="External"'),extra:{'xl/comments/unlinked.xml':classic(note('N4','Foreign'))}});
 const sheet=readWorkbook(bytes,'HE.xlsx')[0];assert.equal(cell(sheet,3,'N').comments[0].text,'Safe');assert.equal(cell(sheet,4,'N').comments,undefined);
 assert.throws(()=>readWorkbook(workbook({classic:'<!DOCTYPE comments [<!ENTITY x "unsafe">]><comments/>'}),'HE.xlsx'),/Entit|Dokumenttypen/);
 assert.throws(()=>readWorkbook(workbook({classic:classic(note('N3','x'.repeat(8001)))}),'HE.xlsx'),/8.000/);
 assert.throws(()=>readWorkbook(workbook({classic:'<comments><commentList><comment ref="N3"><text><t>[Threaded comment] fallback</t></text></comment></commentList></comments>'}),'HE.xlsx'),/Threadkommentar/);
});
const comment=text=>[{text,sheet:'Pivot Liste',cell:'N3'}];
test('closing mapping keeps notes at their own criterion and PL child; salary/identity/free HR comments stay excluded',()=>{
 const field=(value,text)=>({kind:'value',value,sourceColumn:'N',comments:comment(text)});
 const fields={'person.externalId':field('synthetic','Private identity note'),'assignment.comment':field('HR','Excluded HR'),'premium.salary':field(999,'Excluded salary'),'softbonus.overall':field(.91,'Aggregate'),'softbonus.wissenstest':field(0,'True zero reason'),'softbonus.pl-bewertung':field(.93,'Parent reason'),[PROJECT_ASSESSMENT_ITEMS[0][0]]:field(.8,'Child reason'),'flagship.achievement':field(1.05,'Sales reason')};
 const r=normalizeClosing({row:3,month:'2026-09',fields},{group:'IM',setting:'full',month:'2026-09',asOf:'2026-09-30',phase:'MONTH_FINALIZATION',configurationVersion:'source'});
 assert.equal(r.normalized.softbonus,91);assert.equal(r.normalized.qualitative.find(m=>m.key==='softbonus.wissenstest').achievement,0);
 assert.equal(r.normalized.qualitative.find(m=>m.key==='softbonus.wissenstest').comments[0].text,'True zero reason');
 assert.equal(r.normalized.qualitative.find(m=>m.key==='softbonus.pl-bewertung').details[0].comments[0].text,'Child reason');
 assert.equal(r.normalized.metrics.find(m=>m.key==='flagship').comments[0].text,'Sales reason');
 assert.equal(r.fields['person.externalId'].comments,undefined);assert.equal(r.fields['assignment.comment'],undefined);assert.equal(r.fields['premium.salary'],undefined);
 assert.equal(r.fields['softbonus.overall'].comments,undefined);
});
test('weekly target and actual comments survive conversion without changing signed numbers or spreading to another row',()=>{
 const col=(key,label)=>({key,label});const header=[col('A','SEC ID'),col('B','Markt'),...['Units Target','Units Actual','Soundbar Target','Soundbar Actual','ASP Target','ASP Actual','Share Target','Share Actual'].map((label,i)=>col(String.fromCharCode(67+i),label))];
 const v=value=>({kind:'value',value});const data=[{row:2,cells:{A:v('Synthetic'),B:v('Test market'),...Object.fromEntries(['C','D','E','F','G','H','I','J'].map(c=>[c,v(c==='D'?-5:100)]))}}];data[0].cells.C.comments=comment('Target reason');data[0].cells.D.comments=comment('Actual reason');
 const sheet={name:'Weekly',columns:header,allRows:[],data,headerRow:1,rows:2,dimension:'A1:J2'};
 const ctx={group:'HE',setting:'full',month:'2026-11',asOf:'2026-11-17',phase:'WEEKLY_PROGRESS',configurationVersion:'source'};
 const mappings=[{id:'id',column:'A',field:'person.externalId',sourceLabel:'ID',dataset:'identity',dataType:'text'},...['units','soundbar','asp','share'].flatMap((key,i)=>['target','actual'].map((kind,j)=>({id:key+kind,column:String.fromCharCode(67+i*2+j),field:key+'.'+kind,sourceLabel:key,dataset:'sellout',dataType:'number'})))];
 const r=validateWeekly(sheet,mappings,ctx);assert.equal(r.issues.length,0);assert.equal(r.records[0].normalized.metrics[0].actual,-5);assert.equal(r.records[0].normalized.metrics[0].comments.length,2);assert.equal(r.records[0].normalized.metrics[1].comments,undefined);
});
test('historical annotation lookup is exact to publication and criterion, preserves native comments and never changes a score',()=>{
 const metric={key:'test',achievement:0,resultState:'value'};
 const rows=[{id:'old',payload:{qualitative:[metric,{key:'parent',details:[metric]}],softbonus:93}},{id:'correction',payload:{qualitative:[metric]}},{id:'foreign',payload:{qualitative:[metric]}}],before=JSON.stringify(rows);
 const output=withReportComments(rows,[{report_id:'old',metric_key:'test',comments:comment('Old source only')},{report_id:'old',metric_key:'absent',comments:comment('Ignore')}]);
 assert.equal(output[0].payload.qualitative[0].comments[0].text,'Old source only');assert.equal(output[0].payload.qualitative[1].details[0].comments[0].text,'Old source only');
 assert.equal(output[1].payload.qualitative[0].comments,undefined);assert.equal(output[2].payload.qualitative[0].comments,undefined);assert.equal(JSON.stringify(rows),before);assert.equal(output[0].payload.softbonus,93);
 const native=[{id:'old',payload:{qualitative:[{...metric,comments:comment('Native')} ]}}];
 assert.equal(withReportComments(native,[{report_id:'old',metric_key:'test',comments:comment('Backfill')}])[0].payload.qualitative[0].comments[0].text,'Native');
});
const originals=existsSync('../Migration/Attachments/HE MonthlyClosing 08_2026_von Samsung.xlsm');
test('all five original layouts contain readable hover comments; only mapped personal metrics carry them',{skip:!originals},async()=>{
 for(const [prefix,group]of [['HA','DA'],['HE','HE'],['IM','IM'],['LH','LH'],['ST','ST']]){
  const filename=prefix+' MonthlyClosing 08_2026_von Samsung.xlsm',sheet=readWorkbook(await readFile('../Migration/Attachments/'+filename),filename).find(s=>s.name==='Pivot Liste');
  assert(sheet.data.some(r=>Object.values(r.cells).some(c=>c.comments?.length)));
  const result=validateClosing(sheet,closingMappings(sheet,group),{group,setting:'full',month:'2026-08',asOf:'2026-08-31',phase:'MONTH_FINALIZATION',configurationVersion:'source'});
  for(const row of result.records)for(const metric of row.normalized.qualitative)for(const note of metric.comments??[]){assert.equal(note.sheet,'Pivot Liste');assert.equal(Number(note.cell.match(/\d+$/)[0]),row.row);}
 }
});
