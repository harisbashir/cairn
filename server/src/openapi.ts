import type { Hono } from 'hono';
import type { Env } from './common.ts';

type Schema = Record<string, unknown>;
const str: Schema = { type: 'string' }, num: Schema = { type: 'number' }, bool: Schema = { type: 'boolean' };
const timestamp: Schema = { type: 'string', format: 'date-time' };
const ref = (name: string): Schema => ({ $ref: '#/components/schemas/' + name });
const array = (items: Schema): Schema => ({ type: 'array', items });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const choice = (...values: string[]): Schema => ({ type: 'string', enum: values });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required });
const record = (value: Schema = {}): Schema => ({ type: 'object', additionalProperties: value });
const role = choice('owner','admin','member','viewer');
const access = choice('read','write');
const visibility = choice('private','workspace');
const actorType = choice('user','ai');
const pageKind = choice('page','database','row');
const widgetTypes = choice('welcome','recent','favorites','activity','stickies','view','page','note','links','calendar','stats','notifications','changes');
const optionColor = choice('gray','brown','orange','yellow','green','teal','blue','purple','pink','red');
const props: Schema = record({ anyOf: [str,num,bool,array(str),{type:'null'}] });
const identity = {id:str,title:str,icon:str};
const jobResult = object({pageIds:array(str),url:str},[]);
export const schemas: Record<string, Schema> = {
  UserPrefs: object({theme:choice('system','light','dark'),accent:choice('blue','violet','green','orange','pink','graphite'),timezone:str,reminderHour:{type:'integer',minimum:0,maximum:23},notify:ref('NotifyPrefs'),capture:nullable(ref('CaptureTarget'))}),
  User: object({id:str,email:{type:'string',format:'email'},name:str,color:str,isAdmin:bool,disabled:bool,createdAt:timestamp,lastSeenAt:nullable(timestamp),prefs:ref('UserPrefs')}),
  WorkspaceSummary: object({id:str,name:str,icon:str,color:str,role}),
  InstanceInfo: object({name:str,allowSignup:bool,needsSetup:bool,version:str}),
  Bootstrap: object({user:nullable(ref('User')),instance:ref('InstanceInfo'),workspaces:array(ref('WorkspaceSummary')),sessionToken:str},['user','instance','workspaces']),
  Member: object({userId:str,email:str,name:str,color:str,role,joinedAt:timestamp}),
  WorkspaceUser: object({id:str,name:str,color:str}),
  Invite: object({id:str,token:str,email:nullable(str),role,createdAt:timestamp,expiresAt:timestamp,acceptedAt:nullable(timestamp)}),
  InviteInfo: object({workspaceName:str,workspaceIcon:str,inviterName:str,role,email:nullable(str)}),
  DocNode: object({type:str,attrs:record(),content:array(ref('DocNode')),marks:array(object({type:str,attrs:record()},['type'])),text:str},['type']),
  Property: object({id:str,name:str,type:choice('text','number','select','multi_select','status','date','checkbox','url','person','relation','files','rollup','formula'),rollup:ref('RollupConfig'),formula:ref('FormulaConfig'),numberFormat:choice('plain','comma','percent','currency'),options:array(object({id:str,name:str,color:optionColor})),relationDatabaseId:str},['id','name','type']),
  Filter: object({propertyId:str,op:choice('contains','not_contains','eq','neq','gt','lt','gte','lte','is_empty','is_not_empty','checked','unchecked'),value:{anyOf:[str,num,bool,array(str),{type:'null'}]}},['propertyId','op']),
  Sort: object({propertyId:str,dir:choice('asc','desc')}),
  ChartConfig: object({kind:choice('bar','donut','line'),groupBy:str,measure:choice('count','sum','avg'),valueProp:str},['kind','groupBy','measure']),
  View: object({id:str,name:str,type:choice('table','board','list','gallery','calendar','timeline','chart','feed'),filters:array(ref('Filter')),sorts:array(ref('Sort')),groupBy:str,hidden:array(str),widths:record(num),cardProps:array(str),columnOrder:array(str),hiddenColumns:array(str),dateProp:str,endDateProp:str,zoom:choice('week','month','quarter'),cover:choice('page','none'),chart:ref('ChartConfig'),phone:choice('auto','same')},['id','name','type','filters','sorts']),
  Page: object({...identity,workspaceId:str,parentId:nullable(str),kind:pageKind,cover:str,visibility,content:nullable(ref('DocNode')),props,schema:array(ref('Property')),views:array(ref('View')),position:num,createdBy:str,updatedBy:str,updatedByType:actorType,createdAt:timestamp,updatedAt:timestamp,deletedAt:nullable(timestamp),breadcrumbs:array(object({...identity,kind:pageKind})),favorite:bool,shareToken:nullable(str),canEdit:bool,parentSchema:array(ref('Property')),commentCount:num,repeat:nullable(ref('Repeat')),reminders:array(ref('Reminder')),isTemplate:bool,defaultTemplateId:nullable(str)},['id','workspaceId','parentId','kind','title','icon','cover','visibility','content','props','schema','views','position','createdBy','updatedBy','updatedByType','createdAt','updatedAt','deletedAt','repeat','reminders','isTemplate','defaultTemplateId']),
  Row: object({...identity,props,position:num,hasContent:bool,cover:str,preview:str,createdBy:str,createdByName:str,updatedByType:actorType,createdAt:timestamp,updatedAt:timestamp,repeat:{},reminders:{type:'array'}}),
  TreeNode: object({...identity,parentId:nullable(str),kind:choice('page','database'),position:num,visibility,createdBy:str}),
  Tree: object({nodes:array(ref('TreeNode')),favorites:array(str)}),
  SearchHit: object({...identity,kind:pageKind,snippet:str,path:str,updatedAt:timestamp}),
  RecentPage: object({...identity,kind:pageKind,path:str,updatedAt:timestamp,updatedByName:str,updatedByType:actorType}),
  TrashItem: object({...identity,kind:pageKind,deletedAt:timestamp,deletedByName:str}),
  PageVersion: object({id:str,title:str,createdAt:timestamp,createdByName:str,createdByType:actorType}),
  Activity: object({id:str,at:timestamp,actorName:str,actorType,action:choice('created','updated','deleted','restored','moved','shared','joined','repeated','undone'),clientName:nullable(str),pageId:nullable(str),pageTitle:str,pageIcon:str}),
  ApiToken: object({id:str,name:str,prefix:str,access,workspaceId:nullable(str),createdAt:timestamp,lastUsedAt:nullable(timestamp)}),
  AdminOverview: object(Object.fromEntries(['users','workspaces','pages','databases','rows','aiEdits7d','storageBytes'].map(k=>[k,num]))),
  AdminWorkspace: object({id:str,name:str,icon:str,color:str,members:num,pages:num,ownerName:str,createdAt:timestamp}),
  AdminSettings: object({instanceName:str,allowSignup:bool}),
  Widget: object({id:str,type:widgetTypes,title:str,size:choice('third','half','two-thirds','full'),config:record()},['id','type','size','config']),
  HomeLayout: object({widgets:{...array(ref('Widget')),maxItems:30},personal:bool,canEditShared:bool}),
  Sticky: object({id:str,workspaceId:str,text:{type:'string',maxLength:2000},color:choice('yellow','pink','blue','green','purple','orange','gray'),visibility,position:num,createdBy:str,createdByName:str,createdByType:actorType,createdAt:timestamp,updatedAt:timestamp}),
  WorkspaceStats: object(Object.fromEntries(['pages','databases','rows','members','editsThisWeek','aiEditsThisWeek'].map(k=>[k,num]))),
  ExternalCalendar: object({id:str,name:str,color:optionColor,url:str,lastSyncedAt:nullable(timestamp),lastError:nullable(str)}),
  CalendarEvent: object({id:str,title:str,start:str,end:nullable(str),allDay:bool,source:choice('row','external'),color:optionColor,calendarName:str,pageId:nullable(str),location:str}),
  CalendarFeed: object({url:nullable(str)}),
  Job: object({id:str,kind:choice('notion-import','notion-export','import','backup'),status:choice('running','done','failed'),progress:str,error:nullable(str),result:nullable(jobResult),startedAt:timestamp,finishedAt:nullable(timestamp)}),
  NotionSource: object({id:str,kind:choice('database','page'),title:str,icon:str}),
  BackupDestination: object({id:str,type:choice('local','webdav','rclone'),name:str,config:record(str),hasSecret:bool}),
  BackupSettings: object({enabled:bool,frequency:choice('hourly','daily','weekly'),hour:{type:'integer',minimum:0,maximum:23},weekday:{type:'integer',minimum:0,maximum:6},keep:{type:'integer',minimum:1},destinations:array(ref('BackupDestination')),rcloneAvailable:bool}),
  BackupRun: object({id:str,startedAt:timestamp,finishedAt:nullable(timestamp),status:choice('running','done','failed'),sizeBytes:num,trigger:choice('schedule','manual'),results:array(object({destinationId:str,name:str,ok:bool,message:str})),downloadable:bool}),
  OAuthGrantInfo: object({clientName:str,redirectHost:str,scope:access}),
  ConnectedApp: object({id:str,clientName:str,access,createdAt:timestamp,lastUsedAt:nullable(timestamp)}),
  File: object({id:str,name:str,url:str,mime:str,size:num,createdAt:timestamp,createdByName:str}),
  Ok: object({ok:bool}), Health: object({ok:bool,version:str}),
  ApiError: object({error:object({code:str,message:str})}),
  LiveEvent: {oneOf:[object({type:choice('page'),pageId:str,parentId:nullable(str),change:choice('created','updated','deleted','restored','moved'),actorId:str,actorType,clientId:nullable(str)}),object({type:choice('members','home','stickies','notifications','ping')}),object({type:choice('comments'),pageId:str})]},
  OAuthRegistration: object({client_name:str,redirect_uris:array(str),token_endpoint_auth_method:choice('none')},['redirect_uris']),
  OAuthClient: object({client_id:str,client_name:str,redirect_uris:array(str),token_endpoint_auth_method:choice('none'),grant_types:array(str),response_types:array(str)}),
  OAuthTokenRequest: object({grant_type:choice('authorization_code','refresh_token'),client_id:str,code:str,redirect_uri:str,code_verifier:str,refresh_token:str},['grant_type','client_id']),
  OAuthTokens: object({access_token:str,token_type:choice('Bearer'),expires_in:num,refresh_token:str,scope:access}),
  PageInput: object({title:str,icon:str,cover:str,content:nullable(ref('DocNode')),props,schema:array(ref('Property')),views:array(ref('View')),visibility,parentId:nullable(str),kind:pageKind,afterId:nullable(str),repeat:nullable(ref('Repeat')),reminders:{...array(ref('ReminderInput')),maxItems:10},isTemplate:bool,templateId:nullable(str),defaultTemplateId:nullable(str)},[]),
};
// v0.3 schemas are shared by REST responses and page create/patch inputs.
Object.assign(schemas, {
  NotifyPrefs: object({push:bool,email:bool,mentions:bool,comments:bool,assigned:bool}),
  CaptureTarget: object({workspaceId:str,databaseId:nullable(str)}),
  Repeat: object({dateProp:str,every:{type:'integer',minimum:1,maximum:365},unit:choice('day','week','month','year'),weekdays:array({type:'integer',minimum:0,maximum:6}),from:choice('due','completed'),until:nullable({type:'string',format:'date'}),doneProp:str,doneValue:{anyOf:[str,bool]},resetValue:{anyOf:[str,bool,{type:'null'}]}},['dateProp','every','unit','from','until','doneProp','doneValue','resetValue']),
  Reminder: object({id:str,dateProp:nullable(str),offsetMinutes:{type:'integer',minimum:0},at:nullable(timestamp),userIds:array(str),personProp:nullable(str),createdBy:str,lastFiredFor:nullable(str)}),
  ReminderInput: object({id:str,dateProp:nullable(str),offsetMinutes:{type:'integer',minimum:0},at:nullable(timestamp),userIds:array(str),personProp:nullable(str)},[]),
  Notification: object({id:str,at:timestamp,kind:choice('reminder','mention','comment','assigned','repeat'),title:str,body:str,pageId:nullable(str),workspaceId:str,actorName:str,read:bool}),
  PushSubscriptionInfo: object({id:str,device:str,createdAt:timestamp}),
  PushSubscriptionInput: object({subscription:object({endpoint:{type:'string',format:'uri'},expirationTime:nullable(num),keys:object({p256dh:str,auth:str})},['endpoint','keys']),device:str},['subscription']),
  MailSettings: object({enabled:bool,host:str,port:{type:'integer',minimum:1,maximum:65535},secure:bool,username:str,password:{type:'string',description:"Always empty on reads; use hasPassword to check whether a password is configured."},hasPassword:bool,from:str}),
  TemplateSummary: object({...identity,kind:choice('page','row'),databaseId:nullable(str),databaseTitle:str,isDefault:bool,updatedAt:timestamp}),
  Backlink: object({...identity,kind:pageKind,path:str,snippet:str,via:choice('link','mention','relation')}),
  Comment: object({id:str,pageId:str,threadId:str,quote:str,body:str,resolved:bool,createdBy:str,createdByName:str,createdByType:actorType,createdAt:timestamp,updatedAt:timestamp}),
  RollupConfig: object({source:{oneOf:[object({kind:choice('relation'),propertyId:str}),object({kind:choice('incoming'),databaseId:str,propertyId:str})]},target:str,fn:choice('count','count_values','sum','avg','min','max','earliest','latest','percent_checked','show'),filters:array(ref('Filter'))},['source','target','fn']),
  FormulaConfig: object({expression:{type:'string',maxLength:2000},resultType:choice('text','number','checkbox','date')},['expression']),
  UpcomingReminder: object({pageId:str,title:str,icon:str,fireAt:timestamp,occurrence:str}),
  Mentionables: object({pages:array(object({...identity,path:str})),people:array(object({id:str,name:str,color:str}))}),
});
const changeProperties = {id:str,at:timestamp,actorName:str,actorType,clientName:nullable(str),action:choice('created','updated','deleted','restored','moved','shared','joined','repeated','undone'),pageId:str,pageTitle:str,pageIcon:str,pageKind,databaseTitle:str,fields:array(str),canUndo:bool,undoneAt:nullable(timestamp),undoneByName:nullable(str)};
schemas.ChangeSummary = object(changeProperties);
schemas.ChangeDetail = object({...changeProperties,diffs:array(object({field:str,before:str,after:str})),conflict:bool});
function responseSchema(path:string,method:string):Schema {
  if (method !== 'DELETE') {
    if(path.endsWith('/notifications/count'))return object({unread:num});
    if(path.endsWith('/notifications'))return array(ref('Notification'));
    if(path.endsWith('/push/key'))return object({publicKey:str});
    if(path.endsWith('/push/subscriptions'))return method==='GET'?array(ref('PushSubscriptionInfo')):ref('PushSubscriptionInfo');
    if(path.endsWith('/push/test')||path.endsWith('/mail/test'))return object({ok:bool,message:str});
    if(path.endsWith('/admin/mail'))return ref('MailSettings');
    if(path.endsWith('/reminders'))return array(ref('UpcomingReminder'));
    if(path.endsWith('/templates'))return array(ref('TemplateSummary'));
    if(path.endsWith('/backlinks'))return array(ref('Backlink'));
    if(path.endsWith('/mentionables'))return ref('Mentionables');
    if(path.endsWith('/comments'))return method==='GET'?array(ref('Comment')):ref('Comment');
    if(path.includes('/comments/'))return ref('Comment');
    if(path.endsWith('/changes/undo'))return object({undone:array(str),conflicts:array(str),failed:array(str)});
    if(path.endsWith('/undo'))return ref('ChangeSummary');
    if(path.endsWith('/changes'))return array(ref('ChangeSummary'));
    if(path.includes('/changes/'))return ref('ChangeDetail');
    if(path.endsWith('/capture'))return object({page:ref('Page')});
  }
  if(path.endsWith('/home'))return ref('HomeLayout');
  if(path.endsWith('/events'))return ref('LiveEvent');
  if(method==='DELETE'||path.endsWith('/logout'))return ref('Ok');
  if(path.endsWith('/openapi.json'))return record();
  if(path.endsWith('/health'))return ref('Health');
  if(path.includes('/auth/')||path.endsWith('/bootstrap'))return ref('Bootstrap');
  if(path.endsWith('/me'))return ref('User');
  if(path.includes('/oauth/requests/'))return method==='GET'?ref('OAuthGrantInfo'):object({redirect:str});
  if(path.endsWith('/connected-apps'))return array(ref('ConnectedApp'));
  if(path.endsWith('/backups/settings'))return ref('BackupSettings');
  if(path.endsWith('/backups/test'))return object({ok:bool,message:str});
  if(path.endsWith('/backups/run'))return ref('BackupRun');
  if(path.endsWith('/backups'))return array(ref('BackupRun'));
  if(path.includes('/jobs/'))return ref('Job');
  if(path.includes('/notion/sources'))return array(ref('NotionSource'));
  if(path.endsWith('/import')||path.endsWith('/notion/export'))return ref('Job');
  if(path.includes('/tokens'))return method==='POST'?object({token:ref('ApiToken'),secret:str}):array(ref('ApiToken'));
  const suffix=path.split('/').at(-1)!;
  const list:Record<string,string>={members:'Member',users:path.startsWith('/api/admin')?'User':'WorkspaceUser',invites:'Invite',rows:'Row',versions:'PageVersion',trash:'TrashItem',search:'SearchHit',recent:'RecentPage',activity:'Activity',calendars:'ExternalCalendar','calendar-events':'CalendarEvent',files:'File',stickies:'Sticky',workspaces:'AdminWorkspace'};
  if(method==='GET'&&list[suffix])return array(ref(list[suffix]));
  if(suffix==='home')return ref('HomeLayout');
  if(suffix==='stats')return ref('WorkspaceStats');
  if(suffix==='calendar-feed')return ref('CalendarFeed');
  if(path.includes('/stickies/'))return ref('Sticky');
  if(suffix==='stickies')return ref('Sticky');
  if(suffix==='calendars')return ref('ExternalCalendar');
  if(suffix==='tree')return ref('Tree');
  if(suffix==='overview')return ref('AdminOverview');
  if(suffix==='settings')return ref('AdminSettings');
  if(suffix==='share')return object({token:str});
  if(suffix==='favorite')return ref('Ok');
  if(suffix==='files')return object({url:str});
  if(path.includes('/public/'))return object({page:ref('Page'),rows:array(ref('Row'))});
  if(path.includes('/pages'))return ref('Page');
  if(path.includes('/members/'))return ref('Member');
  if(path.includes('/admin/users'))return ref('User');
  if(path.includes('/invites/')&&method==='GET')return ref('InviteInfo');
  if(suffix==='invites')return ref('Invite');
  if(path.includes('/workspaces')||suffix==='accept')return ref('WorkspaceSummary');
  return ref('Ok');
}
function inputSchema(path:string,method:string):Schema {
  if(path.endsWith('/notifications/read'))return object({ids:array(str)},[]);
  if(path.endsWith('/push/subscriptions'))return ref('PushSubscriptionInput');
  if(path.endsWith('/admin/mail'))return object({enabled:bool,host:str,port:{type:'integer',minimum:1,maximum:65535},secure:bool,username:str,password:{type:'string',writeOnly:true},from:str,hasPassword:bool},['enabled','host','port','secure','username','from']);
  if(path.endsWith('/mail/test'))return object({to:{type:'string',format:'email'}},[]);
  if(path.endsWith('/save-as-template'))return object({title:str},[]);
  if(path.endsWith('/comments'))return object({body:{type:'string',minLength:1,maxLength:5000},quote:str,threadId:str},['body']);
  if(path.includes('/comments/'))return object({body:{type:'string',minLength:1,maxLength:5000},resolved:bool},[]);
  if(path.endsWith('/changes/undo'))return object({ids:array(str),force:bool},['ids']);
  if(path.endsWith('/undo'))return object({force:bool},[]);
  if(path.endsWith('/capture'))return object({title:str,text:str,url:{type:'string',format:'uri'},workspaceId:str,databaseId:nullable(str)},[]);
  if(path.endsWith('/signup'))return object({email:str,name:str,password:{type:'string',minLength:8},inviteToken:str,token:bool},['email','name','password']);
  if(path.endsWith('/login'))return object({email:str,password:str,token:bool},['email','password']);
  if(path.endsWith('/me'))return object({name:str,color:str,currentPassword:str,newPassword:str,prefs:object({theme:choice('system','light','dark'),accent:choice('blue','violet','green','orange','pink','graphite'),timezone:str,reminderHour:{type:'integer',minimum:0,maximum:23},notify:object({push:bool,email:bool,mentions:bool,comments:bool,assigned:bool},[]),capture:nullable(ref('CaptureTarget'))},[])},[]);
  if(path.includes('/notion/'))return object({token:str,sourceIds:array(str),parentId:str,pageId:str,notionParentPageId:str},path.endsWith('/sources')?['token']:path.endsWith('/import')?['token','sourceIds']:['token','pageId','notionParentPageId']);
  if(path.endsWith('/home'))return object({widgets:{...array(ref('Widget')),maxItems:30}});
  if(path.includes('/stickies'))return object({text:{type:'string',maxLength:2000},color:choice('yellow','pink','blue','green','purple','orange','gray'),visibility,afterId:nullable(str)},[]);
  if(path.endsWith('/calendars'))return object({name:str,url:str,color:optionColor},['name','url']);
  if(path.endsWith('/backups/settings'))return ref('BackupSettings');
  if(path.endsWith('/backups/test'))return object({destination:ref('BackupDestination')});
  if(path.endsWith('/approve'))return object({access,workspaceId:str},['access']);
  if(path.endsWith('/move'))return object({parentId:nullable(str),afterId:nullable(str)},['parentId']);
  if(path.includes('/pages')&&!/(duplicate|restore|favorite|share)$/.test(path))return ref('PageInput');
  if(path.endsWith('/tokens'))return object({name:str,access,workspaceId:str},['name','access']);
  if(path.endsWith('/settings'))return object({instanceName:str,allowSignup:bool},[]);
  if(path.includes('/members/'))return object({role});
  if(path.endsWith('/invites'))return object({email:str,role},['role']);
  if(path.includes('/admin/users'))return object({email:str,name:str,password:str,isAdmin:bool,disabled:bool},method==='POST'?['email','name','password']:[]);
  if(path.includes('/workspaces'))return object({name:str,icon:str,color:str},method==='POST'?['name']:[]);
  return object({},[]);
}
export function openapi(app:Hono<Env>) {
  const paths:Record<string,any>={};
  for(const r of app.routes) {
    if(!r.path.startsWith('/api/')||r.path.startsWith('/api/v1/')||r.path.includes('*')||r.method==='ALL')continue;
    const path=r.path.slice(4).replace(/:([A-Za-z]+)/g,'{$1}');
    const publicEndpoint=['/api/bootstrap','/api/auth/login','/api/auth/signup','/api/health','/api/openapi.json'].includes(r.path)||(r.method==='GET'&&/^\/api\/(public|invites)\//.test(r.path));
    const binary=r.path.endsWith('/export')&&!r.path.includes('/notion/')||r.path.endsWith('/download');
    const parameters:any[]=[...r.path.matchAll(/:([A-Za-z]+)/g)].map(m=>({name:m[1],in:'path',required:true,schema:str}));
    if(r.path.endsWith('/home')&&r.method!=='GET')parameters.push({name:'scope',in:'query',required:true,schema:choice('personal','workspace')});
    if(r.path.endsWith('/calendar-events'))for(const name of ['from','to'])parameters.push({name,in:'query',required:true,schema:{type:'string',format:'date'}});
    if(r.path.endsWith('/export')&&r.path.includes('/pages/'))parameters.push({name:'format',in:'query',schema:choice('md','csv','json')});
    if(r.path.endsWith('/search'))parameters.push({name:'q',in:'query',required:true,schema:str});
    if(/\/(search|recent|activity)$/.test(r.path))parameters.push({name:'limit',in:'query',schema:{type:'integer',maximum:200}});
    if(r.method==='GET'&&r.path.endsWith('/notifications')) {
      parameters.push({name:'unread',in:'query',schema:choice('1')},{name:'limit',in:'query',schema:{type:'integer',default:50,minimum:1,maximum:200}},{name:'before',in:'query',schema:timestamp});
    }
    if(r.method==='GET'&&r.path.endsWith('/changes')) {
      parameters.push({name:'actor',in:'query',schema:{...choice('ai','user','all'),default:'ai'}},{name:'client',in:'query',schema:str},{name:'before',in:'query',schema:timestamp},{name:'limit',in:'query',schema:{type:'integer',default:50,minimum:1,maximum:200}});
    }
    if(r.method==='GET'&&r.path.endsWith('/reminders'))parameters.push({name:'days',in:'query',schema:{type:'integer',default:14,minimum:1,maximum:365}});
    if(r.method==='GET'&&r.path.endsWith('/mentionables'))parameters.push({name:'q',in:'query',schema:str});
    if(r.method==='DELETE'&&/\/pages\/:id$/.test(r.path))parameters.push({name:'permanent',in:'query',schema:choice('1')});
    const multipart=r.method==='POST'&&(r.path.endsWith('/import')&&!r.path.includes('/notion/')||r.path.endsWith('/files'));
    const contentType=multipart?'multipart/form-data':'application/json';
    const requestBody=['POST','PUT','PATCH'].includes(r.method)?{requestBody:{required:true,content:{[contentType]:{schema:multipart?object({file:{type:'string',format:'binary'},parentId:str},['file']):inputSchema(r.path,r.method)}}}}:{};
    paths[path]??={};paths[path][r.method.toLowerCase()]={operationId:r.method.toLowerCase()+r.path.replace(/\W+/g,'_'),security:publicEndpoint?[]:[{bearerAuth:[]},{cookieAuth:[]}],parameters,...requestBody,responses:{'200':{description:'Success',content:{[binary?'application/octet-stream':r.path.endsWith('/events')?'text/event-stream':'application/json']:{schema:binary?{type:'string',format:'binary'}:responseSchema(r.path,r.method)}}},...Object.fromEntries([400,401,403,404,409].map(status=>[status,{description:({400:'Invalid request',401:'Authentication required',403:'Permission denied',404:'Not found',409:'Conflict'} as Record<number,string>)[status],content:{'application/json':{schema:ref('ApiError')}}}]))}};
  }
  // These endpoints live outside the API prefix; operation servers preserve their URLs.
  const external = (method:string,path:string,response:Schema,input?:Schema,auth=false,status='200',media='application/json') => {
    paths[path]??={}; paths[path][method]={operationId:method+path.replace(/\W+/g,'_'),servers:[{url:'/'}],security:auth?[{bearerAuth:[]},{cookieAuth:[]}]:[],
      ...(input?{requestBody:{required:true,content:{[path==='/oauth/token'?'application/x-www-form-urlencoded':'application/json']:{schema:input}}}}:{}),
      responses:{[status]:{description:'Success',content:{[media]:{schema:response}}}}};
  };
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-authorization-server'])external('get',path,record());
  external('post','/oauth/register',ref('OAuthClient'),ref('OAuthRegistration'),false,'201');
  external('post','/oauth/token',ref('OAuthTokens'),ref('OAuthTokenRequest'));
  external('get','/oauth/authorize',str,undefined,false,'302');
  paths['/oauth/authorize'].get.parameters=['client_id','redirect_uri','response_type','code_challenge','code_challenge_method','scope','state'].map(name=>({name,in:'query',required:true,schema:str}));
  external('get','/cal/{token}.ics',str,undefined,false,'200','text/calendar');
  paths['/cal/{token}.ics'].get.parameters=[{name:'token',in:'path',required:true,schema:str}];
  external('get','/files/{id}/{name}',{type:'string',format:'binary'},undefined,true,'200','application/octet-stream');
  paths['/files/{id}/{name}'].get.parameters=['id','name'].map(name=>({name,in:'path',required:true,schema:str})).concat([{name:'w',in:'query',required:false,schema:num},{name:'share',in:'query',required:false,schema:str}]);
  external('post','/mcp',record(),object({jsonrpc:choice('2.0'),id:{anyOf:[str,num]},method:str,params:record()},['jsonrpc','method']),true);
  return {openapi:'3.1.0',info:{title:'Cairn API',version:'0.3.0'},servers:[{url:'/api/v1'}],paths,components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',description:'Session, API token, or OAuth access token.'},cookieAuth:{type:'apiKey',in:'cookie',name:'cairn_session'}},schemas}};
}
