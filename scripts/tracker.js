/**
 * PF1e Combat Stats — independent encounter ledger (v1.0.14).
 *
 * The combat document is the sole authority for who participated. Combatant ID
 * is the ledger key, full synthetic Actor UUID is the damage identity, and
 * applied PF1e/Armor Soak resource values are the only damage measurements.
 * This module does not change actor health or patch PF1e/Nevela methods.
 */
import { SummaryApp } from './summary.js';
import { MODULE_ID, SETTING_CURRENT, SETTING_HISTORY } from './module.js';

const CHANNEL = `module.${MODULE_ID}`;
const DAMAGE_KEYS = ['soakDamage','vigorDamage','woundDamage','hpDamage'];
const HEAL_KEYS = ['vigorHealing','woundHealing','hpHealing'];
const GROUP_MS = 180;
const INTENT_MS = 30000;
const KEYS = {hp:'hpPath',vigor:'vigorPath',wounds:'woundsPath'};
const number = x => x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x);
const clone = x => foundry.utils.deepClone(x);
const property = (o,p) => p ? foundry.utils.getProperty(o,p) : undefined;
const random = () => foundry.utils.randomID();
const members = c => [...(c?.combatants ?? [])];
const combats = () => [...(game.combats?.contents ?? game.combats ?? [])];
const tokenId = cb => cb?.tokenId ?? cb?.token?.id ?? null;
const sceneId = cb => cb?.sceneId ?? cb?.parent?.scene?.id ?? cb?.token?.parent?.id ?? null;
const keyOf = cb => String(cb?.id ?? (tokenId(cb) ? `${sceneId(cb)}:${tokenId(cb)}` : cb?.actorId));
const startedRoster = c => Boolean(c?.id && (c.started || members(c).some(cb=>cb.initiative!=null)));
const getSetting = key => {try{return game.settings.get(MODULE_ID,key);}catch{return undefined;}};
const fullUuid = a => typeof a?.uuid==='string' ? a.uuid : null;
const tokenIdentity = uuid => /^Scene\.([^.]+)\.Token\.([^.]+)(?:\.|$)/.exec(uuid??'');

