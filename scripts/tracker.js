/**
 * PF1e applied-resource tracker, derivative of Combat Stats v4 by Smantella.
 * We observe ACTUAL resource values, never damage-roll totals. We don't mutate
 * any actor and never patch an application method owned by PF1e/Nevela/Soak.
 * Unattributed damage is tracked as taken but is NOT credited to a random PC.
 */
import { SummaryApp } from './summary.js';
import { MODULE_ID, SETTING_CURRENT, SETTING_HISTORY } from './module.js';

const get = (o,p) => foundry.utils.getProperty(o,p);
const clone = o => foundry.utils.deepClone(o);
const now = () => Date.now();
const uid = () => foundry.utils.randomID();
const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const abs = v => Math.max(0, Math.round(n(v)));
const SOURCE_TTL = 90000; // Applying a chat card may require confirming a damage dialog.
const DEFEAT_SETTLE_MS = 350;
const SOCKET_CHANNEL = 'module.pf1e-combat-stats';

function health(actor) {
  const s = k => game.settings.get(MODULE_ID,k);
  const read = path => {
    const value = get(actor,path);
    return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  };
  const soak = actor?.flags?.['armor-soak-pool'];
  return {
    hp: read(s('hpPath')),
    vigor: read(s('vigorPath')),
    wounds: read(s('woundsPath')),
    soak: soak && Number.isFinite(Number(soak.current)) ? Number(soak.current) : null
  };
}
export function resourceDelta(before,after) {
  const result = { soakDamage:0,vigorDamage:0,woundDamage:0,hpDamage:0,vigorHealing:0,woundHealing:0,hpHealing:0,soakRestored:0 };
  // When Wounds/Vigor are in use, avoid counting system HP again.
  const variants = (before.vigor !== null && after.vigor !== null) || (before.wounds !== null && after.wounds !== null);
  for (const [resource, key] of [['soak','soak'],['vigor','vigor'],['wounds','wounds'],['hp','hp']]) {
    if (resource==='hp' && variants) continue;
    if (before[resource] === null || after[resource] === null) continue;
    const diff = before[resource] - after[resource];
    if (diff > 0) result[resource==='wounds'?'woundDamage':`${resource}Damage`] = abs(diff);
    if (diff < 0) result[resource==='wounds'?'woundHealing':resource==='soak'?'soakRestored':`${resource}Healing`] = abs(-diff);
  }
  return result;
}

const poolKeys = ['soakDamage','vigorDamage','woundDamage','hpDamage','vigorHealing','woundHealing','hpHealing','soakRestored'];
function combine(a,b) { const res={...a}; for(const key of poolKeys) res[key] = (res[key]||0) + (b[key]||0); return res; }
function hasChange(d) { return poolKeys.some(k => d[k]>0); }
function participant(actor) { return {id:actor.id,name:actor.name,uuid:actor.uuid}; }
function characterActor(actor) {
  // PF1e NPC companions may use NPC sheets, while PCs can be embedded token actors.
  // Player ownership is the strongest indication; character sheet type is a fallback.
  return actor?.hasPlayerOwner === true || actor?.type === 'character';
}
function actorKey(actor) { return actor?.isToken && actor?.uuid ? actor.uuid : (actor?.id ?? actor?.uuid); }
function combatActor(combatant) { return combatant?.actor ?? combatant?.token?.actor ?? null; }
function matchesCombatant(combatant, actor) {
  if (!actor || !combatant) return false;
  const subject = combatActor(combatant);
  if (subject === actor || (subject?.uuid && subject.uuid === actor.uuid)) return true;
  if (actor.token && combatant.tokenId && actor.token.id === combatant.tokenId &&
      (!combatant.sceneId || combatant.sceneId === actor.token.parent?.id)) return true;
  // Do not match an unlinked token actor by its base Actor ID: other tokens can share it.
  return !actor.isToken && Boolean(combatant.actorId && combatant.actorId === actor.id);
}
function actorFromUuid(uuid) {
  if (!uuid) return null;
  try { return globalThis.fromUuidSync?.(uuid) ?? null; } catch { return null; }
}
function recordDefault(actor){return { ...participant(actor), damageDealt:0,damageTaken:0,healingDone:0,healingReceived:0,kills:0,overdamage:0,overhealing:0,excessDamageTaken:0,maxSingleHit:0,maxSingleHitSource:'',maxSingleHitRound:null,maxSingleHeal:0,maxSingleHealSource:'',timesDowned:0,abilities:{},soakDealt:0,soakTaken:0,vigorDealt:0,woundDealt:0,vigorTaken:0,woundTaken:0,unattributedDamageTaken:0 }; }
function findActor(ref) {
  if(!ref) return null;
  if(typeof ref === 'object') return ref.actor ?? ref;
  const byUuid=actorFromUuid(ref);
  if(byUuid) return byUuid;
  if(ref.startsWith?.('Actor.')) return game.actors?.get(ref.split('.')[1]);
  return game.actors?.get(ref) ?? null;
}

