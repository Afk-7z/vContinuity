import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { dataRoot } from "./data-root.mjs";

const DEFAULT_DIR = path.join(dataRoot,"oauth");
const DEFAULT_CONFIG = path.join(DEFAULT_DIR, "config.json");
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const CODE_TTL = 300;
const PENDING_TTL_MS = 10 * 60 * 1000;
const PRUNE_PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_BODY = 256 * 1024;

export const OAUTH_SCOPES = Object.freeze([
  "read","files:read","files:write","commands:run",
  "works:read","works:write","git:read","git:write"
]);

export const OAUTH_SCOPE_DESCRIPTIONS = Object.freeze({
  "read":"Read vContinuity runtime and project metadata",
  "files:read":"Read and search files visible to vContinuity",
  "files:write":"Create, edit, import and prepare files",
  "commands:run":"Run bounded commands and supervised local jobs",
  "works:read":"List and resume persistent shared Work Context",
  "works:write":"Create, checkpoint, hand off and update Work Context",
  "git:read":"Read Git status, diffs, logs, branches and worktrees",
  "git:write":"Create or remove Git branches and worktrees"
});

function nowIso(){ return new Date().toISOString(); }
function nowSec(){ return Math.floor(Date.now()/1000); }
function token(prefix,bytes=32){ return prefix + crypto.randomBytes(bytes).toString("base64url"); }
function hash(value){ return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function pkce(value){ return crypto.createHash("sha256").update(String(value)).digest("base64url"); }
function unique(items){ return [...new Set(items)]; }
function currentScopes(items){ return unique((Array.isArray(items)?items:[]).filter(scope=>OAUTH_SCOPES.includes(scope))); }
function esc(value){ return String(value ?? "").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch])); }
function parseJson(text){ try{return JSON.parse(String(text).replace(/^\uFEFF/,""));}catch{return null;} }
function stripHash(value){ const u=new URL(value);u.hash="";return u.href.replace(/\/$/,""); }
function normalizeOrigin(value){
  if(typeof value!=="string"||!value.trim()) throw new Error("OAuth public origin is required (VCONTINUITY_PUBLIC_ORIGIN or OAuth config publicOrigin)");
  let u;
  try{u=new URL(value);}catch{throw new Error("Invalid OAuth public origin");}
  if(u.protocol!=="https:") throw new Error("OAuth public origin must use HTTPS");
  return u.origin;
}
function parseScopes(value,{allowEmpty=false}={}){
  const list=Array.isArray(value)?value:String(value||"").trim().split(/\s+/);
  const scopes=unique(list.map(x=>String(x).trim()).filter(Boolean));
  if(!scopes.length && !allowEmpty) return [...OAUTH_SCOPES];
  for(const scope of scopes) if(!OAUTH_SCOPES.includes(scope)) throw new Error("Unsupported OAuth scope: "+scope);
  return scopes;
}
function subset(actual,allowed,label="scope"){
  for(const item of actual) if(!allowed.includes(item)) throw new Error(label+" not allowed: "+item);
}
function loopbackHost(host){
  const h=String(host||"").toLowerCase().replace(/^\[|\]$/g,"");
  return h==="localhost"||h==="::1"||h==="127.0.0.1"||h.startsWith("127.");
}
function redirectUri(value){
  const u=new URL(value);
  if(u.hash) throw new Error("redirect_uri must not contain a fragment");
  if(u.protocol==="https:") return u.href;
  if(u.protocol==="http:"&&loopbackHost(u.hostname)) return u.href;
  throw new Error("redirect_uri must use HTTPS or loopback HTTP");
}
function privateIp(address){
  const family=net.isIP(address);
  if(family===4){
    const p=address.split(".").map(Number);
    if([0,10,127].includes(p[0])) return true;
    if(p[0]===169&&p[1]===254) return true;
    if(p[0]===172&&p[1]>=16&&p[1]<=31) return true;
    if(p[0]===192&&p[1]===168) return true;
    if(p[0]===100&&p[1]>=64&&p[1]<=127) return true;
    if(p[0]===198&&(p[1]===18||p[1]===19)) return true;
    return p[0]>=224;
  }
  if(family===6){
    const v=address.toLowerCase();
    return v==="::"||v==="::1"||v.startsWith("fc")||v.startsWith("fd")||/^fe[89ab]/.test(v);
  }
  return true;
}
async function fetchCimdMetadata(value){
  const u=new URL(value);
  if(u.protocol!=="https:"||loopbackHost(u.hostname)) throw new Error("CIMD client_id must use public HTTPS");
  const records=await dns.lookup(u.hostname,{all:true,verbatim:true});
  if(!records.length||records.some(x=>privateIp(x.address))) throw new Error("CIMD client_id resolves to a private or unsafe address");
  const selected=records[0];
  return await new Promise((resolve,reject)=>{
    const request=https.request({
      protocol:"https:",
      hostname:u.hostname,
      port:u.port?Number(u.port):443,
      path:u.pathname+u.search,
      method:"GET",
      servername:u.hostname,
      rejectUnauthorized:true,
      headers:{accept:"application/json","user-agent":"vContinuity-OAuth/0.7.0",host:u.host},
      lookup:(_hostname,options,callback)=>{
        if(options?.all) callback(null,[{address:selected.address,family:selected.family}]);
        else callback(null,selected.address,selected.family);
      }
    },response=>{
      if(response.statusCode!==200){
        response.resume();
        reject(new Error("CIMD metadata fetch failed with HTTP "+response.statusCode));
        return;
      }
      const type=String(response.headers["content-type"]||"").toLowerCase();
      if(!type.includes("application/json")){
        response.resume();
        reject(new Error("CIMD metadata must be application/json"));
        return;
      }
      const chunks=[];let size=0;
      response.on("data",chunk=>{
        size+=chunk.length;
        if(size>MAX_BODY){
          request.destroy(new Error("CIMD metadata response too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end",()=>{
        try{resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}
        catch(error){reject(new Error("Invalid CIMD JSON: "+error.message));}
      });
    });
    request.setTimeout(8000,()=>request.destroy(new Error("CIMD metadata fetch timed out")));
    request.on("error",reject);
    request.end();
  });
}
async function body(req,max=MAX_BODY){
  const chunks=[];let size=0;
  for await(const chunk of req){
    size+=chunk.length;
    if(size>max) throw new Error("OAuth request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function noStore(res){res.setHeader("cache-control","no-store");res.setHeader("pragma","no-cache");}
function json(res,status,data,headers={}){
  noStore(res);
  for(const [k,v] of Object.entries(headers)) res.setHeader(k,v);
  res.writeHead(status,{"content-type":"application/json; charset=utf-8"});
  res.end(JSON.stringify(data));
}
function page(res,status,text){
  noStore(res);
  res.writeHead(status,{
    "content-type":"text/html; charset=utf-8",
    "content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self' http://127.0.0.1:*; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options":"nosniff",
    "referrer-policy":"no-referrer"
  });
  res.end(text);
}
function oauthError(res,status,error,description){json(res,status,{error,...(description?{error_description:description}:{})});}

class JsonStore{
  constructor(root){this.root=path.resolve(root);this.queue=Promise.resolve();}
  async ensure(){await fs.mkdir(this.root,{recursive:true});}
  file(name){return path.join(this.root,name+".json");}
  async read(name,fallback){
    await this.ensure();
    try{return JSON.parse((await fs.readFile(this.file(name),"utf8")).replace(/^\uFEFF/,""));}
    catch(e){if(e?.code==="ENOENT") return structuredClone(fallback);throw e;}
  }
  async write(name,value){
    await this.ensure();
    const file=this.file(name),tmp=file+".tmp-"+process.pid+"-"+crypto.randomBytes(4).toString("hex");
    try{
      await fs.writeFile(tmp,JSON.stringify(value,null,2)+"\n",{encoding:"utf8",flag:"wx",mode:0o600});
      await fs.rename(tmp,file);
    }finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
  }
  async locked(fn){
    const prev=this.queue;let release;
    this.queue=new Promise(r=>{release=r;});
    await prev;
    try{return await fn();}finally{release();}
  }
}

function validateClient(input,{clientId=null}={}){
  if(!input||typeof input!=="object"||Array.isArray(input)) throw new Error("Invalid OAuth client metadata");
  if(!Array.isArray(input.redirect_uris)||!input.redirect_uris.length||input.redirect_uris.length>20) throw new Error("redirect_uris must be a non-empty array");
  const redirects=unique(input.redirect_uris.map(redirectUri));
  const singularAuth=typeof input.token_endpoint_auth_method==="string"?input.token_endpoint_auth_method:null;
  const authChoices=Array.isArray(input.token_endpoint_auth_methods_supported)?unique(input.token_endpoint_auth_methods_supported.map(String)):[];
  const auth=singularAuth==="none" || authChoices.includes("none") || (!singularAuth && authChoices.length===0) ? "none" : null;
  if(!auth) throw new Error("Client must support token_endpoint_auth_method=none");
  if(clientId && typeof input.client_id==="string" && input.client_id!==clientId) throw new Error("CIMD client_id must match the metadata document URL");
  const grants=Array.isArray(input.grant_types)?unique(input.grant_types.map(String)):["authorization_code","refresh_token"];
  if(!grants.includes("authorization_code")) throw new Error("Client must support authorization_code");
  const responses=Array.isArray(input.response_types)?unique(input.response_types.map(String)):["code"];
  if(!responses.includes("code")) throw new Error("Client must support response_type=code");
  const scopes=parseScopes(input.scope||"",{allowEmpty:true});
  return {
    ...(clientId?{client_id:clientId}:{}),
    redirect_uris:redirects,
    token_endpoint_auth_method:"none",
    grant_types:grants,
    response_types:responses,
    application_type:typeof input.application_type==="string"?input.application_type.slice(0,80):"web",
    client_name:typeof input.client_name==="string"?input.client_name.slice(0,300):(clientId||"OAuth client"),
    ...(typeof input.client_uri==="string"?{client_uri:input.client_uri}:{}),
    ...(typeof input.logo_uri==="string"?{logo_uri:input.logo_uri}:{}),
    ...(scopes.length?{scope:scopes.join(" ")}:{})
  };
}

export async function loadOAuthConfig(file){
  const explicitFile=file||process.env.VCONTINUITY_OAUTH_CONFIG;
  let raw={};
  try{
    const content=await fs.readFile(explicitFile?path.resolve(explicitFile):DEFAULT_CONFIG,"utf8");
    raw=parseJson(content);
    if(!raw||typeof raw!=="object"||Array.isArray(raw)) throw new Error("Invalid OAuth configuration JSON");
  }catch(error){
    if(error.code==="ENOENT"&&explicitFile) throw new Error("Explicit OAuth configuration file was not found");
    if(error.code!=="ENOENT") throw error;
  }
  const publicOrigin=normalizeOrigin(process.env.VCONTINUITY_PUBLIC_ORIGIN||raw.publicOrigin);
  const resourcePath=process.env.VCONTINUITY_RESOURCE_PATH||(typeof raw.resourcePath==="string"&&raw.resourcePath.startsWith("/")?raw.resourcePath:"/mcp/web");
  const publicGatewayPort=Number(process.env.VCONTINUITY_PUBLIC_GATEWAY_PORT||raw.publicGatewayPort||7791);
  const adminPort=Number(process.env.VCONTINUITY_ADMIN_PORT||raw.adminPort||7783);
  const storageRoot=process.env.VCONTINUITY_OAUTH_STORAGE_ROOT
    ? path.resolve(process.env.VCONTINUITY_OAUTH_STORAGE_ROOT)
    : raw.storageRoot?path.resolve(raw.storageRoot):DEFAULT_DIR;
  if(!Number.isInteger(publicGatewayPort)||publicGatewayPort<1||publicGatewayPort>65535) throw new Error("Invalid OAuth public gateway port");
  if(!Number.isInteger(adminPort)||adminPort<1||adminPort>65535) throw new Error("Invalid OAuth admin port");
  return {publicOrigin,resourcePath,publicGatewayPort,adminPort,storageRoot};
}

export function requiredScopesForTool(tool,args={}){
  const name=String(tool||"");
  if(name==="vcontinuity.work"){
    const action=String(args.action||"status");
    return ["create","compact","checkpoint","update","handoff","close"].includes(action)
      ? ["works:read","works:write"]
      : ["works:read"];
  }
  if(name==="vcontinuity.project"||name==="vcontinuity.health") return ["read"];
  if(["vcontinuity.fs_list","vcontinuity.fs_read","vcontinuity.fs_search","vcontinuity.file_picker"].includes(name)) return ["files:read"];
  if(["vcontinuity.fs_patch","vcontinuity.fs_write"].includes(name)) return ["files:write"];
  if(name==="vcontinuity.exec"||name==="vcontinuity.job") return ["commands:run"];
  if(name==="vcontinuity.transfer"){
    const action=String(args.action||"workflow");
    return ["import","export"].includes(action)?["files:write"]:["files:read"];
  }
  if(name==="vcontinuity.git"){
    const action=String(args.action||"status");
    return ["branch_create","branch_delete","worktree_create","worktree_remove"].includes(action)
      ? ["git:write"]
      : ["git:read"];
  }
  return ["read"];
}

export function assertToolScopes(tool,args,authInfo){
  if(!authInfo) return;
  const required=requiredScopesForTool(tool,args);
  const granted=Array.isArray(authInfo.scopes)?authInfo.scopes:[];
  const missing=required.filter(x=>!granted.includes(x));
  if(missing.length){
    const e=new Error("OAUTH_INSUFFICIENT_SCOPE: "+missing.join(" "));
    e.code="OAUTH_INSUFFICIENT_SCOPE";e.requiredScopes=required;throw e;
  }
}

export async function createOAuthService(config){
  const publicOrigin=normalizeOrigin(config.publicOrigin);
  const resourcePath=config.resourcePath||"/mcp/web";
  const resourceUrl=stripHash(publicOrigin+resourcePath);
  const store=new JsonStore(config.storageRoot||DEFAULT_DIR);
  const pending=new Map();
  const tokenFlows=new Map();
  const prunePreviews=new WeakMap();
  const cimdCache=new Map();
  const adminCsrf=token("csrf_",24);

  const clients=()=>store.read("clients",{schema:1,clients:[]});
  const grants=()=>store.read("grants",{schema:1,grants:[]});
  const tokens=()=>store.read("tokens",{schema:1,tokens:[]});
  const codes=()=>store.read("codes",{schema:1,codes:[]});

  async function saveClient(record){
    return store.locked(async()=>{
      const doc=await clients(),i=doc.clients.findIndex(x=>x.clientId===record.clientId);
      if(i>=0) doc.clients[i]=record;else doc.clients.push(record);
      await store.write("clients",doc);return record;
    });
  }

  async function resolveClient(clientId){
    const id=String(clientId||"");
    if(!id) throw new Error("client_id is required");
    const doc=await clients();
    const dcr=doc.clients.find(x=>x.clientId===id&&x.source==="dcr");
    if(dcr) return dcr;
    const cached=cimdCache.get(id);
    if(cached&&Date.now()-cached.at<10*60*1000) return cached.record;
    const metadata=validateClient(await fetchCimdMetadata(id),{clientId:id});
    const old=doc.clients.find(x=>x.clientId===id);
    const record={clientId:id,source:"cimd",metadata,createdAt:old?.createdAt||nowIso(),updatedAt:nowIso()};
    cimdCache.set(id,{at:Date.now(),record});await saveClient(record);return record;
  }

  async function registerClient(metadata){
    const valid=validateClient(metadata),clientId=token("cw_client_",18);
    const record={clientId,source:"dcr",metadata:{...valid,client_id:clientId},createdAt:nowIso(),updatedAt:nowIso()};
    await saveClient(record);
    return {...record.metadata,client_id:clientId,client_id_issued_at:nowSec()};
  }

  function cleanupPending(){
    const cutoff=Date.now()-PENDING_TTL_MS;
    for(const [id,item] of pending) if(Date.parse(item.createdAt)<=cutoff||item.consumed) pending.delete(id);
  }

  async function authCode(item,scopes){
    return store.locked(async()=>{
      const [g,c]=await Promise.all([grants(),codes()]);
      cleanupPending();
      if(pending.get(item.id)!==item) throw new Error("Request expired before approval");
      const client=item.client,connectionId=token("conn_",18),code=token("cw_code_",32);
      const grant={connectionId,clientId:client.clientId,clientName:client.metadata.client_name||client.clientId,scopes:[...scopes],resource:resourceUrl,createdAt:nowIso(),updatedAt:nowIso(),revokedAt:null};
      const record={codeHash:hash(code),clientId:client.clientId,connectionId,redirectUri:item.redirectUri,scopes,codeChallenge:item.codeChallenge,resource:item.resource,createdAt:nowIso(),expiresAt:nowSec()+CODE_TTL,usedAt:null};
      c.codes=c.codes.filter(x=>!x.usedAt&&x.expiresAt>nowSec());
      c.codes.push(record);
      await store.write("codes",c);
      cleanupPending();
      if(pending.get(item.id)!==item) throw new Error("Request expired before approval");
      g.grants.push(grant);
      await store.write("grants",g);
      return {code,grant};
    });
  }

  async function issueTokens(record){
    const access=token("cw_at_",32),refresh=token("cw_rt_",32),issued=nowSec();
    await store.locked(async()=>{
      const g=await grants();
      if(!g.grants.some(x=>x.connectionId===record.connectionId&&x.clientId===record.clientId&&!x.revokedAt)){
        throw new Error("OAuth grant is revoked or missing");
      }
      const doc=await tokens();
      doc.tokens=doc.tokens.filter(x=>!x.revokedAt&&x.expiresAt>nowSec()-86400);
      doc.tokens.push(
        {tokenHash:hash(access),kind:"access",clientId:record.clientId,connectionId:record.connectionId,scopes:currentScopes(record.scopes),resource:record.resource,createdAt:nowIso(),expiresAt:issued+ACCESS_TTL,revokedAt:null},
        {tokenHash:hash(refresh),kind:"refresh",clientId:record.clientId,connectionId:record.connectionId,scopes:currentScopes(record.scopes),resource:record.resource,createdAt:nowIso(),expiresAt:issued+REFRESH_TTL,revokedAt:null}
      );
      await store.write("tokens",doc);
    });
    return {access,refresh,expiresIn:ACCESS_TTL};
  }

  async function verifyAccessToken(value){
    const doc=await tokens(),record=doc.tokens.find(x=>x.kind==="access"&&x.tokenHash===hash(value));
    if(!record||record.revokedAt||record.expiresAt<=nowSec()) throw new Error("Invalid or expired access token");
    if(stripHash(record.resource)!==resourceUrl) throw new Error("Access token resource mismatch");
    const gdoc=await grants(),grant=gdoc.grants.find(x=>x.connectionId===record.connectionId);
    if(!grant||grant.revokedAt) throw new Error("OAuth grant is revoked");
    return {token:value,clientId:record.clientId,scopes:currentScopes(record.scopes),expiresAt:record.expiresAt,resource:record.resource,connectionId:record.connectionId,clientName:grant.clientName};
  }

  async function revokeConnection(connectionId){
    await store.locked(async()=>{
      const g=await grants(),grant=g.grants.find(x=>x.connectionId===connectionId);
      if(grant&&!grant.revokedAt){grant.revokedAt=nowIso();grant.updatedAt=nowIso();await store.write("grants",g);}
      const t=await tokens();let changed=false;
      for(const item of t.tokens) if(item.connectionId===connectionId&&!item.revokedAt){item.revokedAt=nowIso();changed=true;}
      if(changed) await store.write("tokens",t);
    });
  }

  function resourceMetadata(){return {resource:resourceUrl,authorization_servers:[publicOrigin],scopes_supported:[...OAUTH_SCOPES],bearer_methods_supported:["header"],resource_name:"vContinuity MCP"};}
  function serverMetadata(){return {issuer:publicOrigin,authorization_endpoint:publicOrigin+"/oauth/authorize",token_endpoint:publicOrigin+"/oauth/token",registration_endpoint:publicOrigin+"/oauth/register",revocation_endpoint:publicOrigin+"/oauth/revoke",scopes_supported:[...OAUTH_SCOPES],response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],token_endpoint_auth_methods_supported:["none"],revocation_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"],client_id_metadata_document_supported:true,authorization_response_iss_parameter_supported:true};}

  async function handleRegister(req,res){
    if(req.method!=="POST") return oauthError(res,405,"invalid_request","POST required");
    try{
      const input=parseJson(await body(req));if(!input) throw new Error("Invalid JSON body");
      json(res,201,await registerClient(input));
    }catch(e){oauthError(res,400,"invalid_client_metadata",e.message);}
  }

  async function handleAuthorize(req,res,url){
    if(req.method!=="GET") return oauthError(res,405,"invalid_request","GET required");
    cleanupPending();
    try{
      if(url.searchParams.get("response_type")!=="code") throw new Error("Only response_type=code is supported");
      const clientId=url.searchParams.get("client_id")||"",client=await resolveClient(clientId);
      const redirect=redirectUri(url.searchParams.get("redirect_uri")||"");
      if(!client.metadata.redirect_uris.includes(redirect)) throw new Error("redirect_uri is not registered");
      const challenge=String(url.searchParams.get("code_challenge")||""),method=String(url.searchParams.get("code_challenge_method")||"");
      if(method!=="S256"||!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new Error("PKCE S256 code_challenge is required");
      const allowed=client.metadata.scope?parseScopes(client.metadata.scope):[...OAUTH_SCOPES];
      const requested=url.searchParams.has("scope")?parseScopes(url.searchParams.get("scope")):allowed;
      subset(requested,allowed);
      const resource=stripHash(url.searchParams.get("resource")||resourceUrl);
      if(resource!==resourceUrl) throw new Error("resource must match "+resourceUrl);
      const id=token("pending_",24),display=crypto.randomInt(100000,1000000).toString();
      pending.set(id,{id,displayCode:display,client,redirectUri:redirect,codeChallenge:challenge,scopes:requested,resource,state:url.searchParams.get("state")||"",status:"pending",createdAt:nowIso(),consumed:false});
      const admin="http://127.0.0.1:"+config.adminPort+"/";
      const text="<!doctype html><html><head><meta charset=\"utf-8\"><title>vContinuity authorization</title><style>body{font-family:system-ui;margin:3rem;max-width:820px;line-height:1.5}.box{border:1px solid #bbb;border-radius:10px;padding:1rem;margin:1rem 0}code{background:#eee;padding:.15rem .3rem}</style></head><body><h1>vContinuity authorization</h1><p>Access is waiting for approval on this computer.</p><div class=\"box\"><b>Client:</b> "+esc(client.metadata.client_name||clientId)+"<br><b>Request code:</b> <code>"+esc(display)+"</code><br><b>Scopes:</b> "+esc(requested.join(" "))+"</div><p><a target=\"_blank\" rel=\"noreferrer\" href=\""+esc(admin)+"\">Open local approval page</a></p><p id=\"status\">Waiting for local approval...</p><script>const id="+JSON.stringify(id)+";async function poll(){try{const r=await fetch('/oauth/pending-status?id='+encodeURIComponent(id),{cache:'no-store'});const x=await r.json();if((x.status==='approved'||x.status==='denied')&&x.redirect){location.href=x.redirect;return;}if(x.status==='expired'){document.getElementById('status').textContent='Request expired. Restart the connection.';return;}}catch{}setTimeout(poll,1200);}poll();</script></body></html>";
      page(res,200,text);
    }catch(e){oauthError(res,400,"invalid_request",e.message);}
  }

  async function handlePending(req,res,url){
    if(req.method!=="GET") return oauthError(res,405,"invalid_request","GET required");
    cleanupPending();const item=pending.get(url.searchParams.get("id")||"");
    if(!item) return json(res,404,{status:"expired"});
    if(item.status==="approved"){
      const u=new URL(item.redirectUri);u.searchParams.set("code",item.code);if(item.state)u.searchParams.set("state",item.state);u.searchParams.set("iss",publicOrigin);
      return json(res,200,{status:"approved",redirect:u.href});
    }
    if(item.status==="denied"){
      const u=new URL(item.redirectUri);u.searchParams.set("error","access_denied");if(item.state)u.searchParams.set("state",item.state);u.searchParams.set("iss",publicOrigin);
      return json(res,200,{status:"denied",redirect:u.href});
    }
    json(res,200,{status:"pending"});
  }

  async function handleToken(req,res){
    if(req.method!=="POST") return oauthError(res,405,"invalid_request","POST required");
    let flowClient;
    try{
      if(String(req.headers["content-type"]||"").split(";")[0].trim().toLowerCase()!=="application/x-www-form-urlencoded") throw new Error("Token endpoint requires application/x-www-form-urlencoded");
      const form=new URLSearchParams(await body(req)),grant=form.get("grant_type")||"",clientId=form.get("client_id")||"";
      flowClient=clientId;
      tokenFlows.set(clientId,(tokenFlows.get(clientId)||0)+1);
      await resolveClient(clientId);
      if(grant==="authorization_code"){
        const code=form.get("code")||"",redirect=redirectUri(form.get("redirect_uri")||""),verifier=form.get("code_verifier")||"",resource=stripHash(form.get("resource")||resourceUrl);
        if(!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error("Invalid PKCE code_verifier");
        let record;
        await store.locked(async()=>{
          const doc=await codes();record=doc.codes.find(x=>x.codeHash===hash(code));
          if(!record||record.usedAt||record.expiresAt<=nowSec()) throw new Error("Invalid or expired authorization code");
          if(record.clientId!==clientId||record.redirectUri!==redirect) throw new Error("Authorization code client or redirect mismatch");
          if(resource!==record.resource) throw new Error("Authorization code resource mismatch");
          if(pkce(verifier)!==record.codeChallenge) throw new Error("PKCE verification failed");
          record.usedAt=nowIso();await store.write("codes",doc);
        });
        const issued=await issueTokens(record);
        return json(res,200,{access_token:issued.access,token_type:"Bearer",expires_in:issued.expiresIn,refresh_token:issued.refresh,scope:record.scopes.join(" ")});
      }
      if(grant==="refresh_token"){
        const refresh=form.get("refresh_token")||"",requested=form.has("scope")?parseScopes(form.get("scope")):null;let record;
        await store.locked(async()=>{
          const doc=await tokens();record=doc.tokens.find(x=>x.kind==="refresh"&&x.tokenHash===hash(refresh));
          if(!record||record.revokedAt||record.expiresAt<=nowSec()) throw new Error("Invalid or expired refresh token");
          if(record.clientId!==clientId) throw new Error("Refresh token client mismatch");
          if(requested) subset(requested,record.scopes);
          record.revokedAt=nowIso();await store.write("tokens",doc);
        });
        const scopes=currentScopes(requested||record.scopes),issued=await issueTokens({...record,scopes});
        return json(res,200,{access_token:issued.access,token_type:"Bearer",expires_in:issued.expiresIn,refresh_token:issued.refresh,scope:scopes.join(" ")});
      }
      oauthError(res,400,"unsupported_grant_type","Supported grants: authorization_code, refresh_token");
    }catch(e){oauthError(res,400,"invalid_grant",e.message);}
    finally{
      if(flowClient!==undefined){
        const remaining=tokenFlows.get(flowClient)-1;
        if(remaining) tokenFlows.set(flowClient,remaining);else tokenFlows.delete(flowClient);
      }
    }
  }

  async function handleRevoke(req,res){
    if(req.method!=="POST") return oauthError(res,405,"invalid_request","POST required");
    try{
      const form=new URLSearchParams(await body(req)),value=form.get("token")||"";
      if(value){
        await store.locked(async()=>{
          const doc=await tokens();let changed=false;
          for(const item of doc.tokens) if(item.tokenHash===hash(value)&&!item.revokedAt){item.revokedAt=nowIso();changed=true;}
          if(changed) await store.write("tokens",doc);
        });
      }
      res.writeHead(200,{"cache-control":"no-store"});res.end();
    }catch(e){oauthError(res,400,"invalid_request",e.message);}
  }

  async function handlePublicRequest(req,res,url){
    const p=url.pathname;
    if(p==="/.well-known/oauth-protected-resource"||p==="/.well-known/oauth-protected-resource/mcp/web"){if(req.method!=="GET"){oauthError(res,405,"invalid_request","GET required");return true;}json(res,200,resourceMetadata());return true;}
    if(p==="/.well-known/oauth-authorization-server"||p==="/.well-known/oauth-authorization-server/mcp/web"){if(req.method!=="GET"){oauthError(res,405,"invalid_request","GET required");return true;}json(res,200,serverMetadata());return true;}
    if(p==="/oauth/register"){await handleRegister(req,res);return true;}
    if(p==="/oauth/authorize"){await handleAuthorize(req,res,url);return true;}
    if(p==="/oauth/pending-status"){await handlePending(req,res,url);return true;}
    if(p==="/oauth/token"){await handleToken(req,res);return true;}
    if(p==="/oauth/revoke"){await handleRevoke(req,res);return true;}
    return false;
  }

  async function verifyBearerRequest(req,res){
    const m=/^Bearer\s+(.+)$/i.exec(String(req.headers.authorization||"")),metadata=publicOrigin+"/.well-known/oauth-protected-resource";
    if(!m){json(res,401,{error:"invalid_token",error_description:"Bearer token required"},{"www-authenticate":"Bearer realm=\"vContinuity\", resource_metadata=\""+metadata+"\""});return false;}
    try{req.auth=await verifyAccessToken(m[1]);return true;}
    catch(e){json(res,401,{error:"invalid_token",error_description:e.message},{"www-authenticate":"Bearer realm=\"vContinuity\", error=\"invalid_token\", resource_metadata=\""+metadata+"\""});return false;}
  }

  async function renderAdmin(res,message=""){
    cleanupPending();
    const g=await grants(),active=g.grants.filter(x=>!x.revokedAt).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    const requests=[...pending.values()].filter(x=>x.status==="pending");
    const requestHtml=requests.length?requests.map(item=>{
      const checks=item.scopes.map(scope=>"<label><input type=\"checkbox\" name=\"scope\" value=\""+esc(scope)+"\" checked> <code>"+esc(scope)+"</code> - "+esc(OAUTH_SCOPE_DESCRIPTIONS[scope]||"")+"</label><br>").join("");
      return "<section><h3>"+esc(item.client.metadata.client_name||item.client.clientId)+"</h3><p>Request code: <b>"+esc(item.displayCode)+"</b><br>Client ID: <code>"+esc(item.client.clientId)+"</code><br>Redirect: <code>"+esc(item.redirectUri)+"</code></p><form method=\"post\" action=\"/decision\"><input type=\"hidden\" name=\"csrf\" value=\""+esc(adminCsrf)+"\"><input type=\"hidden\" name=\"id\" value=\""+esc(item.id)+"\">"+checks+"<p><button name=\"decision\" value=\"approve\">Allow selected access</button> <button name=\"decision\" value=\"deny\">Deny</button></p></form></section>";
    }).join(""):"<p>No pending OAuth requests.</p>";
    const grantsHtml=active.length?active.map(item=>"<li><b>"+esc(item.clientName)+"</b> - <code>"+esc(item.connectionId)+"</code><br>"+esc(item.scopes.join(" "))+"<form method=\"post\" action=\"/decision\"><input type=\"hidden\" name=\"csrf\" value=\""+esc(adminCsrf)+"\"><input type=\"hidden\" name=\"connectionId\" value=\""+esc(item.connectionId)+"\"><button name=\"decision\" value=\"revoke\">Revoke connection</button></form></li>").join(""):"<li>No active grants.</li>";
    page(res,200,"<!doctype html><html><head><meta charset=\"utf-8\"><title>vContinuity OAuth approval</title><style>body{font-family:system-ui;margin:2rem auto;max-width:900px;line-height:1.5;padding:0 1rem}section{border:1px solid #bbb;border-radius:10px;padding:1rem;margin:1rem 0}code{overflow-wrap:anywhere}button{padding:.45rem .7rem;margin:.2rem}.msg{background:#eef;padding:.7rem;border-radius:8px}</style></head><body><h1>vContinuity - Web MCP access</h1>"+(message?"<p class=\"msg\">"+esc(message)+"</p>":"")+"<h2>Pending requests</h2>"+requestHtml+"<h2>Active grants</h2><ul>"+grantsHtml+"</ul><p>Public MCP: <code>"+esc(resourceUrl)+"</code></p></body></html>");
  }

  async function handleAdminRequest(req,res,url){
    if(req.method==="GET"&&url.pathname==="/"){await renderAdmin(res);return true;}
    if(req.method==="POST"&&url.pathname==="/decision"){
      const form=new URLSearchParams(await body(req));
      if(form.get("csrf")!==adminCsrf){page(res,403,"<h1>Invalid CSRF token</h1>");return true;}
      const decision=form.get("decision");
      if(decision==="revoke"){await revokeConnection(form.get("connectionId")||"");await renderAdmin(res,"Connection revoked.");return true;}
      try{
        await decidePending({id:form.get("id"),decision,scopes:form.getAll("scope")});
      }catch(error){await renderAdmin(res,error.message);return true;}
      await renderAdmin(res,decision==="approve"?"Access approved. Return to the authorization tab.":"Access denied. Return to the authorization tab.");
      return true;
    }
    return false;
  }

  async function decidePending({id,decision,scopes=[]}){
    cleanupPending();
    const item=pending.get(String(id||""));
    if(!item||item.status!=="pending") throw new Error("Request is missing, expired, or already decided.");
    if(decision==="deny"){
      item.status="denied";
      return {ok:true,status:"denied",id:item.id};
    }
    if(decision==="approve"){
      const selected=parseScopes(scopes,{allowEmpty:true});
      if(!selected.length) throw new Error("Select at least one permission before approving.");
      subset(selected,item.scopes);
      item.status="deciding";
      let issued;
      try{issued=await authCode(item,selected);}
      catch(error){item.status="denied";throw error;}
      item.status="approved";
      item.code=issued.code;
      item.connectionId=issued.grant.connectionId;
      item.approvedScopes=selected;
      return {ok:true,status:"approved",id:item.id,connectionId:issued.grant.connectionId,scopes:selected};
    }
    throw new Error("Unknown decision");
  }

  async function adminSnapshot(){
    cleanupPending();
    const [g,t,c]=await Promise.all([grants(),tokens(),clients()]);
    const now=nowSec();
    const activeTokens=t.tokens.filter(x=>!x.revokedAt&&x.expiresAt>now);
    const tokenCountsByConn=new Map();
    for(const tok of activeTokens){
      const cur=tokenCountsByConn.get(tok.connectionId)||{access:0,refresh:0};
      if(tok.kind==="access") cur.access++;
      else if(tok.kind==="refresh") cur.refresh++;
      tokenCountsByConn.set(tok.connectionId,cur);
    }
    const activeGrants=g.grants
      .filter(x=>!x.revokedAt)
      .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(item=>({
        ...item,
        activeAccessTokens:tokenCountsByConn.get(item.connectionId)?.access||0,
        activeRefreshTokens:tokenCountsByConn.get(item.connectionId)?.refresh||0
      }));
    const revokedGrantsCount=g.grants.filter(x=>Boolean(x.revokedAt)).length;
    const pendingList=[...pending.values()].filter(x=>x.status==="pending").map(item=>({
      id:item.id,
      displayCode:item.displayCode,
      clientId:item.client.clientId,
      clientName:item.client.metadata.client_name||item.client.clientId,
      redirectUri:item.redirectUri,
      scopes:item.scopes,
      resource:item.resource,
      createdAt:item.createdAt
    }));
    return {
      issuer:publicOrigin,
      resource:resourceUrl,
      scopes:[...OAUTH_SCOPES],
      scopeDescriptions:OAUTH_SCOPE_DESCRIPTIONS,
      pendingRequests:pendingList,
      activeGrants,
      revokedGrantsCount,
      totalClients:c.clients.length,
      dcrClientsCount:c.clients.filter(x=>x.source==="dcr").length,
      cimdClientsCount:c.clients.filter(x=>x.source==="cimd").length,
      activeAccessTokens:activeTokens.filter(x=>x.kind==="access").length,
      activeRefreshTokens:activeTokens.filter(x=>x.kind==="refresh").length
    };
  }

  function pruneEligibility(g,t,c){
    cleanupPending();
    const now=nowSec();
    const busyClients=new Set(tokenFlows.keys());
    for(const item of pending.values()) if(item.status!=="denied") busyClients.add(item.client.clientId);
    const codeConnections=new Set(c.codes.filter(x=>!x.usedAt&&x.expiresAt>now).map(x=>x.connectionId));
    const expired=x=>Number.isSafeInteger(x.expiresAt)&&x.expiresAt<=now;
    const revoked=x=>typeof x.revokedAt==="string"&&Number.isFinite(Date.parse(x.revokedAt));
    const liveTokenConnections=new Set(t.tokens.filter(x=>!revoked(x)&&!expired(x)).map(x=>x.connectionId));
    const idle=x=>!busyClients.has(x.clientId)&&!codeConnections.has(x.connectionId);
    // Client registration is durable. An editable name or lack of grants
    // cannot distinguish a test registration from one that is still useful.
    return {
      grants:g.grants.filter(x=>revoked(x)&&idle(x)&&!liveTokenConnections.has(x.connectionId)),
      tokens:t.tokens.filter(x=>(revoked(x)||expired(x))&&idle(x))
    };
  }

  const fingerprint=record=>hash(JSON.stringify(record));

  async function previewOAuthPrune(){
    return store.locked(async()=>{
      const [g,t,c]=await Promise.all([grants(),tokens(),codes()]);
      const eligible=pruneEligibility(g,t,c);
      const candidates=Object.freeze(Object.create(null));
      prunePreviews.set(candidates,{
        expiresAt:Date.now()+PRUNE_PREVIEW_TTL_MS,
        grants:new Set(eligible.grants.map(fingerprint)),
        tokens:new Set(eligible.tokens.map(fingerprint))
      });
      const items=[
        ...eligible.grants.map(()=>({label:"Revoked OAuth grant",kind:"grant"})),
        ...eligible.tokens.map(x=>({label:x.kind==="refresh"?"Expired or revoked refresh token":"Expired or revoked access token",kind:"token"}))
      ];
      return {items,count:items.length,candidates};
    });
  }

  async function pruneOAuthState({candidates}={}){
    return store.locked(async()=>{
      const preview=prunePreviews.get(candidates);
      const result={ok:false,removedGrants:0,removedTokens:0,removedClients:0};
      if(!preview) return result;
      prunePreviews.delete(candidates);
      if(preview.expiresAt<=Date.now()) return result;
      const [g,t,c]=await Promise.all([grants(),tokens(),codes()]);
      if(preview.expiresAt<=Date.now()) return result;
      const eligible=pruneEligibility(g,t,c);
      const selected=(kind)=>new Set(eligible[kind].filter(x=>preview[kind].has(fingerprint(x))));
      const tokensToRemove=selected("tokens"),grantsToRemove=selected("grants");
      // Write in sequence so a failed token write cannot remove its grant.
      if(tokensToRemove.size){
        t.tokens=t.tokens.filter(x=>!tokensToRemove.has(x));
        try{await store.write("tokens",t);}catch{return result;}
        result.removedTokens=tokensToRemove.size;
      }
      if(grantsToRemove.size){
        // A token flow may have started while the token document was written.
        const stillEligible=new Set(pruneEligibility(g,t,c).grants);
        g.grants=g.grants.filter(x=>!grantsToRemove.has(x)||!stillEligible.has(x));
        const removed=[...grantsToRemove].filter(x=>stillEligible.has(x)).length;
        if(removed){
          try{await store.write("grants",g);}catch{return result;}
          result.removedGrants=removed;
        }
      }
      result.ok=true;
      return result;
    });
  }

  async function status(){
    const g=await grants(),t=await tokens();
    return {enabled:true,issuer:publicOrigin,resource:resourceUrl,scopes:[...OAUTH_SCOPES],activeGrants:g.grants.filter(x=>!x.revokedAt).length,activeAccessTokens:t.tokens.filter(x=>x.kind==="access"&&!x.revokedAt&&x.expiresAt>nowSec()).length,pendingApprovals:[...pending.values()].filter(x=>x.status==="pending").length,adminUrl:"http://127.0.0.1:"+config.adminPort+"/"};
  }

  await store.ensure();
  return {publicOrigin,resourceUrl,scopes:[...OAUTH_SCOPES],adminCsrf,handlePublicRequest,handleAdminRequest,decidePending,adminSnapshot,previewOAuthPrune,pruneOAuthState,verifyBearerRequest,verifyAccessToken,registerClient,resolveClient,serverMetadata,resourceMetadata,status,revokeConnection};
}