function tokenDoc(cb) {
  const id=tokenId(cb), scene=cb?.parent?.scene ?? game.scenes?.get?.(sceneId(cb)) ??
    (canvas?.scene?.id===sceneId(cb) || !sceneId(cb) ? canvas?.scene : null);
  return (id && scene?.tokens?.get?.(id)) || cb?.token || null;
}
function actorOf(cb) {
  const tok=tokenDoc(cb);
  // A synthetic token actor must NEVER be replaced with its shared world actor.
  if(tok?.actor) return tok.actor;
  if(tok?.actorLink===false) return null;
  return cb?.actor ?? (cb?.actorId && game.actors?.get?.(cb.actorId)) ?? null;
}
function uuidOf(cb) {
  const actor=actorOf(cb),tok=tokenDoc(cb),id=tokenId(cb);
  if(id && tok?.actorLink===false) return `Scene.${sceneId(cb)??tok.parent?.id}.Token.${id}.Actor.${cb.actorId??actor?.id}`;
  return fullUuid(actor) ?? (id ? `Scene.${sceneId(cb)}.Token.${id}.Actor.${cb.actorId??'unknown'}` : `Actor.${cb.actorId??'unknown'}`);
}
function sideOf(cb) {
  const actor=actorOf(cb),token=tokenDoc(cb);
  const disposition=number(token?.disposition ?? cb?.disposition ?? actor?.prototypeToken?.disposition);
  if(disposition===1) return 'characters';
  if(disposition===-1) return 'enemies';
  if(actor?.type==='character') return 'characters';
  if(actor?.type==='npc') return 'enemies';
  return actor?.hasPlayerOwner ? 'characters' : 'enemies';
}
function labelOf(cb,combat) {
  const name=String(cb?.name ?? actorOf(cb)?.name ?? tokenDoc(cb)?.name ?? 'Unknown');
  const siblings=members(combat).filter(x=>String(x?.name ?? actorOf(x)?.name ?? tokenDoc(x)?.name ?? 'Unknown')===name);
  return siblings.length<=1?name:`${name} [${siblings.findIndex(x=>keyOf(x)===keyOf(cb))+1}]`;
}
function emptyRow(cb,c) {
  const actor=actorOf(cb);
  return {id:actor?.id??cb?.actorId??keyOf(cb),name:labelOf(cb,c),uuid:uuidOf(cb),actorUuid:uuidOf(cb),
    combatantKey:keyOf(cb),combatantId:cb.id??null,tokenId:tokenId(cb),actorType:actor?.type??'unknown',
    disposition:tokenDoc(cb)?.disposition??null,initiative:cb.initiative??null,side:sideOf(cb),
    damageDealt:0,damageTaken:0,healingDone:0,healingReceived:0,kills:0,overdamage:0,overhealing:0,
    excessDamageTaken:0,maxSingleHit:0,maxSingleHitSource:'',maxSingleHitRound:null,maxSingleHeal:0,
    maxSingleHealSource:'',timesDowned:0,abilities:{},soakDealt:0,soakTaken:0,vigorDealt:0,
    woundDealt:0,vigorTaken:0,woundTaken:0,unattributedDamageTaken:0};
}
function readHealth(actor) {
  const out={soak:number(property(actor,'flags.armor-soak-pool.current'))};
  for(const [name,setting] of Object.entries(KEYS)) out[name]=number(property(actor,getSetting(setting)||`system.attributes.${name}.value`));
  return out;
}
// Path values supplied by updateActor, updateActorDelta or updateToken are
// absolute values, not damage amounts. Do not count a roll or a chat card.
function healthPatch(changes={}) {
  const out={};
  for(const [name,setting] of Object.entries(KEYS)) {
    const path=getSetting(setting)||`system.attributes.${name}.value`;
    const values=[property(changes,path),changes[path],property(changes,`delta.${path}`),changes[`delta.${path}`],
      property(changes,`actorData.${path}`)];
    const value=values.find(v=>number(v)!==null);
    if(value!==undefined)out[name]=Number(value);
  }
  const paths=['flags.armor-soak-pool.current','delta.flags.armor-soak-pool.current',
    'actorData.flags.armor-soak-pool.current'];
  const soak=paths.map(p=>property(changes,p)??changes[p]).find(v=>number(v)!==null);
  if(soak!==undefined)out.soak=Number(soak);
  return out;
}
function deltaHealth(old,next) {
  const out={soakDamage:0,vigorDamage:0,woundDamage:0,hpDamage:0,vigorHealing:0,woundHealing:0,hpHealing:0,soakRestored:0};
  const variant=['vigor','wounds'].some(k=>old[k]!=null && next[k]!=null && old[k]!==next[k]);
  for(const name of ['soak','vigor','wounds','hp']) {
    if(name==='hp' && variant)continue;
    if(old[name]==null || next[name]==null)continue;
    const change=old[name]-next[name];
    const part=name==='wounds'?'wound':name;
    if(change>0)out[`${part}Damage`]=Math.round(change);
    if(change<0)out[name==='soak'?'soakRestored':`${part}Healing`]=Math.round(-change);
  }
  return out;
}
export const resourceDelta = deltaHealth;

function actorRef(ref) {
  if(!ref)return null;
  if(typeof ref==='object')return ref?.actor??ref;
  try{const a=globalThis.fromUuidSync?.(ref);if(a)return a;}catch{}
  return game.actors?.get?.(ref.startsWith?.('Actor.')?ref.slice(6):ref)??null;
}