export class CombatTracker {
  constructor(){
    this._snapshot = new Map();
    this._pending = new Map();
    this._sourceContext = new Map();
    this._lastDowned = new Map();
    this._lastDeath = new Map();
    this._recentDamage = new Map();
    this._writer = Promise.resolve();
    this._seen = new Set();
    this._combatInitializing = new Set();
    this._defeatTimers = new Map();
    this._startup = false;
  }
  _gm() {
    const gm = [...game.users].filter(u=>u.isGM && u.active).sort((a,b)=>a.id.localeCompare(b.id))[0];
    return Boolean(game.user?.isGM && gm?.id===game.user?.id);
  }
  _combat(actor){
    const list = [...(game.combats?.contents ?? game.combats ?? [])];
    const found=list.find(c => c.started && [...(c.combatants ?? [])].some(cb => matchesCombatant(cb,actor)));
    if(found)return found;
    // A GM may damage a scene token that was never added to the initiative roster.
    // Only count it when it is actually represented on the active combat scene.
    const scene=actor?.token?.parent ?? null;
    const inScene=Boolean(actor?.token) || (canvas?.tokens?.placeables??[]).some(t=>t.actor?.uuid===actor.uuid);
    if(!inScene)return null;
    return list.find(c=>c.started && c.scene?.id === (scene?.id??canvas?.scene?.id)) ?? null;
  }
  // Ensure current is associated with an actual combat. Prevents default
  // blank-setting recording when a scene is open but no combat is running.
  _hasCombat(combat){ return Boolean(combat && combat.id && combat.started); }
  init(){
    this._startup=true;
    this.refreshSnapshots();
    Hooks.on('canvasReady',()=>this.refreshSnapshots());
    Hooks.on('createCombat',c=>this._begin(c));
    Hooks.on('updateCombat',(c,changes)=>{ if(c.started) this._begin(c); else if('round' in changes || 'turn' in changes || 'started' in changes || 'active' in changes) this._finish(c); });
    Hooks.on('deleteCombat',c=>this._finish(c));
    Hooks.on('updateActor',(a,changes,options,userId)=>this._update(a,changes,options,userId));
    Hooks.on('updateCombatant',(c,changes)=>{
      if(c.actor) {this._snapshot.set(c.actor.uuid,health(c.actor));this._registerCombatant(c.parent,c);}
      if('defeated' in changes && c.actor) this._scheduleDefeat(c.actor,c.parent,Boolean(changes.defeated));
    });
    Hooks.on('createCombatant',c=>{if(c.actor){this._snapshot.set(c.actor.uuid,health(c.actor));this._registerCombatant(c.parent,c);}});
    Hooks.on('updateToken',(doc,changes)=>{
      const cb=this._combat(doc.actor);
      if(cb && (Object.hasOwn(changes,'overlayEffect') || Object.hasOwn(changes,'effects'))) this._scheduleDefeat(doc.actor,cb);
    });
    Hooks.on('createChatMessage',msg=>this._noteChatMessage(msg));
    game.socket?.on?.(SOCKET_CHANNEL,(message,senderId)=>this._socketMessage(message,senderId));
    if(globalThis.document) document.addEventListener('click',ev=>this._chatApplyClick(ev),true);
    Hooks.on('createActor',a=>this._snapshot.set(a.uuid,health(a)));
    Hooks.on('deleteActor',a=>this._snapshot.delete(a.uuid));
    Hooks.on('createToken',doc=>{if(doc.actor) this._snapshot.set(doc.actor.uuid,health(doc.actor));});
    this._startup=false;
    for (const c of game.combats ?? []) if(c.started && this._gm()) this._begin(c);
  }
  refreshSnapshots(){
    for(const actor of game.actors ?? []) {if(!this._snapshot.has(actor.uuid)) this._snapshot.set(actor.uuid,health(actor));this._lastDowned.set(actor.uuid,this._isDown(actor));}
    for(const token of canvas?.tokens?.placeables ?? []) if(token.actor && !this._snapshot.has(token.actor.uuid)) this._snapshot.set(token.actor.uuid,health(token.actor));
    for(const combat of game.combats ?? []) for(const cb of combat.combatants ?? []) if(cb.actor && !this._snapshot.has(cb.actor.uuid)) this._snapshot.set(cb.actor.uuid,health(cb.actor));
  }
  _isDown(actor,combat=null) {
    const statuses=actor?.statuses;
    const combatant=[...(combat?.combatants??[])].find(cb=>matchesCombatant(cb,actor));
    return Boolean(combatant?.defeated || ['dead','dying','unconscious','defeated'].some(x=>statuses?.has?.(x)));
  }
  _isDead(actor,combat=null) {
    const combatant=[...(combat?.combatants??[])].find(cb=>matchesCombatant(cb,actor));
    return Boolean(actor?.statuses?.has?.('dead') || (combatant?.defeated && game.settings.get(MODULE_ID,'defeatedCountsAsKill')));
  }
  _scheduleDefeat(actor,combat,explicit=null) {
    if(!actor || !combat || !this._gm()) return;
    const down = explicit===null ? this._isDown(actor,combat) : explicit;
    const key=`${combat.id}|${actor.uuid}`;
    if(!down){
      this._lastDowned.set(key,false);
      clearTimeout(this._defeatTimers.get(key));this._defeatTimers.delete(key);
      return;
    }
    if(this._lastDowned.get(key) === true) return;
    this._lastDowned.set(key,true);
    clearTimeout(this._defeatTimers.get(key));
    this._defeatTimers.set(key,setTimeout(async()=>{
      this._defeatTimers.delete(key);
      await this._flush(`${combat.id}|${actor.uuid}`);
      await this._writer.catch(()=>{});
      const latest=this._recentDamage.get(actor.uuid);
      const source=latest?.source && latest.combatId===combat.id && now()-latest.ts<15000 ? latest.source : null;
      const defeated=this._isDead(actor,combat) || (explicit===true && game.settings.get(MODULE_ID,'defeatedCountsAsKill'));
      await this.acceptEvent({eventId:uid(),combatId:combat.id,createdAt:new Date().toISOString(),round:combat.round,turn:combat.turn,
        type:'downed',isDeath:defeated,targetActorUuid:actor.uuid,targetActorId:actor.id,targetName:actor.name,
        targetIsCharacter:characterActor(actor),targetIsToken:Boolean(actor.isToken),
        sourceActorUuid:source?.uuid??null,sourceActorId:source?.id??null,sourceName:source?.name??null,
        attribution:source?'recent-explicit':'unattributed'});
    },DEFEAT_SETTLE_MS));
  }
  // Do not presume defeat is death without the configured rule. Both are tracked.
  _transitionDefeated(actor,down,combat){this._scheduleDefeat(actor,combat,down);}
  async _registerCombatant(combat,combatant){
    if(!this._gm() || !this._hasCombat(combat)) return;
    const actor=combatActor(combatant);if(!actor)return;
    await this._writer.catch(()=>{});
    this._writer=this._writer.catch(()=>{}).then(async()=>{
      const state=clone(game.settings.get(MODULE_ID,SETTING_CURRENT)??{});
      if(state.combatId!==combat.id) return;
      const bucket=characterActor(actor)?'characters':'enemies';
      const k=actorKey(actor);
      state[bucket]??={};
      if(state[bucket][k])return;
      state[bucket][k]=recordDefault(actor);
      await game.settings.set(MODULE_ID,SETTING_CURRENT,state);
    });
    return this._writer;
  }
  _noteChatMessage(msg) { /* Roll messages are not damage application events. */ }
  _chatApplyClick(ev){
    if(!game.settings.get(MODULE_ID,'chatCardAttribution'))return;
    const button=ev.target?.closest?.('[data-action="applyDamage"], [data-action="apply-damage"]');
    const element=button?.closest?.('.chat-message[data-message-id]');
    if(!element)return;
    const message=game.messages?.get?.(element.dataset.messageId);
    if(!message?.speaker?.actor) return;
    const list=Array.isArray(message.system?.targets)?message.system.targets:[];
    // PF1e / Nevela chat messages include explicit target token document IDs.
    // Do not infer an attacker from current user targets or a nearby roll.
    if(!list.length)return;
    const targetUuids=[];
    for(const id of list){
      const doc=canvas?.scene?.tokens?.get?.(id)??actorFromUuid(id);
      if(doc?.actor?.uuid)targetUuids.push(doc.actor.uuid);
    }
    if(!targetUuids.length)return;
    const msg={type:'chatApplied',messageId:message.id,targetUuids:[...new Set(targetUuids)]};
    if(this._gm()) this._socketMessage(msg,game.user.id);
    else game.socket?.emit?.(SOCKET_CHANNEL,msg);
  }
  _socketMessage(payload,senderId){
    if(!this._gm() || payload?.type!=='chatApplied' || !payload.messageId || !Array.isArray(payload.targetUuids)) return;
    const sender=game.users?.get?.(senderId)??[...(game.users??[])].find(x=>x.id===senderId);
    const message=game.messages?.get?.(payload.messageId);
    if(!message || !sender || !sender.active || (!sender.isGM && message.user?.id!==senderId && message.user!==senderId))return;
    const source=message.speaker?.token
      ? canvas?.scene?.tokens?.get?.(message.speaker.token)?.actor
      : game.actors?.get?.(message.speaker?.actor);
    if(!source)return;
    const approved=new Set((message.system?.targets??[]).map(id=>{
      const doc=canvas?.scene?.tokens?.get?.(id)??actorFromUuid(id);return doc?.actor?.uuid;
    }).filter(Boolean));
    for(const uuid of payload.targetUuids){
      if(!approved.has(uuid))continue;
      const target=actorFromUuid(uuid)??[...(canvas?.tokens?.placeables??[])].find(t=>t.actor?.uuid===uuid)?.actor;
      if(target)this.queueSource({sourceActor:source,targetActor:target,itemName:message.item?.name??message.system?.item?.name??'Damage card',messageId:message.id});
    }
  }
  _debug(...x){ if(game.settings.get(MODULE_ID,'debug')) console.debug('PF1e Combat Stats |',...x); }
  async _begin(combat) {
    if(!this._gm() || !this._hasCombat(combat) || this._combatInitializing.has(combat.id)) return;
    this._combatInitializing.add(combat.id);
    try{
      const current=game.settings.get(MODULE_ID,SETTING_CURRENT)??{};
      if(current.combatId===combat.id) {
        // Existing combats need late-joining combatants even after reconnect.
        for(const cb of combat.combatants ?? []) if(cb.actor) void this._registerCombatant(combat,cb);
        return;
      }
      if(current.combatId && current.combatId!==combat.id) { this._debug('Another combat already being tracked',current.combatId); return; }
      const hist=game.settings.get(MODULE_ID,SETTING_HISTORY)??[];
      const record={ combatId:combat.id,fightName:combat.name || `Fight #${hist.length+1}`,startedAt:new Date().toISOString(),characters:{},enemies:{},defeated:[],events:[], processedIds:[] };
      await game.settings.set(MODULE_ID,SETTING_CURRENT,record);
      for (const cb of combat.combatants ?? []) if(cb.actor) {
        this._snapshot.set(cb.actor.uuid,health(cb.actor));
        this._lastDowned.set(`${combat.id}|${cb.actor.uuid}`,this._isDown(cb.actor,combat));
        await this._registerCombatant(combat,cb);
      }
    } finally{this._combatInitializing.delete(combat.id);}
  }
  async _finish(combat){
    if(!this._gm()) return;
    for(const key of [...this._pending.keys()]) await this._flush(key);
    await this._writer.catch(()=>{});
    const current=game.settings.get(MODULE_ID,SETTING_CURRENT)??{};
    if(current.combatId!==combat.id) return;
    const history=game.settings.get(MODULE_ID,SETTING_HISTORY)??[];
    if(history.some(h=>h.combatId===combat.id)) { await game.settings.set(MODULE_ID,SETTING_CURRENT,{});return; }
    const record={...current,id:uid(),name:current.fightName||combat.name||'Combat',date:new Date().toISOString()};
    await game.settings.set(MODULE_ID,SETTING_HISTORY,[...history,record]);
    await game.settings.set(MODULE_ID,SETTING_CURRENT,{});
    if(game.settings.get(MODULE_ID,'summaryEnabled')) await SummaryApp.openOnce(record);
  }
  /** An optional explicit trusted attribution context supplied by a PF1e chat macro.
   * Merely targeting an enemy does not establish who damaged it. */
  queueSource({sourceActor,targetActor,itemName='',messageId='',ttl=SOURCE_TTL}={}){
    const src=findActor(sourceActor),tgt=findActor(targetActor);
    if(!src || !tgt) return false;
    const contexts=this._sourceContext.get(tgt.uuid)??[];
    if(messageId && contexts.some(x=>x.messageId===String(messageId) && x.expires>now())) return true;
    contexts.push({source:participant(src),itemName:String(itemName||''),messageId:String(messageId||''),expires:now()+Math.min(120000,Math.max(1000,ttl))});
    this._sourceContext.set(tgt.uuid,contexts);
    return true;
  }
  _claimSource(actor){
    const items=(this._sourceContext.get(actor.uuid)||[]).filter(x=>x.expires>=now());
    this._sourceContext.set(actor.uuid,items);
    if(items.length!==1) return null; // Ambiguous multiple action sources must not be guessed.
    this._sourceContext.delete(actor.uuid);
    return items[0];
  }
  _update(actor,changes,options,userId){
    const old=this._snapshot.get(actor.uuid);
    const next=health(actor);
    this._snapshot.set(actor.uuid,next);
    if(!old || !this._gm() || !game.settings.get(MODULE_ID,'enabled')) return;
    const combat = this._combat(actor);
    if(!this._hasCombat(combat)) return;
    // Damage to a scene enemy not enrolled in the initiative tracker is still combat damage.
    const member=[...(combat.combatants??[])].find(cb=>matchesCombatant(cb,actor));
    if(member) void this._registerCombatant(combat,member);
    const delta=resourceDelta(old,next);
    if(hasChange(delta) && !Object.keys(delta).every(k=>k==='soakRestored'||!delta[k]))
      this._enqueue(actor,combat,delta,userId,options);
    this._scheduleDefeat(actor,combat);
  }
  _enqueue(actor,combat,delta,userId,options){
    const key=`${combat.id}|${actor.uuid}`;
    let record=this._pending.get(key);
    const changed=new Set(poolKeys.filter(k=>delta[k]));
    // Coalesce the shield + Vigor/Wound writes of one application, but never
    // collapse two successive writes to the SAME health resource into one hit.
    if(record && [...changed].some(k=>record.resources.has(k))){ this._flush(key); record=null; }
    const claimed=this._claimSource(actor);
    if(!record){
      record={actor,combat,delta:Object.fromEntries(poolKeys.map(k=>[k,0])),resources:new Set(),source:claimed, userId};
      this._pending.set(key,record);
    } else if(!record.source && claimed){ record.source=claimed; }
    record.delta=combine(record.delta,delta);
    for(const k of changed) record.resources.add(k);
    clearTimeout(record.timer);
    record.timer=setTimeout(()=>this._flush(key),125);
  }
  async _flush(key){
    const entry=this._pending.get(key);
    if(!entry) return;
    this._pending.delete(key);
    clearTimeout(entry.timer);
    const {actor,combat,delta,source}=entry;
    const damage=delta.soakDamage+delta.vigorDamage+delta.woundDamage+delta.hpDamage;
    const heal=delta.vigorHealing+delta.woundHealing+delta.hpHealing;
    const event={
      eventId:uid(),combatId:combat.id,createdAt:new Date().toISOString(),round:combat.round??0,turn:combat.turn??0,
      type:damage?'damage':'healing',sourceActorUuid:source?.source.uuid??null,sourceActorId:source?.source.id??null,
      sourceName:source?.source.name??null,sourceItemName:source?.itemName??null,sourceMessageId:source?.messageId??null,
      targetActorId:actor.id,targetActorUuid:actor.uuid,targetName:actor.name,
      targetIsCharacter:characterActor(actor),targetIsToken:Boolean(actor.isToken),attribution:source?'explicit':'unattributed',
      rawAmount:null,mitigatedAmount:null,
      ...delta, effectiveAmount:damage||heal
    };
    // Unknown non-soak restoration is not counted as healing by default.
    if(!damage && game.settings.get(MODULE_ID,'strictHealing') && !source){ this._debug('ignored unauthenticated healing',event);return; }
    await this.acceptEvent(event);
  }
  /** Only active GM may write shared stats; this method is also the supported manual adapter. */
  async acceptEvent(event){
    if(!this._gm()) return false;
    if(!event || typeof event!=='object' || typeof event.eventId!=='string') return false;
    const incoming=clone(event);
    const validResources= ['soakDamage','vigorDamage','woundDamage','hpDamage','vigorHealing','woundHealing','hpHealing'];
    for(const field of validResources){const val=Number(incoming[field]??0);if(!Number.isFinite(val)||val<0||val>10000000) return false; incoming[field]=Math.round(val);}
    this._writer=this._writer.catch(err=>console.error(`${MODULE_ID} previous event failed`,err)).then(async()=>{
      const state=clone(game.settings.get(MODULE_ID,SETTING_CURRENT)??{});
      if(!state.combatId || state.combatId!==incoming.combatId || state.processedIds?.includes(incoming.eventId)) return;
      state.processedIds=state.processedIds??[];
      state.processedIds.push(incoming.eventId);
      state.events=state.events??[];state.events.push(incoming);
      if(state.events.length>15000){state.events.shift();state.processedIds.shift();}
      const byId=(id,uuid)=>actorFromUuid(uuid)??game.actors?.get?.(id)??[...(canvas?.tokens?.placeables??[])].find(x=>x.actor?.uuid===uuid)?.actor;
      const target=byId(incoming.targetActorId,incoming.targetActorUuid);
      const src=byId(incoming.sourceActorId,incoming.sourceActorUuid);
      const ensureRecord=(actor,role,meta={})=>{
        const bucket=meta.isCharacter ?? (actor?characterActor(actor):false) ? 'characters':'enemies';
        const id=meta.isToken ? (meta.uuid??actor?.uuid) : (actor?.isToken?actor.uuid:(actor?.id??meta.id??meta.uuid));
        if(!id)return null;
        state[bucket]??={};
        return state[bucket][id]??=actor?recordDefault(actor):recordDefault({id:meta.id??id,uuid:meta.uuid??id,name:meta.name??'Unknown',type:bucket==='characters'?'character':'npc'});
      };
      const dest=ensureRecord(target,'target',{id:incoming.targetActorId,uuid:incoming.targetActorUuid,
        name:incoming.targetName,isCharacter:incoming.targetIsCharacter,isToken:incoming.targetIsToken});
      const owner=src?ensureRecord(src,'source',{id:incoming.sourceActorId,uuid:incoming.sourceActorUuid,name:incoming.sourceName}):null;
      const amountDamage=incoming.soakDamage+incoming.vigorDamage+incoming.woundDamage+incoming.hpDamage;
      const amountHealing=incoming.vigorHealing+incoming.woundHealing+incoming.hpHealing;
      if(dest){
        if(incoming.type==='downed') dest.timesDowned++;
        dest.damageTaken+=amountDamage;dest.soakTaken+=incoming.soakDamage;
        dest.vigorTaken+=incoming.vigorDamage;dest.woundTaken+=incoming.woundDamage+incoming.hpDamage;
        if(amountDamage && !owner) dest.unattributedDamageTaken+=amountDamage;
        dest.healingReceived+=amountHealing;
      }
      if(incoming.type==='downed' && incoming.isDeath && dest){
        state.defeated??=[];
        const uuid=incoming.targetActorUuid??incoming.targetActorId;
        if(!state.defeated.some(x=>x.uuid===uuid)) {
          state.defeated.push({uuid,name:incoming.targetName??target?.name??'Unknown',killedBy:owner?incoming.sourceActorId:null});
          if(owner)owner.kills++;
        }
      }
      if(owner && (amountDamage||amountHealing)){
        const dealt=game.settings.get(MODULE_ID,'includeSoakInTotal')?amountDamage:amountDamage-incoming.soakDamage;
        if(amountDamage){
          owner.damageDealt+=dealt;owner.soakDealt+=incoming.soakDamage;
          owner.vigorDealt+=incoming.vigorDamage;owner.woundDealt+=incoming.woundDamage+incoming.hpDamage;
          if(dealt>owner.maxSingleHit){owner.maxSingleHit=dealt;owner.maxSingleHitSource=incoming.sourceItemName||'—';owner.maxSingleHitRound=incoming.round;}
          const name=String(incoming.sourceItemName||'—');
          const ab=owner.abilities[name]??={damageDealt:0,hits:0,maxHit:0};
          ab.damageDealt+=dealt;ab.hits++;ab.maxHit=Math.max(ab.maxHit,dealt);
        }
        if(amountHealing){owner.healingDone+=amountHealing;if(amountHealing>owner.maxSingleHeal){owner.maxSingleHeal=amountHealing;owner.maxSingleHealSource=incoming.sourceItemName||'—';}}
      }
      if(owner && amountDamage && incoming.targetActorUuid)
        this._recentDamage.set(incoming.targetActorUuid,{source:participant(src),ts:now(),combatId:incoming.combatId});
      await game.settings.set(MODULE_ID,SETTING_CURRENT,state);
      Hooks.callAll('pf1eCombatStats.eventRecorded',incoming);
      this._debug('recorded',incoming);
    });
    await this._writer;
    return true;
  }
  async manualEvent({sourceActor=null,targetActor,resource='vigor',kind='damage',amount=0,itemName='Manual attribution'}={}){
    const combat=game.combat;
    if(!this._hasCombat(combat)||!this._gm()) return false;
    const tgt=findActor(targetActor),src=findActor(sourceActor);
    if(!tgt) return false;
    const amt=abs(amount);
    if(!amt||amt>10000000) return false;
    const e={eventId:uid(),combatId:combat.id,createdAt:new Date().toISOString(),round:combat.round??0,turn:combat.turn??0,
      type:kind,sourceActorUuid:src?.uuid??null,sourceActorId:src?.id??null,
      sourceName:src?.name??null,sourceItemName:String(itemName),targetActorUuid:tgt.uuid,targetActorId:tgt.id,targetName:tgt.name,
      attribution:src?'manual':'unattributed',soakDamage:0,vigorDamage:0,woundDamage:0,hpDamage:0,vigorHealing:0,woundHealing:0,hpHealing:0};
    const field=kind==='healing'? (resource==='wounds'?'woundHealing':resource==='hp'?'hpHealing':'vigorHealing')
      :resource==='soak'?'soakDamage':resource==='wounds'?'woundDamage':resource==='hp'?'hpDamage':'vigorDamage';
    e[field]=amt;
    // This logs an authoritative MANUAL result but does not apply actor damage.
    return this.acceptEvent(e);
  }
}
