export interface ICSEvent { uid: string; title: string; start: string; end: string | null; allDay: boolean; location: string }
interface Stamp { wall: number; zone?: string; allDay: boolean }
interface Field { name: string; params: Record<string,string>; value: string }
const day = 86400000;
const weekdays = ['SU','MO','TU','WE','TH','FR','SA'];
export function icsEscape(value: string): string { return value.replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,'); }
function unescape(value: string): string { return value.replace(/\\([nN,;\\])/g, (_,c: string) => /n/i.test(c) ? '\n' : c); }
function stamp(field: Field): Stamp | null {
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/.exec(field.value.trim());
  if (!m) return null;
  const wall = Date.UTC(+m[1],+m[2]-1,+m[3],+(m[4]??0),+(m[5]??0),+(m[6]??0));
  if (!Number.isFinite(wall) || new Date(wall).getUTCMonth() !== +m[2]-1 || new Date(wall).getUTCDate() !== +m[3] || +(m[4]??0)>23 || +(m[5]??0)>59 || +(m[6]??0)>59) return null;
  return {wall, allDay: !m[4], zone: !m[7] ? field.params.TZID?.replace(/^"|"$/g,'') : undefined};
}
function instant(s: Stamp, wall = s.wall): number {
  if (!s.zone || s.allDay) return wall;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone:s.zone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' });
  let candidate = wall;
  for (let i=0;i<3;i++) {
    const p = Object.fromEntries(formatter.formatToParts(candidate).map(part => [part.type,part.value]));
    const local = Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
    const next = candidate + wall - local;
    if (next === candidate) break; candidate = next;
  }
  return candidate;
}
function format(s: Stamp, wall: number): string { return new Date(instant(s,wall)).toISOString().slice(0,s.allDay ? 10 : undefined); }
/** Parse and expand only occurrences overlapping the half-open UTC window. */
export function parseICS(text: string, from: string, to: string): ICSEvent[] {
  const lower = Date.parse(from), upper = Date.parse(to);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return [];
  const components: Field[][] = []; let current: Field[] | null = null;
  for (const line of text.replace(/\r\n/g,'\n').replace(/\n[ \t]/g,'').split('\n')) {
    if (line.trim().toUpperCase() === 'BEGIN:VEVENT') { current = []; continue; }
    if (line.trim().toUpperCase() === 'END:VEVENT') { if(current) components.push(current); current=null; continue; }
    if (!current) continue;
    const colon = line.indexOf(':'); if(colon<0) continue;
    const [name,...parameters] = line.slice(0,colon).split(';');
    const params = Object.fromEntries(parameters.map(p=>{const at=p.indexOf('='); return [p.slice(0,at).toUpperCase(),p.slice(at+1)];}));
    current.push({name:name.toUpperCase(),params,value:line.slice(colon+1)});
  }
  const result: ICSEvent[] = [];
  for (const fields of components) try {
    const field = (name: string) => fields.find(f=>f.name===name);
    const startField = field('DTSTART'); if(!startField) continue;
    const start = stamp(startField); if(!start) continue;
    const endField = field('DTEND'); const end = endField ? stamp(endField) : null;
    const duration = end ? Math.max(0,end.wall-start.wall) : start.allDay ? day : 0;
    const exclusions = new Set(fields.filter(f=>f.name==='EXDATE').flatMap(f=>f.value.split(',').map(value=>stamp({...f,value}))).filter((s): s is Stamp=>!!s).map(s=>instant(s)));
    const rule: Record<string,string> = Object.fromEntries((field('RRULE')?.value ?? '').split(';').map(part=>part.split('=')));
    const freq = rule.FREQ; const interval = Math.max(1,parseInt(rule.INTERVAL)||1);
    const count = rule.COUNT ? Math.max(0,parseInt(rule.COUNT)||0) : Infinity;
    const untilStamp = rule.UNTIL ? stamp({...startField,value:rule.UNTIL}) : null;
    const until = untilStamp ? instant(untilStamp) + (untilStamp.allDay ? day-1 : 0) : Infinity;
    const initial = new Date(start.wall); const baseDay = Date.UTC(initial.getUTCFullYear(),initial.getUTCMonth(),initial.getUTCDate());
    const byday = (rule.BYDAY??'').split(',').filter(d=>weekdays.includes(d));
    let emitted = 0;
    const add = (wall: number) => {
      const time = instant(start,wall);
      if(time>until || emitted>=count) return false;
      emitted++;
      if(!exclusions.has(time) && time < upper && (duration ? instant(start,wall+duration)>lower : time>=lower)) result.push({uid:unescape(field('UID')?.value??String(start.wall)),title:unescape(field('SUMMARY')?.value??''),start:format(start,wall),end:end || start.allDay ? format(start,wall+duration) : null,allDay:start.allDay,location:unescape(field('LOCATION')?.value??'')});
      return true;
    };
    if(!['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(freq)) { add(start.wall); continue; }
    // Day iteration counts occurrences before the window without constructing or retaining them.
    const limit = Math.min(upper + 2*day, until + 2*day);
    let scanStart = start.wall;
    if (!Number.isFinite(count)) scanStart += Math.max(0, Math.floor((lower-duration-2*day-start.wall)/day))*day;
    if (freq === 'DAILY') {
      const step = interval*day;
      const first = Math.max(0,Math.floor((lower-duration-2*day-start.wall)/step));
      emitted = first;
      for (let wall=start.wall+first*step; wall<limit && emitted<count; wall+=step) if(!add(wall)) break;
      continue;
    }
    for(let wall=scanStart; wall<limit && emitted<count; wall+=day) {
      const d = new Date(wall); const elapsed = Math.round((wall-start.wall)/day);
      let matches = false;
      if(freq==='DAILY') matches=elapsed%interval===0;
      if(freq==='WEEKLY') {
        const week = Math.floor((Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()) - baseDay + ((initial.getUTCDay()+6)%7)*day)/(7*day));
        matches=week%interval===0 && (byday.length ? byday.includes(weekdays[d.getUTCDay()]) : d.getUTCDay()===initial.getUTCDay());
      }
      if(freq==='MONTHLY') matches=((d.getUTCFullYear()-initial.getUTCFullYear())*12+d.getUTCMonth()-initial.getUTCMonth())%interval===0 && d.getUTCDate()===initial.getUTCDate();
      if(freq==='YEARLY') matches=(d.getUTCFullYear()-initial.getUTCFullYear())%interval===0 && d.getUTCMonth()===initial.getUTCMonth() && d.getUTCDate()===initial.getUTCDate();
      if(matches && !add(wall)) break;
    }
  } catch { /* A malformed event must not prevent the other events being shown. */ }
  return result.sort((a,b)=>a.start.localeCompare(b.start));
}