export class CombatTracker {
  constructor() {
    this.live=null;this.combat=null;this.wasStarted=false;
    this.snapshots=new Map();this.expected=new Map();this.pending=new Map();this.sources=new Map();
    this.lastDamage=new Map();this.dead=new Set();this.down=new Set();this.seen=new Set();
    this.writer=Promise.resolve();this.saveTimer=null;this.pollTimer=null;this.saving=false;this.finishing=false;
    this.serial=0;this.hooks=[];this.wasStarted=false;this.counters={rosterWrites:0,actorUpdates:0,actorDeltaUpdates:0,tokenUpdates:0,resourceDeltas:0,events:0,socketIntents:0,unmatchedActorUpdates:0};
  }
  _gm(){const g=[...(game.users??[])].filter(u=>u.isGM&&u.active).sort((a,b)=>a.id.localeCompare(b.id))[0];return game.user?.isGM&&game.user?.id===g?.id;}
  _debug(...args){if(getSetting('debug'))console.debug('PF1e Combat Stats |',...args);}
  _state(){return this.live ? clone(this.live) : clone(getSetting(SETTING_CURRENT)??{});}
  getLiveRecord(){return this._state();}
  _settingsWrite(key,value){const snapshot=clone(value);this.writer=this.writer.catch(e=>console.error('Combat Stats write failed',e)).then(()=>game.settings.set(MODULE_ID,key,snapshot));return this.writer;}
  _dirty(){if(!this._gm()||!this.live||this.finishing)return;clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>this._persist(),75);}
  _persist(){clearTimeout(this.saveTimer);this.saveTimer=null;if(!this.live)return this.writer;return this._settingsWrite(SETTING_CURRENT,this.live);}
  _ensure(combat){
    if(!this._gm()||!startedRoster(combat))return null;
    if(this.live?.combatId===combat.id){this.wasStarted ||= Boolean(combat.started);this._roster(combat);return this.live;}
    if(this.live && this.live.combatId!==combat.id){this._debug('active encounter differs',this.live.combatId,combat.id);return null;}
    const stored=getSetting(SETTING_CURRENT);
    const old=stored?.combatId===combat.id?clone(stored):null;
    const hist=getSetting(SETTING_HISTORY)??[];
    this.live=old??{combatId:combat.id,fightName:combat.name??`Fight #${hist.length+1}`,startedAt:new Date().toISOString(),characters:{},enemies:{},defeated:[],events:[],processedIds:[]};
    this.combat=combat;this.wasStarted=Boolean(combat.started);
    this._roster(combat,true);
    this._dirty();
    this._debug('encounter opened',combat.id,'roster size',members(combat).length);
    return this.live;
  }
  _roster(combat,resetBaseline=false){
    if(!this.live||this.live.combatId!==combat.id)return;
    let dirty=false;
    for(const cb of members(combat)){
      const id=keyOf(cb),side=sideOf(cb),other=side==='characters'?'enemies':'characters';
      this.live[side]??={};this.live[other]??={};
      const legacyKey=`Combatant:${id}`;
      let row=this.live[side][id]??this.live[other][id]??this.live[side][legacyKey]??this.live[other][legacyKey]??null;
      if(this.live[side][legacyKey]||this.live[other][legacyKey]){delete this.live[side][legacyKey];delete this.live[other][legacyKey];dirty=true;}
      if(this.live[other][id]){delete this.live[other][id];dirty=true;}
      if(!row){row=emptyRow(cb,combat);dirty=true;this.counters.rosterWrites++;}
      Object.assign(row,{name:labelOf(cb,combat),side,uuid:uuidOf(cb),actorUuid:uuidOf(cb),combatantId:cb.id??null,
        combatantKey:id,tokenId:tokenId(cb),initiative:cb.initiative??null,
        actorType:actorOf(cb)?.type??row.actorType,disposition:tokenDoc(cb)?.disposition??row.disposition});
      this.live[side][id]=row;
      if(resetBaseline||!this.snapshots.has(id)){
        const actor=actorOf(cb);
        if(actor)this.snapshots.set(id,this._health(cb));
      }
      if(cb.defeated && !this.dead.has(id) && resetBaseline)this.dead.add(id); // Already defeated before tracking started.
    }
    if(dirty)this._dirty();
  }
  _health(cb){
    const actor=actorOf(cb);
    const h=readHealth(actor);
    const delta=tokenDoc(cb)?.delta?._source??tokenDoc(cb)?.delta;
    if(delta)Object.assign(h,healthPatch(delta));
    return h;
  }
  _findMember(combat,ref){
    if(!combat||!ref)return null;
    const cb=ref?.combatantId?members(combat).find(x=>x.id===ref.combatantId):null;
    if(cb)return cb;
    const actor=actorRef(ref),uuid=typeof ref==='string'?ref:fullUuid(actor)??ref?.uuid;
    const t=tokenIdentity(uuid);
    if(t){return members(combat).find(x=>tokenId(x)===t[2]&&(!sceneId(x)||sceneId(x)===t[1]))??null;}
    if(uuid){const matched=members(combat).filter(x=>uuidOf(x)===uuid);if(matched.length===1)return matched[0];}
    if(actor){const matched=members(combat).filter(x=>x.actorId===actor.id&&(!tokenId(x)||tokenDoc(x)?.actorLink===true));if(matched.length===1)return matched[0];}
    return null;
  }
  _combatFor(ref){return combats().find(c=>c.started&&this._findMember(c,ref))??null;}
  _refreshObserved(cb,patch={},context='poll'){
    if(!this.live||!this.combat?.started)return;
    const id=keyOf(cb);
    if(!this.snapshots.has(id)){this.snapshots.set(id,{...this._health(cb),...patch});return;}
    const before=this.snapshots.get(id);
    const current=this._health(cb);
    const pending=this.expected.get(id)??{};
    // ActorDelta may update before token.actor rehydrates. Ignore stale reads
    // until the synthetic value catches up; do not manufacture a heal.
    for(const [field,expected] of Object.entries(pending)){
      if(field in patch){if(Number(patch[field])!==expected)delete pending[field];}
      else if(current[field]===expected){delete pending[field];}
      else if(current[field]===before[field] || current[field]==null){current[field]=expected;}
      else delete pending[field];
    }
    Object.assign(current,patch);
    for(const [field,value] of Object.entries(patch)){
      if(this._health(cb)[field]!==value)pending[field]=value;
      else delete pending[field];
    }
    if(Object.keys(pending).length)this.expected.set(id,pending);else this.expected.delete(id);
    this.snapshots.set(id,current);
    const result=deltaHealth(before,current);
    const positive=DAMAGE_KEYS.some(k=>result[k]>0),healing=HEAL_KEYS.some(k=>result[k]>0);
    if(positive||healing)this._damageObserved(cb,result,before,current,context);
  }
  _observe(cb,patch={},context='hook'){
    if(!this._gm()||!this.combat?.started)return;
    this._roster(this.combat);
    this._refreshObserved(cb,patch,context);
  }
  _damageObserved(target,result,before,after,context){
    const id=keyOf(target),now=Date.now();
    const damage=DAMAGE_KEYS.reduce((s,k)=>s+result[k],0),heal=HEAL_KEYS.reduce((s,k)=>s+result[k],0);
    if(!damage&&!heal)return;
    const incoming=this.pending.get(id);
    const changed=Object.keys(result).filter(k=>result[k]>0&&k!=='soakRestored');
    // A second pool from the same damage application shares the first source.
    const continuing=Boolean(incoming && now-incoming.at<=GROUP_MS && !changed.some(k=>incoming.resources.has(k)));
    const source=this.sources.has(id)?this._sourceFor(target,damage>0):
      continuing&&incoming.source?incoming.source:this._sourceFor(target,damage>0);
    // Two writes to the SAME resource represent different hits. Soak + HP
    // within a single application are coalesced for max-hit accounting.
    if(incoming && (now-incoming.at>GROUP_MS || (source?.key && incoming.source?.key && source.key!==incoming.source.key) || changed.some(k=>incoming.resources.has(k))))this._flushHit(id);
    let hit=this.pending.get(id);
    if(!hit){hit={id,combat:this.combat,target,resources:new Set(),source:source??null,deltas:{},overkill:0,at:now,timer:null};this.pending.set(id,hit);}
    if(source&&!hit.source)hit.source=source;
    for(const [k,v] of Object.entries(result))hit.deltas[k]=(hit.deltas[k]??0)+v;
    for(const k of changed)hit.resources.add(k);
    for(const field of ['hp','wounds']){
      if(before[field]!=null && after[field]!=null && after[field]<before[field])
        hit.overkill+=Math.max(0,-after[field])-Math.max(0,-before[field]);
    }
    hit.at=now;clearTimeout(hit.timer);hit.timer=setTimeout(()=>this._flushHit(id),GROUP_MS);
    this.counters.resourceDeltas++;
    this._debug('observed resource change',id,result,'attribution',hit.source?.method??'unknown',context);
  }
  _sourceFor(cb,isDamage){
    const id=keyOf(cb),intent=this.sources.get(id);
    if(intent && intent.expires>=Date.now()){
      this.sources.delete(id);
      return intent;
    }
    if(!isDamage||getSetting('turnAttributionFallback')===false)return null;
    const active=this.combat?.combatant??members(this.combat)[this.combat?.turn??-1];
    if(!active||keyOf(active)===id)return null;
    return {key:keyOf(active),itemName:'Initiative turn (inferred)',method:'inferred-turn'};
  }
  _flushHit(id){
    const hit=this.pending.get(id);if(!hit)return;
    this.pending.delete(id);clearTimeout(hit.timer);
    const d=hit.deltas,total=DAMAGE_KEYS.reduce((s,k)=>s+(d[k]??0),0),healing=HEAL_KEYS.reduce((s,k)=>s+(d[k]??0),0);
    if(!total&&!healing)return;
    const ev={eventId:random(),combatId:hit.combat.id,createdAt:new Date().toISOString(),round:hit.combat.round??0,turn:hit.combat.turn??0,
      type:total?'damage':'healing',targetCombatantKey:id,targetActorUuid:uuidOf(hit.target),
      targetActorId:hit.target.actorId,targetName:hit.target.name,
      sourceCombatantKey:hit.source?.key??null,sourceItemName:hit.source?.itemName??'',attribution:hit.source?.method??'unattributed',
      overkillAmount:Math.max(0,hit.overkill),...Object.fromEntries([...DAMAGE_KEYS,...HEAL_KEYS].map(k=>[k,d[k]??0]))};
    if(!total && getSetting('strictHealing')!==false && !hit.source)return;
    this.acceptEvent(ev);
  }
  _rowFor(id){
    return this.live?.characters?.[id]??this.live?.enemies?.[id]??null;
  }
  async acceptEvent(raw){
    if(!this._gm()||!raw?.eventId)return false;
    const event=clone(raw),combat=this.combat;
    if(!this.live||!combat||event.combatId!==this.live.combatId||this.seen.has(event.eventId))return false;
    const target=members(combat).find(cb=>keyOf(cb)===event.targetCombatantKey)??this._findMember(combat,event.targetActorUuid);
    if(!target)return false;
    this._roster(combat);
    this.seen.add(event.eventId);
    const targetKey=keyOf(target),dest=this._rowFor(targetKey);
    const source=members(combat).find(cb=>keyOf(cb)===event.sourceCombatantKey)??this._findMember(combat,event.sourceActorUuid);
    const owner=source?this._rowFor(keyOf(source)):null;
    const d=k=>Math.max(0,Number(event[k])||0);
    const total=DAMAGE_KEYS.reduce((s,k)=>s+d(k),0),healed=HEAL_KEYS.reduce((s,k)=>s+d(k),0);
    const overkill=Math.min(total,Math.max(0,Number(event.overkillAmount)||0));
    // All resource additions happen in one synchronous in-memory transaction.
    dest.damageTaken+=total;dest.soakTaken+=d('soakDamage');dest.vigorTaken+=d('vigorDamage');
    dest.woundTaken+=d('woundDamage')+d('hpDamage');dest.healingReceived+=healed;
    dest.excessDamageTaken+=overkill;
    if(total&&!owner)dest.unattributedDamageTaken+=total;
    if(owner && total){
      const dealt=getSetting('includeSoakInTotal')===false?total-d('soakDamage'):total;
      owner.damageDealt+=dealt;owner.soakDealt+=d('soakDamage');owner.vigorDealt+=d('vigorDamage');
      owner.woundDealt+=d('woundDamage')+d('hpDamage');owner.overdamage+=overkill;
      if(dealt>owner.maxSingleHit){owner.maxSingleHit=dealt;owner.maxSingleHitSource=event.sourceItemName||'—';owner.maxSingleHitRound=event.round;}
      const name=event.sourceItemName||'Unspecified attack';
      const ability=owner.abilities[name]??={damageDealt:0,hits:0,maxHit:0};
      ability.damageDealt+=dealt;ability.hits++;ability.maxHit=Math.max(ability.maxHit,dealt);
      this.lastDamage.set(targetKey,{source:keyOf(source),method:event.attribution});
    }
    if(owner && healed){owner.healingDone+=healed;if(healed>owner.maxSingleHeal){owner.maxSingleHeal=healed;owner.maxSingleHealSource=event.sourceItemName||'—';}}
    this.live.events??=[];this.live.processedIds??=[];
    this.live.events.push(event);this.live.processedIds.push(event.eventId);this.counters.events++;
    if(this.live.events.length>15000){this.live.events.shift();this.live.processedIds.shift();}
    this._dirty();
    Hooks.callAll?.('pf1eCombatStats.eventRecorded',event);
    return true;
  }
  _defeat(cb,explicit=false){
    if(!this.live||!this.combat)return;
    const id=keyOf(cb),actor=actorOf(cb),statuses=actor?.statuses;
    const defeat=explicit||cb.defeated===true||statuses?.has?.('dead')===true;
    const down=defeat||statuses?.has?.('dying')||statuses?.has?.('unconscious');
    if(down&&!this.down.has(id)){this.down.add(id);const row=this._rowFor(id);if(row){row.timesDowned++;this._dirty();}}
    if(!down)this.down.delete(id);
    if(!defeat){if(!down)this.dead.delete(id);return;}
    if(this.dead.has(id))return;
    this._flushHit(id); // same-turn killing blow before manual Defeated transition
    this.dead.add(id);
    const last=this.lastDamage.get(id),killer=last?.source?this._rowFor(last.source):null;
    if(killer)killer.kills++;
    this.live.defeated??=[];
    this.live.defeated.push({uuid:id,name:this._rowFor(id)?.name??cb.name??'Unknown',killedBy:last?.source??null});
    this._dirty();
  }
  _poll(){
    if(!this._gm()||getSetting('enabled')===false)return;
    for(const c of combats())if(startedRoster(c)){
      if(!this.live)this._ensure(c);
      if(this.live?.combatId!==c.id)continue;
      this.combat=c;this._roster(c);
      if(!c.started)continue;
      for(const cb of members(c)){
        this._refreshObserved(cb,{},'poll');this._defeat(cb);
      }
    }
  }
  _observeActor(actor,changes){
    if(!this._gm()||!actor)return;
    this.counters.actorUpdates++;let matched=false;
    for(const c of combats())if(c.started){
      const cb=this._findMember(c,actor);
      if(cb){matched=true;this._ensure(c);this.combat=c;this._observe(cb,healthPatch(changes),'updateActor');}
    }
    if(!matched)this.counters.unmatchedActorUpdates++;
  }
  _observeToken(doc,changes){
    if(!this._gm()||!doc)return;this.counters.tokenUpdates++;
    for(const c of combats())if(c.started){
      const cb=members(c).find(m=>tokenId(m)===doc.id && (!sceneId(m)||sceneId(m)===doc.parent?.id));
      if(cb){this._ensure(c);this.combat=c;this._observe(cb,healthPatch(changes),'updateToken');this._defeat(cb);}
    }
  }
  _observeActorDelta(delta,changes){this.counters.actorDeltaUpdates++;this._observeToken(delta?.parent,changes);}
  queueSource({sourceActor,targetActor,itemName='',messageId='',ttl=INTENT_MS}={}){
    const combat=this.combat??game.combat;
    if(!combat?.started)return false;
    const source=this._findMember(combat,sourceActor),target=this._findMember(combat,targetActor);
    if(!source||!target)return false;
    this.sources.set(keyOf(target),{key:keyOf(source),itemName:String(itemName||''),messageId:String(messageId||''),method:'explicit',expires:Date.now()+Math.min(90000,Math.max(500,ttl))});
    this._debug('source intent',source.name,'->',target.name);
    return true;
  }
  _click(ev){
    if(getSetting('chatCardAttribution')===false)return;
    const btn=ev.target?.closest?.('[data-action="applyDamage"], [data-action="apply-damage"]');
    if(!btn)return;
    const card=btn.closest?.('.chat-message[data-message-id], [data-message-id].chat-message');
    const msg=game.messages?.get?.(card?.dataset?.messageId);
    if(!msg||!game.combat?.started)return;
    const controlled=[...(canvas?.tokens?.controlled??[])];
    const targets=controlled.length?controlled:[...(game.user?.targets??[])];
    const list=targets.length?targets:[...(msg.targets??[])];
    const ids=list.map(t=>t?.actor?.uuid??t?.document?.actor?.uuid).filter(Boolean);
    if(!ids.length)return;
    const payload={type:'intent',userId:game.user?.id,messageId:msg.id,targets:[...new Set(ids)].slice(0,50)};
    if(this._gm())this._socket(payload);else game.socket?.emit?.(CHANNEL,payload);
  }
  _socket(payload){
    if(!this._gm()||payload?.type!=='intent')return;
    const user=game.users?.get?.(payload.userId)??[...(game.users??[])].find(x=>x.id===payload.userId);
    const msg=game.messages?.get?.(payload.messageId);
    if(!user?.active||!msg||!Array.isArray(payload.targets))return;
    const combat=game.combat;
    if(!combat?.started)return;this.counters.socketIntents++;
    const source=msg.speaker?.token?combat.scene?.tokens?.get?.(msg.speaker.token)?.actor??canvas?.scene?.tokens?.get?.(msg.speaker.token)?.actor:null;
    const src=source??game.actors?.get?.(msg.speaker?.actor)??msg.actor;
    if(!src||(!user.isGM&&!src.testUserPermission?.(user,'OWNER')))return;
    if(!this._findMember(combat,src))return;
    for(const id of payload.targets.slice(0,50)){
      const cb=this._findMember(combat,id);
      if(cb)this.queueSource({sourceActor:src,targetActor:{combatantId:cb.id},itemName:msg.item?.name??msg.system?.item?.name??'PF1e Apply Damage',messageId:msg.id});
    }
  }
  init(){
    const on=(event,fn)=>Hooks.on(event,fn);
    on('createCombat',c=>this._ensure(c));
    on('updateCombat',(c,changed={})=>{
      // Stopping without deleting the combat must archive the encounter too.
      if(this.live?.combatId===c.id && this.wasStarted && !c.started){void this._finish(c);return;}
      this._ensure(c);this._poll();
    });
    on('createCombatant',c=>this._ensure(c.parent));
    on('updateCombatant',(c,changes)=>{this._ensure(c.parent);if('defeated' in changes)this._defeat(c,changes.defeated===true);});
    on('deleteCombat',c=>void this._finish(c));
    on('updateActor',(a,changes)=>this._observeActor(a,changes));
    on('updateActorDelta',(delta,changes)=>this._observeActorDelta(delta,changes));
    on('updateToken',(doc,changes)=>this._observeToken(doc,changes));
    on('canvasReady',()=>this._poll());
    game.socket?.on?.(CHANNEL,payload=>this._socket(payload));
    if(globalThis.document)document.addEventListener('click',ev=>this._click(ev),true);
    this.pollTimer=setInterval(()=>this._poll(),300);
    this._poll();
  }
  async _finish(combat){
    if(!this._gm()||!this.live||this.live.combatId!==combat.id||this.finishing)return;
    this.finishing=true;clearTimeout(this.saveTimer);
    this._roster(combat);
    for(const cb of members(combat)){this._refreshObserved(cb,{},'final');this._defeat(cb);}
    for(const id of [...this.pending.keys()])this._flushHit(id);
    for(const cb of members(combat))this._defeat(cb);
    const hist=getSetting(SETTING_HISTORY)??[];
    const snapshot={...clone(this.live),id:random(),name:this.live.fightName??combat.name??'Combat',date:new Date().toISOString()};
    if(!hist.some(h=>h.combatId===combat.id))await this._settingsWrite(SETTING_HISTORY,[...hist,snapshot]);
    this.live=null;this.combat=null;this.wasStarted=false;
    await this._settingsWrite(SETTING_CURRENT,{});
    this.snapshots.clear();this.expected.clear();this.pending.clear();this.sources.clear();this.lastDamage.clear();this.dead.clear();this.down.clear();this.seen.clear();
    this.finishing=false;
    if(getSetting('summaryEnabled')){try{await SummaryApp.openOnce(snapshot);}catch(e){console.warn('Combat Stats summary error',e);}}
  }
  getDebugReport(){return {version:game.modules?.get?.(MODULE_ID)?.version??'unknown',combatId:this.live?.combatId??null,
      counters:{...this.counters},roster:this.diagnostics(),
      pendingHits:[...this.pending.keys()],unclaimedTargets:[...this.sources.keys()],
      events:this.live?.events?.slice(-100)??[],liveStats:this.getLiveRecord()};}
  diagnostics(){
    const c=this.combat??game.combat;
    return members(c).map(cb=>({combatantId:cb.id,name:cb.name,side:sideOf(cb),tokenId:tokenId(cb),actorUuid:uuidOf(cb),
      actorType:actorOf(cb)?.type,disposition:tokenDoc(cb)?.disposition,initiative:cb.initiative,
      registered:Boolean(this._rowFor(keyOf(cb))),stats:this._rowFor(keyOf(cb)),snapshot:this.snapshots.get(keyOf(cb)),currentHealth:this._health(cb)}));
  }
  async manualEvent({sourceActor=null,targetActor,resource='vigor',kind='damage',amount=0,itemName='Manual'}={}){
    const combat=this.combat??game.combat;
    const src=this._findMember(combat,sourceActor),tgt=this._findMember(combat,targetActor);
    if(!tgt||!Number.isFinite(Number(amount))||Number(amount)<=0)return false;
    const d={soakDamage:0,vigorDamage:0,woundDamage:0,hpDamage:0,vigorHealing:0,woundHealing:0,hpHealing:0};
    const field=kind==='healing'?(resource==='wounds'?'woundHealing':resource==='hp'?'hpHealing':'vigorHealing'):
      resource==='soak'?'soakDamage':resource==='wounds'?'woundDamage':resource==='hp'?'hpDamage':'vigorDamage';
    d[field]=Math.round(Number(amount));
    return this.acceptEvent({eventId:random(),combatId:combat.id,type:kind,targetCombatantKey:keyOf(tgt),sourceCombatantKey:src?keyOf(src):null,
      sourceItemName:itemName,round:combat.round??0,turn:combat.turn??0,attribution:'manual',...d});
  }
}
export { healthPatch, actorOf as actorForCombatant, uuidOf as actorUuidForCombatant, sideOf as combatantSide };
