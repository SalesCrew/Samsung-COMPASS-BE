import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { authAdmin, publicAuth, userDatabase } from './supabase.ts';
import { readWorkbook, type ServerSheet } from './workbook.ts';
import { privacyMappings, validateClosing, validateWeekly, weeklyMappings, validateContext, sourcePeriod, type ImportContext } from './imports.ts';
import { resolveImportPeople, type ImportPerson, type ImportAssignment } from './identity.ts';
import { imPresentation, type PresentationSettings } from './presentation.ts';
import { closingMappings, detectClosingGroup, excelMonth } from '../shared/closingImport.ts';
import type { SourceColumnMapping, AdminMetric } from '../shared/admin.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

type Profile={user_id:string;email:string;display_name:string;role:'app_admin'|'department_admin'|'sec';department_ids:string[];person_id:string|null;primary_department:string|null;setting:string;active:boolean;must_change_password:boolean;is_test:boolean};
type Session={token:string;profile:Profile;db:SupabaseClient};
class APIError extends Error { status:number;code:string;constructor(status:number,message:string,code='REQUEST_FAILED'){super(message);this.status=status;this.code=code;} }
const origins=new Set((process.env.FRONTEND_ORIGINS??'http://127.0.0.1:4319,http://localhost:4319').split(',').map(s=>s.trim()));
const previews=new Map<string,{owner:string;filename:string;hash:string;sheets:ServerSheet[];expires:number}>();
const loginAttempts=new Map<string,{count:number;until:number}>();
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Vienna',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function send(res:ServerResponse,status:number,data:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(JSON.stringify(data));}
async function body(req:IncomingMessage,max=2*1024*1024){const chunks:Buffer[]=[];let size=0;for await(const c of req){size+=c.length;if(size>max)throw new APIError(413,'Datei oder Anfrage ist zu groß.');chunks.push(Buffer.from(c));}return Buffer.concat(chunks);}
async function json(req:IncomingMessage){try{return JSON.parse((await body(req)).toString()) as Record<string,unknown>;}catch(e){if(e instanceof APIError)throw e;throw new APIError(400,'Ungültige Anfrage.');}}
function failDB(error:{message:string;code?:string}|null){if(error)throw new APIError(error.code==='42501'?403:400,'Die Datenbank hat die Anfrage abgelehnt.',error.code??'DATABASE_ERROR');}
async function session(req:IncomingMessage):Promise<Session>{
 const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
 if(!token)throw new APIError(401,'Bitte anmelden.','AUTH_REQUIRED');
 const db=userDatabase(token);const {data,error}=await db.auth.getUser(token);
 if(error||!data.user)throw new APIError(401,'Die Sitzung ist abgelaufen. Bitte erneut anmelden.','AUTH_REQUIRED');
 const result=await db.from('sec_accounts').select('*').eq('user_id',data.user.id).maybeSingle();
 failDB(result.error);if(!result.data?.active)throw new APIError(403,'Dein Zugang ist noch nicht freigeschaltet oder wurde deaktiviert.','ACCOUNT_DISABLED');
 return{token,db,profile:result.data as Profile};
}
function admin(s:Session,department?:string){
 if(s.profile.must_change_password)throw new APIError(403,'Bitte zuerst dein Passwort ändern.','PASSWORD_CHANGE_REQUIRED');
 if(s.profile.role==='sec'||department&&s.profile.role!=='app_admin'&&!s.profile.department_ids.includes(department))throw new APIError(403,'Für diesen Bereich fehlen dir die Rechte.','FORBIDDEN');
}
async function allRows(db:SupabaseClient,table:string,filters:Record<string,string>={},order='created_at'){
 const rows:Record<string,unknown>[]=[];
 for(let offset=0;offset<100000;offset+=1000){let q=db.from(table).select('*').order(order).order(table==='sec_accounts'?'user_id':table==='sec_read_receipts'?'report_id':table==='sec_retention_policies'?'category':'id').range(offset,offset+999);for(const[k,v]of Object.entries(filters))q=q.eq(k,v);const{data,error}=await q;failDB(error);rows.push(...data??[]);if((data?.length??0)<1000)return rows;}
 throw new APIError(413,'Bitte den Zeitraum oder Bereich weiter eingrenzen.');
}
function context(input:Record<string,unknown>):ImportContext{
 const ctx:ImportContext={group:String(input.group) as ImportContext['group'],setting:(input.group==='DA'?String(input.setting??'full'):'full') as ImportContext['setting'],month:String(input.month??''),phase:String(input.phase) as ImportContext['phase'],asOf:String(input.asOf??''),configurationVersion:'source-v1',metrics:[]};
 validateContext(ctx);if(!['TARGET_INITIALIZATION','WEEKLY_PROGRESS','MONTH_FINALIZATION'].includes(ctx.phase))throw new APIError(400,'Importphase wählen.');
 if(ctx.asOf>today())throw new APIError(400,'Zukünftige Datenstände können nicht veröffentlicht werden.');
 return ctx;
}
async function configFor(s:Session,ctx:ImportContext,configId?:unknown){
 let q=s.db.from('sec_config_versions').select('*').eq('department_id',ctx.group).eq('setting',ctx.setting).lte('effective_from',ctx.asOf).order('effective_from',{ascending:false}).order('version',{ascending:false}).limit(1);
 if(typeof configId==='string'&&configId)q=q.eq('id',configId);
 const{data,error}=await q;failDB(error);const config=data?.[0];
 if(configId&&!config)throw new APIError(400,'Die Konfiguration passt nicht zu Bereich, Zuordnung und Monat.');
 ctx.configurationVersion=config?.id??'source-'+ctx.group+'-'+ctx.setting+'-v1';
 ctx.metrics=(config?.definition?.metrics??[]) as AdminMetric[];return config;
}
const server=createServer(async(req,res)=>{
 const origin=req.headers.origin;
 if(origin&&!origins.has(origin)){send(res,403,{error:'Diese Herkunft ist nicht freigegeben.',code:'ORIGIN_NOT_ALLOWED'});return;}
 if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
 res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type,X-File-Name');
 res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
 const url=new URL(req.url??'/','http://backend.local');const route=url.pathname.replace(/^\/api/,'');const method=req.method??'GET';
 try{
  if(route==='/health'&&method==='GET'){const{error}=await authAdmin.from('sec_departments').select('id').limit(1);send(res,error?503:200,{ok:!error,database:!error});return;}
  if(route==='/auth/login'&&method==='POST'){
   const key=req.socket.remoteAddress??'local';const old=loginAttempts.get(key);const attempt=old&&old.until>Date.now()?old:{count:0,until:Date.now()+600000};attempt.count++;loginAttempts.set(key,attempt);
   if(attempt.count>60)throw new APIError(429,'Zu viele Anmeldeversuche. Bitte später erneut versuchen.');
   const b=await json(req);if(typeof b.email!=='string'||typeof b.password!=='string')throw new APIError(400,'E-Mail und Passwort eingeben.');
   const{data,error}=await publicAuth().auth.signInWithPassword({email:b.email,password:b.password});
   if(error||!data.session)throw new APIError(401,'E-Mail oder Passwort stimmen nicht.','INVALID_LOGIN');
   send(res,200,{session:data.session});return;
  }
  const s=await session(req);
  const status=await s.db.rpc('sec_auth_status');failDB(status.error);
  if(route==='/me'&&method==='GET'){send(res,200,{profile:s.profile,calendarDay:today(),...status.data});return;}
  if(route==='/auth/logout'&&method==='POST'){const{error}=await authAdmin.auth.admin.signOut(s.token,'local');if(error)throw new APIError(400,'Abmelden fehlgeschlagen.');send(res,200,{ok:true});return;}
  if(status.data?.mfaRequired)throw new APIError(403,'Bitte den zweiten Faktor bestätigen.','MFA_REQUIRED');
  if((route==='/auth/password'||route==='/admin/password')&&method==='POST'){
   if(route==='/admin/password')admin(s);
   const b=await json(req);if(typeof b.currentPassword!=='string'||typeof b.newPassword!=='string'||b.newPassword.length<12||b.newPassword.length>128)throw new APIError(400,'Das neue Passwort muss 12–128 Zeichen haben.');
   if(route==='/admin/password'&&(typeof b.confirmPassword!=='string'||b.confirmPassword!==b.newPassword))throw new APIError(400,'Die neuen Passwörter stimmen nicht überein.');
   const verified=await publicAuth().auth.signInWithPassword({email:s.profile.email,password:b.currentPassword});
   if(verified.error||verified.data.user?.id!==s.profile.user_id)throw new APIError(401,'Das bisherige Passwort stimmt nicht.');
   const changed=await authAdmin.auth.admin.updateUserById(s.profile.user_id,{password:b.newPassword});
   if(changed.error)throw new APIError(400,'Passwort konnte nicht geändert werden.');
   const result=await authAdmin.from('sec_accounts').update({must_change_password:false,updated_at:new Date().toISOString()}).eq('user_id',s.profile.user_id);
   failDB(result.error);await authAdmin.auth.admin.signOut(s.token,'global');
   send(res,200,{ok:true,signInAgain:true});return;
  }
  if(s.profile.must_change_password)throw new APIError(403,'Bitte zuerst dein Passwort ändern.','PASSWORD_CHANGE_REQUIRED');
  if(route==='/notice'&&method==='POST'){const b=await json(req);const{error}=await s.db.rpc('sec_ack_notice',{p_version:b.version});failDB(error);send(res,200,{ok:true});return;}
  if(route==='/dashboard'&&method==='GET'){
   const realCalendarDay=today();const testDay=url.searchParams.get('testDay');const testMonth=url.searchParams.get('testMonth')??testDay?.slice(0,7);let calendarDay=realCalendarDay;
   if(s.profile.is_test){
    const{data,error}=await s.db.rpc('sec_own_presentation');failDB(error);
    if(data){
     const settings=data as PresentationSettings,selected=url.searchParams.get('assignment');
     if(selected&&selected!==settings.assignmentId)throw new APIError(403,'Marktzuordnung nicht freigegeben.');
     send(res,200,imPresentation(s.profile,settings,realCalendarDay,selected));return;
    }
   }
   if(testMonth){
    if(!s.profile.is_test||s.profile.role!=='sec')throw new APIError(403,'Der Prüfmonat ist nur für freigegebene Testkonten verfügbar.');
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(testMonth)||testMonth>realCalendarDay.slice(0,7))throw new APIError(400,'Ungültiger Prüfmonat.');
    calendarDay=testMonth===realCalendarDay.slice(0,7)?realCalendarDay:testMonth+'-'+String(new Date(Date.UTC(Number(testMonth.slice(0,4)),Number(testMonth.slice(5,7)),0)).getUTCDate()).padStart(2,'0');
    if(testDay){const parsed=new Date(testDay+'T12:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(testDay)||!testDay.startsWith(testMonth+'-')||testDay>realCalendarDay||!Number.isFinite(parsed.valueOf())||parsed.toISOString().slice(0,10)!==testDay)throw new APIError(400,'Ungültiger Prüfstand.');calendarDay=testDay;}
   }
   if(!s.profile.person_id){send(res,200,{profile:s.profile,assignments:[],reports:[],weekly:[],read:[],pointHistory:[],calendarDay:today()});return;}
   const assignments=await allRows(s.db,'sec_assignments',{person_id:s.profile.person_id},'created_at');
   const matching=assignments.filter(a=>a.department_id===s.profile.primary_department&&(a.department_id!=='DA'||a.setting===s.profile.setting));
   const selected=url.searchParams.get('assignment')??String(matching.at(-1)?.id??'');
   if(selected&&!matching.some(a=>a.id===selected))throw new APIError(403,'Marktzuordnung nicht freigegeben.');
   const [reports,weekly,read,history]=selected?await Promise.all([allRows(s.db,'sec_monthly_reports',{assignment_id:selected},'published_at'),allRows(s.db,'sec_weekly_snapshots',{assignment_id:selected},'published_at'),allRows(s.db,'sec_read_receipts',{user_id:s.profile.user_id},'read_at'),s.db.rpc('sec_own_point_history',{p_assignment:selected})]):[[],[],[],{data:[],error:null}];
   failDB(history.error);
   const rankings=Object.fromEntries(await Promise.all([...new Set(reports.map(r=>String(r.month)))].map(async month=>{const{data,error}=await s.db.rpc('sec_own_rank',{p_assignment:selected,p_month:month});failDB(error);return[month.slice(0,7),data];})));
   send(res,200,{profile:s.profile,assignments:matching,selectedAssignment:selected,reports,weekly,read,pointHistory:history.data,rankings,calendarDay,realCalendarDay,testReplay:calendarDay!==realCalendarDay});return;
  }
  if(route==='/read'&&method==='POST'){const b=await json(req);if(typeof b.reportId!=='string')throw new APIError(400,'Bericht fehlt.');if(s.profile.is_test){const{data,error}=await s.db.rpc('sec_read_presentation',{p_report:b.reportId});failDB(error);if(data){send(res,200,{ok:true});return;}}const{error}=await s.db.from('sec_read_receipts').upsert({user_id:s.profile.user_id,report_id:b.reportId,read_at:new Date().toISOString()});failDB(error);send(res,200,{ok:true});return;}
  if(route==='/privacy/requests'&&method==='GET'){send(res,200,{requests:await allRows(s.db,'sec_privacy_requests',s.profile.role==='sec'?{user_id:s.profile.user_id}:{},'created_at')});return;}
  if(route==='/privacy/requests'&&method==='POST'){
   const b=await json(req);if(!['access','correction','erasure','restriction','objection','portability'].includes(String(b.kind))||typeof b.message!=='string'||b.message.length>4000)throw new APIError(400,'Art und Nachricht prüfen.');
   const{data,error}=await s.db.from('sec_privacy_requests').insert({user_id:s.profile.user_id,person_id:s.profile.person_id,department_id:s.profile.primary_department,kind:b.kind,message:b.message}).select().single();failDB(error);send(res,201,{request:data});return;
  }
  if(route==='/privacy/export'&&method==='GET'){
   const filters=s.profile.person_id?{person_id:s.profile.person_id}:null;
   const[reports,weekly,assignments]=filters?await Promise.all([allRows(s.db,'sec_monthly_reports',filters,'published_at'),allRows(s.db,'sec_weekly_snapshots',filters,'published_at'),allRows(s.db,'sec_assignments',filters,'created_at')]):[[],[],[]];
   const requests=await allRows(s.db,'sec_privacy_requests',{user_id:s.profile.user_id},'created_at');
   send(res,200,{exportedAt:new Date().toISOString(),profile:s.profile,assignments,reports,weekly,requests});return;
  }
  admin(s);
  if(route==='/admin/accounts'&&method==='GET'){send(res,200,{accounts:await allRows(s.db,'sec_accounts',{},'created_at')});return;}
  const resetMatch=route.match(/^\/admin\/accounts\/([0-9a-f-]{36})\/reset-password$/);
  if(resetMatch&&method==='POST'){
   if(resetMatch[1]===s.profile.user_id)throw new APIError(400,'Dein eigenes Passwort bitte unter Mein Konto ändern.');
   const{error}=await s.db.rpc('sec_reset_access',{p_user:resetMatch[1]});failDB(error);
   const password=randomBytes(18).toString('base64url')+'aA9!';const changed=await authAdmin.auth.admin.updateUserById(resetMatch[1],{password});
   if(changed.error)throw new APIError(400,'Passwort konnte nicht zurückgesetzt werden.');
   send(res,200,{initialPassword:password});return;
  }
  if(route==='/admin/security'&&method==='GET'){const{data,error}=await s.db.from('sec_security_settings').select('*').single();failDB(error);send(res,200,{settings:data,retention:await allRows(s.db,'sec_retention_policies',{},'category'),holds:await allRows(s.db,'sec_legal_holds')});return;}
  if(route==='/admin/security'&&method==='POST'){const b=await json(req);const{error}=await s.db.rpc('sec_set_security',{p_require_mfa:b.requireAdminMfa===true});failDB(error);send(res,200,{ok:true});return;}
  if(route==='/admin/retention'&&method==='POST'){const b=await json(req);const{error}=await s.db.rpc('sec_retention_policy',{p_category:b.category,p_months:b.months,p_basis:b.basis});failDB(error);send(res,200,{ok:true});return;}
  if(route==='/admin/holds'&&method==='POST'){const b=await json(req);const{error}=await s.db.rpc('sec_legal_hold',{p_person:b.personId??null,p_department:b.department??null,p_reason:b.reason??'',p_release:b.releaseId??null});failDB(error);send(res,200,{ok:true});return;}
  if(route==='/admin/people'&&method==='GET'){send(res,200,{people:await allRows(s.db,'sec_people',{},'created_at'),assignments:await allRows(s.db,'sec_assignments',{},'created_at')});return;}
  if(route==='/admin/accounts'&&method==='POST'){
   const b=await json(req);const role=b.role??'sec';const departments=b.department_ids;
   if(typeof b.email!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)||!Array.isArray(departments)||!departments.every(x=>['HE','DA','IM','LH','ST'].includes(String(x)))||!['sec','department_admin','app_admin'].includes(String(role)))throw new APIError(400,'Kontodaten prüfen.');
   if(s.profile.role!=='app_admin'&&(role!=='sec'||departments.some(d=>!s.profile.department_ids.includes(String(d)))))throw new APIError(403,'Rolle oder Bereich nicht freigegeben.');
   const password=randomBytes(18).toString('base64url')+'aA9!';const created=await authAdmin.auth.admin.createUser({email:b.email,password,email_confirm:true});
   if(created.error||!created.data.user)throw new APIError(400,'Konto konnte nicht erstellt werden. Prüfe, ob die E-Mail schon verwendet wird.');
   const{data,error}=await s.db.rpc('sec_manage_account',{p_user_id:created.data.user.id,p_profile:{display_name:String(b.display_name??''),role,department_ids:departments,primary_department:b.primary_department??null,setting:b.setting??'full',person_id:b.person_id??null}});
   if(error){await authAdmin.auth.admin.deleteUser(created.data.user.id);failDB(error);}
   send(res,201,{account:data,initialPassword:password});return;
  }
  const accountMatch=route.match(/^\/admin\/accounts\/([0-9a-f-]{36})$/);
  if(accountMatch&&method==='PATCH'){
   const b=await json(req);const allowed=['display_name','role','department_ids','primary_department','setting','person_id','active'];const profile=Object.fromEntries(Object.entries(b).filter(([k])=>allowed.includes(k)));
   const{data,error}=await s.db.rpc('sec_manage_account',{p_user_id:accountMatch[1],p_profile:profile});failDB(error);send(res,200,{account:data});return;
  }
  if(route==='/admin/data'&&method==='GET'){
   const department=url.searchParams.get('department')??undefined;if(department)admin(s,department);
   const filter:Record<string,string>=department?{department_id:department}:{};
   const[reports,weekly,imports,configurations,people,assignments]=await Promise.all([allRows(s.db,'sec_monthly_reports',filter,'published_at'),allRows(s.db,'sec_weekly_snapshots',filter,'published_at'),allRows(s.db,'sec_imports',filter,'created_at'),allRows(s.db,'sec_config_versions',filter,'created_at'),allRows(s.db,'sec_people',{},'created_at'),allRows(s.db,'sec_assignments',filter,'created_at')]);
   send(res,200,{reports,weekly,imports,configurations,people,assignments});return;
  }
  if(route==='/admin/configurations'&&method==='POST'){
   const b=await json(req);admin(s,String(b.department));const definition=b.definition as {metrics?:AdminMetric[]}|undefined;
   if(!definition||!Array.isArray(definition.metrics)||!definition.metrics.every(m=>typeof m.id==='string'&&/^[a-z0-9][a-z0-9-]{0,80}$/i.test(m.id)&&typeof m.label==='string'&&m.label.trim()&&['Stück','€','%'].includes(m.unit)&&(m.weight===null||Number.isFinite(m.weight)&&m.weight>=0&&m.weight<=100)))throw new APIError(400,'KPI-Konfiguration prüfen.');
   const ids=new Set<string>();const weights=new Map<string,number>();
   for(const metric of definition.metrics){if(ids.has(metric.id))throw new APIError(400,'KPI-IDs müssen eindeutig sein.');ids.add(metric.id);if(metric.active){if(metric.weight===null)throw new APIError(400,'Aktive Gewichte zuerst klären.');weights.set(metric.block,(weights.get(metric.block)??0)+metric.weight);}}
   if(!weights.size||[...weights.values()].some(total=>Math.abs(total-100)>.00001))throw new APIError(400,'Aktive Gewichte müssen je Block 100 % ergeben.');
   const{data,error}=await s.db.rpc('sec_save_config',{p_department:b.department,p_setting:b.department==='DA'?b.setting??'full':'full',p_month:b.effectiveFrom??String(b.month)+'-01',p_definition:definition,p_note:b.note??''});failDB(error);send(res,201,{configuration:data});return;
  }
  if(route==='/admin/audit'&&method==='GET'){send(res,200,{events:await allRows(s.db,'sec_audit_events',{},'created_at')});return;}
  if(route==='/imports/preview'&&method==='POST'){
   const filename=decodeURIComponent(String(req.headers['x-file-name']??''));const bytes=await body(req,30*1024*1024);const sheets=readWorkbook(bytes,filename);
   for(const[id,p]of previews)if(p.expires<Date.now())previews.delete(id);
   for(const[id,p]of previews)if(p.owner===s.profile.user_id)previews.delete(id);
   if(previews.size>=10)throw new APIError(429,'Importvorschau ist ausgelastet. Bitte später erneut versuchen.');
   const pivot=sheets.find(v=>v.name.replace(/[\s_-]/g,'').toLowerCase()==='pivotliste');const detected=pivot?detectClosingGroup(filename,pivot):filename.match(/^(HE|HA|DA|IM|LH|ST)\b/i)?.[1].toUpperCase().replace('HA','DA');
   if(detected)admin(s,detected);
   const id=randomUUID();previews.set(id,{owner:s.profile.user_id,filename,hash:createHash('sha256').update(bytes).digest('hex'),sheets,expires:Date.now()+20*60000});
   setTimeout(()=>previews.delete(id),20*60000).unref();
   const period=sourcePeriod(pivot??sheets[0]);
   const monthColumn=pivot?.columns.find(c=>/^monat$/i.test(c.label.trim()))?.key??'M';
   const sourceMonths=pivot?[...new Set(pivot.data?.map(r=>excelMonth(r.cells[monthColumn]?.value??null,pivot.date1904)).filter(Boolean))].sort():period?[period.month]:[];
   send(res,200,{previewId:id,filename,detectedGroup:detected??null,sourceMonths,sourceAsOf:period?.asOf??null,sheets:sheets.map(({allRows,data,...v})=>v),preferredSheet:pivot?.name??sheets[0]?.name});return;
  }
  const importMatch=route.match(/^\/imports\/([0-9a-f-]{36})\/(validate|stage)$/);
  if(importMatch&&method==='POST'){
   const b=await json(req);const p=previews.get(importMatch[1]);
   if(!p||p.owner!==s.profile.user_id||p.expires<Date.now())throw new APIError(404,'Importvorschau ist abgelaufen. Datei erneut wählen.');
   const ctx=context(b);admin(s,ctx.group);const config=await configFor(s,ctx,b.configId);const sheet=p.sheets.find(v=>v.name===b.sheet);
   if(!sheet)throw new APIError(400,'Arbeitsblatt fehlt.');
   const detected=detectClosingGroup(p.filename,sheet);if(detected&&detected!==ctx.group)throw new APIError(400,'Obergruppe passt nicht zur Datei.');
   const pivot=sheet.name.replace(/[\s_-]/g,'').toLowerCase()==='pivotliste';
   const mappings=Array.isArray(b.mappings)?b.mappings as SourceColumnMapping[]:pivot?privacyMappings(closingMappings(sheet,ctx.group,ctx.metrics)):weeklyMappings(sheet,ctx);
   const result=pivot?validateClosing(sheet,mappings,ctx):validateWeekly(sheet,mappings,ctx);
   if(b.personMatches!==undefined&&(typeof b.personMatches!=='object'||b.personMatches===null||Array.isArray(b.personMatches)||Object.entries(b.personMatches).some(([k,v])=>!/^\d+$/.test(k)||typeof v!=='string')))throw new APIError(400,'Personenzuordnung prüfen.');
   const[people,assignments]=await Promise.all([allRows(s.db,'sec_people'),allRows(s.db,'sec_assignments')]);
   const identities=resolveImportPeople(result.records,people as ImportPerson[],assignments as ImportAssignment[],ctx.group,ctx.setting,(b.personMatches??{}) as Record<string,string>);
   const issues=[...result.issues,...identities.issues];
   if(importMatch[2]==='validate'){send(res,200,{issues,count:result.records.length,otherMonths:result.otherMonths,skipped:result.skipped,specialValues:result.specialValues,mappings,configurationVersion:ctx.configurationVersion,identityMatches:identities.matches,unresolvedCount:identities.unresolvedCount,people:(people as ImportPerson[]).map(person=>({...person,markets:(assignments as ImportAssignment[]).filter(a=>a.person_id===person.id&&a.department_id===ctx.group&&a.setting===ctx.setting).map(a=>a.market)}))});return;}
   if(issues.length||!identities.records.length)throw new APIError(400,'Import enthält Fehler oder offene Personenzuordnungen. Zuerst prüfen.','IMPORT_INVALID');
   const contract:unknown[]=[p.hash,ctx,privacyMappings(mappings),sheet.name];
   if(identities.records.some(r=>{const original=result.records.find(v=>v.row===r.row);return original?.externalId!==r.externalId||original?.market!==r.market;}))contract.push(identities.records.map(r=>[r.row,r.externalId,r.market]));
   const fingerprint=createHash('sha256').update(JSON.stringify(contract)).digest('hex');
   const{data,error}=await s.db.rpc('sec_stage_import',{p_department:ctx.group,p_month:ctx.month+'-01',p_phase:ctx.phase,p_as_of:ctx.asOf,p_fingerprint:fingerprint,p_filename:p.filename,p_sheet:sheet.name,p_mapping:privacyMappings(mappings),p_config:config?.id??null,p_rows:identities.records});failDB(error);send(res,201,{import:data});return;
  }
  const publishMatch=route.match(/^\/imports\/([0-9a-f-]{36})\/publish$/);
  if(publishMatch&&method==='POST'){const{data,error}=await s.db.rpc('sec_publish_import',{p_import:publishMatch[1]});failDB(error);send(res,200,{import:data});return;}
  const rejectMatch=route.match(/^\/imports\/([0-9a-f-]{36})\/reject$/);
  if(rejectMatch&&method==='POST'){const{error}=await s.db.rpc('sec_reject_import',{p_import:rejectMatch[1]});failDB(error);send(res,200,{ok:true});return;}
  const requestMatch=route.match(/^\/privacy\/requests\/([0-9a-f-]{36})$/);
  if(requestMatch&&method==='PATCH'){const b=await json(req);const{data,error}=await s.db.rpc('sec_resolve_privacy',{p_request:requestMatch[1],p_status:b.status,p_response:b.response,p_identity_checked:b.identityChecked===true});failDB(error);send(res,200,{request:data});return;}
  throw new APIError(404,'Nicht gefunden.');
 }catch(error){if(error instanceof APIError)send(res,error.status,{error:error.message,code:error.code});else{console.error('Request failed',{method,route,errorType:error instanceof Error?error.name:'unknown'});send(res,400,{error:error instanceof Error?error.message:'Anfrage fehlgeschlagen.',code:'REQUEST_FAILED'});}}
});
server.requestTimeout=30000;server.headersTimeout=10000;
server.listen(Number(process.env.PORT??4320),process.env.HOST??'127.0.0.1',()=>console.log('SEC Backend ready on port '+(process.env.PORT??4320)));

