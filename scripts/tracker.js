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
const SOURCE_TTL = 90000; // Dialog confirmation may take time; stale intents expire.
const DEFEAT_SETTLE_MS = 350;
const ROSTER_POLL_MS = 250; // Backup observation for v13 synthetic token ActorDelta changes.

const SOCKET_CHANNEL = 'module.pf1e-combat-stats';

// ActorDelta changes are absolute values for the synthetic actor data. The
// ActorDelta hook can fire while token.actor still references the old synthetic
// instance. Read only resource paths explicitly supplied by the update.
function healthPatch(changes={}) {
  const paths={hp:game.settings.get(MODULE_ID,'hpPath'),vigor:game.settings.get(MODULE_ID,'vigorPath'),
    wounds:game.settings.get(MODULE_ID,'woundsPath'),soak:'flags.armor-soak-pool.current'};
  const out={};
  for(const [key,path] of Object.entries(paths)) {
    if(!path)continue;
    const candidates=[get(changes,path),changes[path],get(changes,`delta.${path}`),changes[`delta.${path}`]];
    const value=candidates.find(v=>v!==undefined&&v!==null&&Number.isFinite(Number(v)));
    if(value!==undefined)out[key]=Number(value);
  }
  return out;
}
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
  // Do not drop HP just because a PF1e NPC happens to expose dormant
  // Vigor/Wounds fields. Skip HP only when one of those pools ACTUALLY moved.
  const variants = (before.vigor !== null && after.vigor !== null && before.vigor !== after.vigor) ||
    (before.wounds !== null && after.wounds !== null && before.wounds !== after.wounds);
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
// In v13 two unlinked tokens may both have Actor.YR... IDs; their Token IDs
// uniquely identify their synthetic actors. Always prefer Token identity.
function tokenInfo(actor) {
  const uuid = String(actor?.uuid ?? '');
  const match = uuid.match(/Scene\.([^.]+)\.Token\.([^.]+)/);
  return { tokenId: match?.[2] ?? actor?.token?.id ?? actor?.token?._id ?? null,
    sceneId: match?.[1] ?? actor?.token?.parent?.id ?? null };
}
function actorKey(actor) {
  // Full UUID is canonical for the damage/healing event source and recipient.
  return fullActorUuid(actor) ?? `${tokenInfo(actor).sceneId}:${tokenInfo(actor).tokenId}` ?? actor?.id;
}
function combatActor(combatant) { return combatant?.actor ?? combatant?.token?.actor ?? null; }
function fullActorUuid(actor) { return typeof actor?.uuid === 'string' ? actor.uuid : null; }
function tokenUuidForCombatant(cb) {
  return cb?.token?.uuid ?? (cb?.sceneId && cb?.tokenId ? `Scene.${cb.sceneId}.Token.${cb.tokenId}` : null);
}
function actorUuidForCombatant(cb) {
  return fullActorUuid(actorForCombatant(cb)) ?? fullActorUuid(cb?.actor) ?? null;
}
function poolFromTokenDelta(cb, actor) {
  // ActorDelta stores the token actor's ABSOLUTE overrides in Foundry v13.
  // Do not assume the synthetic actor has been rebuilt before hooks fire.
  const delta=cb?.token?.delta ?? cb?.token?.actorDelta ?? null;
  if(!delta) return health(actor);
  const baseline=health(actor);
  const raw=delta._source ?? delta;
  const overrides=healthPatch(raw);
  return {...baseline,...overrides};
}
// Foundry v13 gives every initiative Combatant its own stable document ID.
// Use this over a shared base actor ID or potentially missing token metadata.
// A combatant with no token is still a legitimate participant.
function combatantKey(cb) {
  if (cb?.id) return `Combatant:${cb.id}`;
  const tid=cb?.tokenId ?? cb?.token?.id;
  return tid ? `${cb?.sceneId ?? cb?.parent?.scene?.id ?? 'scene'}:Token:${tid}` :
    String(cb?.actorId ?? cb?.actor?.id ?? 'unknown');
}
function matchesCombatant(cb,actor) {
  if(!cb || !actor) return false;
  // A full synthetic Actor UUID is unique even when multiple unlinked tokens
  // share one base Actor ID. Match that before any weaker form of identity.
  const uuid=fullActorUuid(actor);
  const memberUuid=actorUuidForCombatant(cb);
  if(uuid && memberUuid && uuid===memberUuid) return true;
  const token=tokenInfo(actor);
  const cbTokenId=cb.tokenId ?? cb.token?.id ?? null;
  if(token.tokenId) return Boolean(cbTokenId && cbTokenId===token.tokenId &&
    (!token.sceneId || !cb.sceneId || cb.sceneId===token.sceneId));
  // A world Actor reference may belong to a linked combatant. NEVER identify
  // an unlinked-token instance by the world's base Actor ID alone.
  if(cbTokenId && cb?.token?.actorLink===false) return false;
  if(cbTokenId && cb?.token?.actor && cb.token.actor.uuid!==actor.uuid) return false;
  return Boolean((cb?.actor?.uuid && cb.actor.uuid===uuid) ||
    (cb.actorId && cb.actorId===actor.id && !cbTokenId));
}
function actorForCombatant(cb) {
  // Resolve from the live scene document first; combatant.token may be a stale
  // proxy to a synthetic Actor that was replaced by the ActorDelta update.
  if(cb?.tokenId && canvas?.scene &&
     (!cb.sceneId || cb.sceneId===canvas.scene.id)) {
    const doc=canvas.scene.tokens?.get?.(cb.tokenId);
    if(doc?.actor) return doc.actor;
  }
  return cb?.token?.actor ?? combatActor(cb);
}
function displayNameForCombatant(combat,cb,actor) {
  const name=String(cb?.name || actor?.name || 'Unknown');
  const copies=[...(combat?.combatants??[])].filter(other=>
    String(other?.name || actorForCombatant(other)?.name || 'Unknown')===name);
  if(copies.length<=1) return name;
  const index=copies.findIndex(other=>combatantKey(other)===combatantKey(cb));
  return index<0 ? name : `${name} [${index+1}]`;
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
    this._combatDocuments = new Map(); // Keep deleted-combat document through final flush.
    this._expectedSynthetic = new Map(); // ActorDelta values before synthetic rehydration.
    this._pollTimer = null;
    this._startup = false;
  }
  diagnostics() {
    const combat=game.combat;
    return [...(combat?.combatants??[])].map(cb=>{
      const actor=actorForCombatant(cb);
      const key=`${combat.id}|${combatantKey(cb)}`;
      return {combatantId:cb.id,tokenId:cb.tokenId,sceneId:cb.sceneId,
        name:cb.name,actorUuid:actorUuidForCombatant(cb),tokenUuid:tokenUuidForCombatant(cb),actorName:actor?.name,
        matched:actor?matchesCombatant(cb,actor):false,
        trackedSnapshot:this._snapshot.get(key)??null,
        currentHealth:actor?health(actor):null,mergedActorDeltaHealth:actor?poolFromTokenDelta(cb,actor):null,
        isDefeated:cb.defeated,deltaSource:cb.token?.delta?.uuid};
    });
  }
  _gm() {
    const gm = [...game.users].filter(u=>u.isGM && u.active).sort((a,b)=>a.id.localeCompare(b.id))[0];
    return Boolean(game.user?.isGM && gm?.id===game.user?.id);
  }
  _combat(actor){
    // Only actual initiative combatants belong to a fight. Other tokens on the
    // scene must not appear in the statistics, even if they take damage.
    return [...(game.combats?.contents ?? game.combats ?? [])]
      .find(c=>c.started && [...(c.combatants??[])].some(cb=>matchesCombatant(cb,actor))) ?? null;
  }
  // Ensure current is associated with an actual combat. Prevents default
  // blank-setting recording when a scene is open but no combat is running.
  _hasCombat(combat){
    // Register the complete encounter as soon as initiative exists, even if
    // the GM hasn't clicked Begin Combat. Damage events are only collected
    // after combat has actually started (see _update).
    return Boolean(combat && combat.id && (combat.started ||
      [...(combat.combatants??[])].some(cb=>cb.initiative!==null&&cb.initiative!==undefined)));
  }
  init(){
    this._startup=true;
    this.refreshSnapshots();
    Hooks.on('canvasReady',()=>{this.refreshSnapshots(); this._pollCombatants();});
    // updateActor can miss or expose stale synthetic ActorDelta state in some
    // module workflows. Poll *initiative members only* as an independent backup.
    this._pollTimer=setInterval(()=>this._pollCombatants(),ROSTER_POLL_MS);
    Hooks.on('createCombat',c=>{if(this._hasCombat(c))void this._begin(c);});
    Hooks.on('updateCombat',(c,changes)=>{
      if(c.started || this._hasCombat(c)) void this._begin(c);
      if(changes.started === false) void this._finish(c);
    });
    Hooks.on('deleteCombat',c=>this._finish(c));
    Hooks.on('updateActor',(a,changes,options,userId)=>
      this._update(a,changes,options,userId,null,null,healthPatch(changes)));
    // Synthetic token actor updates are ActorDelta updates in v13. Observe
    // the token's CURRENT actor after the delta has reconstructed it, and
    // independently process explicit resource values supplied in the update.
    Hooks.on('updateActorDelta',(delta,changed,options,userId)=>{
      this._observeActorDelta(delta,changed,options,userId);
    });
    Hooks.on('updateCombatant',(c,changes)=>{
      if(this._hasCombat(c.parent) && !this._combatInitializing.has(c.parent.id)) void this._begin(c.parent);
      this._registerCombatant(c.parent,c);
      if('defeated' in changes && actorForCombatant(c)) this._scheduleDefeat(actorForCombatant(c),c.parent,Boolean(changes.defeated),c);
    });
    Hooks.on('createCombatant',c=>{if(this._hasCombat(c.parent)) void this._begin(c.parent);this._registerCombatant(c.parent,c);});
    Hooks.on('updateToken',(doc,changes,options,userId)=>this._observeToken(doc,changes,options,userId));
    Hooks.on('createChatMessage',msg=>this._noteChatMessage(msg));
    game.socket?.on?.(SOCKET_CHANNEL,(message,senderId)=>this._socketMessage(message,senderId));
    if(globalThis.document) document.addEventListener('click',ev=>this._chatApplyClick(ev),true);
    Hooks.on('createActor',a=>this._snapshot.set(a.uuid,health(a)));
    Hooks.on('deleteActor',a=>this._snapshot.delete(a.uuid));
    Hooks.on('createToken',doc=>{if(doc.actor) this._snapshot.set(doc.actor.uuid,health(doc.actor));});
    this._startup=false;
    for (const c of game.combats ?? []) if(this._hasCombat(c) && this._gm()) void this._begin(c);
  }
  _observeActorDelta(delta,changes={},options={},userId=null) {
    const doc=delta?.parent;
    if(!doc?.actor) return;
    const combat=this._combatTokenDocument(doc);
    if(!combat) return;
    const member=[...combat.combatants].find(c=>(c.tokenId??c.token?.id)===doc.id &&
      (!c.sceneId || c.sceneId===doc.parent?.id));
    if(!member) return;
    // The delta may contain updates to a new synthetic actor that is not yet
    // reflected by a cached combatant actor. Query again after core finishes.
    const patch=healthPatch(changes);
    if(!Object.keys(patch).length) Object.assign(patch,healthPatch(doc.delta?._source ?? doc.delta ?? {}));
    // Trust explicitly changed resource fields even if core has not yet
    // rebuilt token.actor. The later poll sees the same value and deduplicates.
    if(Object.keys(patch).length) this._update(doc.actor,{},options,userId,combat,member,patch);
    const inspect=()=>this._update(doc.actor,{},options,userId,combat,member);
    queueMicrotask(inspect);
    setTimeout(inspect,35);
    this._debug('ActorDelta update',member.name??doc.name,doc.uuid,changes);
  }
  _combatTokenDocument(doc) {
    if(!doc) return null;
    return [...(game.combats??[])].find(c=>c.started && [...c.combatants].some(cb=>
      (cb.tokenId??cb.token?.id)===doc.id && (!cb.sceneId || cb.sceneId===doc.parent?.id))) ?? null;
  }
  _observeToken(doc,changes={},options={},userId=null){
    // v13 synthetic Actor changes may arrive via TokenDocument.delta, not
    // updateActor. Snapshots prevent duplicate events from both hooks.
    if(doc?.actor){
      const combat=this._combatTokenDocument(doc);
      const cb=doc.id && combat ? [...combat.combatants].find(c=>(c.tokenId??c.token?.id)===doc.id) : null;
      this._update(doc.actor,changes,options,userId,combat,cb,healthPatch(changes));
      if(Object.hasOwn(changes,'delta') || Object.hasOwn(changes,'actorData')) {
        queueMicrotask(()=>{if(doc.actor)this._update(doc.actor,changes,options,userId,combat,cb);});
      }
    }
    const combat=this._combat(doc?.actor);
    if(combat && (Object.hasOwn(changes,'overlayEffect') || Object.hasOwn(changes,'effects'))) this._scheduleDefeat(doc.actor,combat);
  }
  refreshSnapshots(){
    for(const actor of game.actors ?? []) {if(!this._snapshot.has(actor.uuid)) this._snapshot.set(actor.uuid,health(actor));this._lastDowned.set(actor.uuid,this._isDown(actor));}
    for(const token of canvas?.tokens?.placeables ?? []) if(token.actor && !this._snapshot.has(token.actor.uuid)) this._snapshot.set(token.actor.uuid,health(token.actor));
    for(const combat of game.combats ?? []) for(const cb of combat.combatants ?? []) {const a=actorForCombatant(cb);if(a && !this._snapshot.has(`${combat.id}|${combatantKey(cb)}`)) this._snapshot.set(`${combat.id}|${combatantKey(cb)}`,poolFromTokenDelta(cb,a));}
  }
  _member(combat,actor){
    return [...(combat?.combatants ?? [])].find(cb=>
      actor?.uuid && actorUuidForCombatant(cb)===actor.uuid) ??
      [...(combat?.combatants ?? [])].find(cb=>matchesCombatant(cb,actor)) ?? null;
  }
  _pollCombatants(finalizingCombat=null){
    if(!this._gm() || !game.settings.get(MODULE_ID,'enabled'))return;
    for(const combat of finalizingCombat ? [finalizingCombat] : (game.combats ?? [])) {
      if(!combat.started && !finalizingCombat)continue;
      for(const cb of combat.combatants??[]) {
        const actor=actorForCombatant(cb);
        if(actor) this._update(actor,{}, {pf1csPoll:true,pf1csFinal:Boolean(finalizingCombat)},null,combat,cb);
      }
    }
  }
  _isDown(actor,combat=null) {
    const statuses=actor?.statuses;
    const combatant=this._member(combat,actor);
    return Boolean(combatant?.defeated || ['dead','dying','unconscious','defeated'].some(x=>statuses?.has?.(x)));
  }
  _isDead(actor,combat=null) {
    const combatant=this._member(combat,actor);
    return Boolean(actor?.statuses?.has?.('dead') || (combatant?.defeated && game.settings.get(MODULE_ID,'defeatedCountsAsKill')));
  }
  _scheduleDefeat(actor,combat,explicit=null,explicitMember=null) {
    if(!actor || !combat || !this._gm()) return;
    const member=explicitMember ?? this._member(combat,actor);
    if(!member) return;
    const down = explicit===null ? this._isDown(actor,combat) : explicit;
    const key=`${combat.id}|${combatantKey(member)}`;
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
      await this._flush(key);
      await this._writer.catch(()=>{});
      const latest=this._recentDamage.get(combatantKey(member));
      const source=latest?.source && latest.combatId===combat.id && now()-latest.ts<15000 ? latest.source : null;
      const defeated=this._isDead(actor,combat) || (explicit===true && game.settings.get(MODULE_ID,'defeatedCountsAsKill'));
      await this.acceptEvent({eventId:uid(),combatId:combat.id,createdAt:new Date().toISOString(),round:combat.round,turn:combat.turn,
        type:'downed',isDeath:defeated,targetActorUuid:actor.uuid,targetActorId:actor.id,targetName:actor.name,
        targetIsCharacter:characterActor(actor),targetIsToken:Boolean(tokenInfo(actor).tokenId),
        targetCombatantKey:combatantKey(member),
        sourceActorUuid:source?.uuid??null,sourceActorId:source?.id??null,sourceName:source?.name??null,
        sourceCombatantKey:latest?.sourceCombatantKey??null,
        attribution:source?'recent-explicit':'unattributed'});
    },DEFEAT_SETTLE_MS));
  }
  // Do not presume defeat is death without the configured rule. Both are tracked.
  _transitionDefeated(actor,down,combat){this._scheduleDefeat(actor,combat,down);}
  async _registerCombatant(combat,combatant){
    if(!this._gm() || !this._hasCombat(combat)) return;
    const actor=actorForCombatant(combatant);
    if(!actor){this._debug('missing combatant actor',combatant?.name,combatant?.id,combatant?.tokenId);return;}
    const key=combatantKey(combatant);
    if(!this._snapshot.has(`${combat.id}|${key}`)) this._snapshot.set(`${combat.id}|${key}`,poolFromTokenDelta(combatant,actor));
    await this._writer.catch(()=>{});
    this._writer=this._writer.catch(()=>{}).then(async()=>{
      const state=clone(game.settings.get(MODULE_ID,SETTING_CURRENT)??{});
      if(state.combatId!==combat.id) return;
      const bucket=characterActor(actor)?'characters':'enemies';
      const k=key;
      state[bucket]??={};
      if(state[bucket][k])return;
      state[bucket][k]={...recordDefault(actor),name:displayNameForCombatant(combat,combatant,actor),combatantKey:k,tokenId:combatant.tokenId??null};
      await game.settings.set(MODULE_ID,SETTING_CURRENT,state);
    });
    return this._writer;
  }
  _noteChatMessage(msg) { /* Roll messages are not damage application events. */ }
  _chatApplyClick(ev){
    if(!game.settings.get(MODULE_ID,'chatCardAttribution'))return;
    const button=ev.target?.closest?.('[data-action="applyDamage"], [data-action="apply-damage"]');
    const element=button?.closest?.('.chat-message[data-message-id], [data-message-id].chat-message');
    if(!element)return;
    const message=game.messages?.get?.(element.dataset.messageId);
    if(!message?.speaker) return;
    // This is only an action INTENT. No damage is recorded here. Actual loss
    // must still be observed on an enrolled target after the click.
    const toActor = t => t?.actor ?? t?.document?.actor ?? t?.object?.actor ?? null;
    const toDocument = id => canvas?.scene?.tokens?.get?.(id) ?? actorFromUuid(id);
    const listed=Array.isArray(message.system?.targets)
      ? message.system.targets.map(toDocument).filter(Boolean):[];
    // Verified against NAS normalizeTargets(): controlled first, then targets,
    // then message.targets for a click-context application.
    const controlled=[...(canvas?.tokens?.controlled??[])];
    const targeted=[...(game.user?.targets??[])];
    const cardTargets=[...(message.targets??[])];
    const candidates=controlled.length ? controlled : targeted.length ? targeted
      : cardTargets.length ? cardTargets : listed;
    const combat=game.combat;
    const targetUuids=[];
    for(const candidate of candidates) {
      const actor=toActor(candidate);
      if(actor && combat?.started && [...combat.combatants].some(c=>matchesCombatant(c,actor)))
        targetUuids.push(actor.uuid);
    }
    if(!targetUuids.length){this._debug('chat apply clicked without enrolled target',message.id);return;}
    const msg={type:'chatApplied',messageId:message.id,targetUuids:[...new Set(targetUuids)]};
    this._debug('chat apply intent',msg);
    if(this._gm()) this._socketMessage(msg,game.user.id);
    else game.socket?.emit?.(SOCKET_CHANNEL,msg);
  }
  _socketMessage(payload,senderId){
    if(!this._gm() || payload?.type!=='chatApplied' || !payload.messageId || !Array.isArray(payload.targetUuids)) return;
    const sender=game.users?.get?.(senderId)??[...(game.users??[])].find(x=>x.id===senderId);
    const message=game.messages?.get?.(payload.messageId);
    if(!message || !sender || !sender.active) return;
    const combat=game.combat;
    if(!combat?.started) return;
    const source=(message.speaker?.token
      ? canvas?.scene?.tokens?.get?.(message.speaker.token)?.actor : null)
      ?? game.actors?.get?.(message.speaker?.actor)
      ?? message.actor ?? null;
    if(!source || ![...combat.combatants].some(c=>matchesCombatant(c,source))){this._debug('chat source not in initiative',payload.messageId);return;}
    // Non-GM clients may only attribute actions to actors they own or to
    // messages they authored. Do not let target selection forge damage credit.
    if(!sender.isGM && message.author?.id!==senderId &&
      !source.testUserPermission?.(sender,'OWNER')) return;
    const listed=Array.isArray(message.system?.targets)?message.system.targets:[];
    const approved=new Set(listed.map(id=>{
      const doc=canvas?.scene?.tokens?.get?.(id)??actorFromUuid(id);return doc?.actor?.uuid;
    }).filter(Boolean));
    for(const uuid of payload.targetUuids.slice(0,40)){
      // When PF1e's chat card lacks explicit targets, a user-selected target
      // is only a candidate. It is counted only if its actual resources fall.
      if(approved.size && !approved.has(uuid))continue;
      const target=[...combat.combatants].map(actorForCombatant).find(a=>a?.uuid===uuid);
      if(!target)continue;
      if(this.queueSource({sourceActor:source,targetActor:target,itemName:message.item?.name??message.system?.item?.name??'Damage card',messageId:message.id,ttl:20000}))
        this._debug('queued source',source.name,'->',target.name,message.id);
    }
  }
  _debug(...x){ if(game.settings.get(MODULE_ID,'debug')) console.debug('PF1e Combat Stats |',...x); }
  async _begin(combat) {
    if(!this._gm() || !this._hasCombat(combat) || this._combatInitializing.has(combat.id)) return;
    this._combatInitializing.add(combat.id);
    this._combatDocuments.set(combat.id,combat);
    try{
      const current=game.settings.get(MODULE_ID,SETTING_CURRENT)??{};
      if(current.combatId===combat.id) {
        // Existing combats need late-joining combatants even after reconnect.
        for(const cb of combat.combatants ?? []) void this._registerCombatant(combat,cb);
        return;
      }
      if(current.combatId && current.combatId!==combat.id) { this._debug('Another combat already being tracked',current.combatId); return; }
      const hist=game.settings.get(MODULE_ID,SETTING_HISTORY)??[];
      const record={ combatId:combat.id,fightName:combat.name || `Fight #${hist.length+1}`,startedAt:new Date().toISOString(),characters:{},enemies:{},defeated:[],events:[], processedIds:[] };
      await game.settings.set(MODULE_ID,SETTING_CURRENT,record);
      for (const cb of combat.combatants ?? []) {
        const memberActor=actorForCombatant(cb);
        if(!memberActor)continue;
        this._snapshot.set(`${combat.id}|${combatantKey(cb)}`,poolFromTokenDelta(cb,memberActor));
        this._lastDowned.set(`${combat.id}|${combatantKey(cb)}`,this._isDown(memberActor,combat));
        await this._registerCombatant(combat,cb);
      }
    } finally{this._combatInitializing.delete(combat.id);}
  }
  async _finish(combat){
    if(!this._gm()) return;
    this._pollCombatants(combat);
    for(const key of [...this._pending.keys()]) await this._flush(key);
    // Finish can occur immediately after the GM marks a token defeated. Do not
    // discard delayed defeat events when the combat document disappears.
    for(const cb of combat.combatants??[]) {
      const actor=actorForCombatant(cb);
      if(actor && this._isDown(actor,combat)) this._scheduleDefeat(actor,combat,true,cb);
    }
    if(this._defeatTimers.size) await new Promise(resolve=>setTimeout(resolve,DEFEAT_SETTLE_MS+35));
    await this._writer.catch(()=>{});
    const current=game.settings.get(MODULE_ID,SETTING_CURRENT)??{};
    if(current.combatId!==combat.id) return;
    // Catch actors who joined initiative shortly before the encounter ended.
    for(const cb of combat.combatants??[]) await this._registerCombatant(combat,cb);
    // Every initiative participant is retained, including no-action/zero-damage PCs and NPCs.
    const finalState=game.settings.get(MODULE_ID,SETTING_CURRENT)??current;
    const history=game.settings.get(MODULE_ID,SETTING_HISTORY)??[];
    if(history.some(h=>h.combatId===combat.id)) { await game.settings.set(MODULE_ID,SETTING_CURRENT,{});return; }
    const record={...finalState,id:uid(),name:finalState.fightName||combat.name||'Combat',date:new Date().toISOString()};
    await game.settings.set(MODULE_ID,SETTING_HISTORY,[...history,record]);
    await game.settings.set(MODULE_ID,SETTING_CURRENT,{});
    this._combatDocuments.delete(combat.id);
    if(game.settings.get(MODULE_ID,'summaryEnabled')) await SummaryApp.openOnce(record);
  }
  /** An optional explicit trusted attribution context supplied by a PF1e chat macro.
   * Merely targeting an enemy does not establish who damaged it. */
  queueSource({sourceActor,targetActor,itemName='',messageId='',ttl=SOURCE_TTL}={}){
    const src=findActor(sourceActor),tgt=findActor(targetActor);
    if(!src || !tgt || !this._combat(tgt)) return false;
    const contexts=this._sourceContext.get(actorKey(tgt))??[];
    if(messageId && contexts.some(x=>x.messageId===String(messageId) && x.expires>now())) return true;
    contexts.push({source:participant(src),sourceCombatantKey:combatantKey(this._member(this._combat(src),src)),itemName:String(itemName||''),messageId:String(messageId||''),expires:now()+Math.min(120000,Math.max(1000,ttl))});
    this._sourceContext.set(actorKey(tgt),contexts);
    return true;
  }
  _claimSource(actor){
    const items=(this._sourceContext.get(actorKey(actor))||[]).filter(x=>x.expires>=now());
    this._sourceContext.set(actorKey(actor),items);
    if(items.length!==1) return null; // Ambiguous multiple action sources must not be guessed.
    this._sourceContext.delete(actorKey(actor));
    return items[0];
  }
  _update(actor,changes,options,userId,knownCombat=null,knownMember=null,patch=null){
    if(!actor || !this._gm() || !game.settings.get(MODULE_ID,'enabled')) return;
    const combat=knownCombat ?? this._combat(actor);
    if(!knownCombat && !combat && patch && Object.keys(patch).length)
      this._debug('unmatched resource update',actor.uuid,patch);
    if(!combat?.started && !options?.pf1csFinal) {this._debug('resource update ignored: combat not started',actor.name,actor.uuid);return;}
    const member=knownMember ?? this._member(combat,actor);
    if(!member) {this._debug('resource update ignored: not initiative member',actor.name,actor.uuid);return;}
    const key=`${combat.id}|${combatantKey(member)}`;
    if(patch && !Object.keys(patch).length) patch=null;
    const current=knownMember ? poolFromTokenDelta(knownMember,actor) : health(actor);
    // A v13 ActorDelta hook can arrive while TokenDocument.actor still points
    // at the PRE-update synthetic instance. Never let a 250ms poll reset a
    // confirmed future snapshot back to that stale instance (then count it a
    // second time when core rehydrates the actor).
    const expected=this._expectedSynthetic.get(key);
    if(expected && !patch){
      for(const [pool,value] of Object.entries(expected.values)){
        if(current[pool]===value || current[pool]!==expected.before[pool]){
          delete expected.values[pool];delete expected.before[pool];
        } else {current[pool]=value;}
      }
      if(!Object.keys(expected.values).length) this._expectedSynthetic.delete(key);
    }
    if(patch && Object.keys(patch).length){
      const prior=this._expectedSynthetic.get(key)??{values:{},before:{}};
      for(const [pool,value] of Object.entries(patch)) {
        if(current[pool]!==value) {
          if(!(pool in prior.before)) prior.before[pool]=current[pool];
          prior.values[pool]=value;
        } else {delete prior.values[pool];delete prior.before[pool];}
      }
      if(Object.keys(prior.values).length)this._expectedSynthetic.set(key,prior);
      else this._expectedSynthetic.delete(key);
    }
    const next={...current,...(patch??{})};
    const old=this._snapshot.get(key);
    this._snapshot.set(key,next);
    if(!old) {this._debug('new snapshot baseline; first change not counted',actor.name,actor.uuid,key,next);void this._registerCombatant(combat,member);return;}
    const delta=resourceDelta(old,next);
    if(hasChange(delta)) {
      this._debug('resource delta',actor.name,actor.uuid,combatantKey(member),delta);
      if(poolKeys.some(k=>k!=='soakRestored' && delta[k]>0))
        this._enqueue(actor,combat,member,delta,userId,options,old,next);
    }
    this._scheduleDefeat(actor,combat);
  }
  _inferTurnSource(combat,targetMember){
    // Explicitly flagged inference only: reactions, traps, and delayed effects
    // may NOT originate from the current turn. GMs can disable this fallback.
    const cb=combat?.combatant ?? [...(combat?.combatants??[])][combat.turn??-1];
    if(!cb || combatantKey(cb)===combatantKey(targetMember)) return null;
    const actor=actorForCombatant(cb);
    if(!actor) return null;
    return {source:participant(actor),sourceCombatantKey:combatantKey(cb),
      itemName:'Action on initiative turn (inferred)',messageId:'',
      attribution:'inferred-turn'};
  }
  _enqueue(actor,combat,member,delta,userId,options,before=null,after=null){
    // Excess loss past zero is verifiable ONLY where PF1e allows a negative
    // final HP/Wounds value. A clamped-to-zero resource cannot prove overkill.
    let overkill=0;
    for(const pool of ['hp','wounds']){
      const b=before?.[pool],a=after?.[pool];
      if(b==null || a==null || a>=b)continue;
      overkill=Math.max(overkill,Math.max(0,-a)-Math.max(0,-b));
    }
    const key=`${combat.id}|${combatantKey(member)}`;
    let record=this._pending.get(key);
    const changed=new Set(poolKeys.filter(k=>delta[k]));
    // Coalesce the shield + Vigor/Wound writes of one application, but never
    // collapse two successive writes to the SAME health resource into one hit.
    if(record && [...changed].some(k=>record.resources.has(k))){ this._flush(key); record=null; }
    const claimed=this._claimSource(actor);
    const turnFallback=!claimed && delta.soakDamage+delta.vigorDamage+delta.woundDamage+delta.hpDamage>0 &&
      game.settings.get(MODULE_ID,'turnAttributionFallback')
      ? this._inferTurnSource(combat,member) : null;
    const attributed=claimed??turnFallback;
    if(!record){
      record={actor,combat,member,delta:Object.fromEntries(poolKeys.map(k=>[k,0])),resources:new Set(),source:attributed, userId,overkill:0};
      this._pending.set(key,record);
    } else if(!record.source && attributed){ record.source=attributed; }
    record.delta=combine(record.delta,delta);
    record.overkill+=overkill;
    for(const k of changed) record.resources.add(k);
    clearTimeout(record.timer);
    record.timer=setTimeout(()=>this._flush(key),125);
  }
  async _flush(key){
    const entry=this._pending.get(key);
    if(!entry) return;
    this._pending.delete(key);
    clearTimeout(entry.timer);
    const {actor,combat,member,delta,source,overkill}=entry;
    const damage=delta.soakDamage+delta.vigorDamage+delta.woundDamage+delta.hpDamage;
    const heal=delta.vigorHealing+delta.woundHealing+delta.hpHealing;
    const event={
      eventId:uid(),combatId:combat.id,createdAt:new Date().toISOString(),round:combat.round??0,turn:combat.turn??0,
      type:damage?'damage':'healing',sourceActorUuid:source?.source.uuid??null,sourceActorId:source?.source.id??null,
      sourceName:source?.source.name??null,sourceItemName:source?.itemName??null,sourceMessageId:source?.messageId??null,
      sourceCombatantKey:source?.sourceCombatantKey??null,targetCombatantKey:combatantKey(member),
      targetActorId:actor.id,targetActorUuid:actor.uuid,targetName:actor.name,
      targetIsCharacter:characterActor(actor),targetIsToken:Boolean(tokenInfo(actor).tokenId),attribution:source?(source.attribution??'explicit'):'unattributed',
      rawAmount:null,mitigatedAmount:null,overkillAmount:overkill??0,
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
      const combat=[...(game.combats??[])].find(c=>c.id===incoming.combatId) ??
        this._combatDocuments.get(incoming.combatId);
      if(!combat) return;
      const members=[...(combat.combatants??[])];
      const resolve=(key,uuid,id)=>members.find(cb=>key && combatantKey(cb)===key) ??
        members.find(cb=>uuid && actorUuidForCombatant(cb)===uuid) ??
        members.find(cb=>id && !cb.tokenId && cb.actorId===id) ?? null;
      const targetMember=resolve(incoming.targetCombatantKey,incoming.targetActorUuid,incoming.targetActorId);
      const sourceMember=resolve(incoming.sourceCombatantKey,incoming.sourceActorUuid,incoming.sourceActorId);
      if(!targetMember) {this._debug('event target not in initiative',incoming.targetActorUuid);return;}
      const target=actorForCombatant(targetMember);
      const src=sourceMember?actorForCombatant(sourceMember):null;
      const ensureRecord=(actor,cb,meta={})=>{
        if(!cb)return null;
        const bucket=meta.isCharacter ?? (actor?characterActor(actor):false) ? 'characters':'enemies';
        const id=combatantKey(cb);
        state[bucket]??={};
        return state[bucket][id]??={...recordDefault(actor??{
          id:meta.id??id,uuid:meta.uuid??id,name:meta.name??'Unknown',type:bucket==='characters'?'character':'npc'
        }),name:displayNameForCombatant(combat,cb,actor),combatantKey:id,tokenId:cb.tokenId??null};
      };
      const dest=ensureRecord(target,targetMember,{id:incoming.targetActorId,uuid:incoming.targetActorUuid,
        name:incoming.targetName,isCharacter:incoming.targetIsCharacter});
      const owner=sourceMember?ensureRecord(src,sourceMember,{id:incoming.sourceActorId,uuid:incoming.sourceActorUuid,name:incoming.sourceName}):null;
      const amountDamage=incoming.soakDamage+incoming.vigorDamage+incoming.woundDamage+incoming.hpDamage;
      const amountHealing=incoming.vigorHealing+incoming.woundHealing+incoming.hpHealing;
      const knownOverkill=Number.isFinite(incoming.overkillAmount)?Math.max(0,Math.min(amountDamage,incoming.overkillAmount)):0;
      if(dest){
        if(incoming.type==='downed') dest.timesDowned++;
        dest.damageTaken+=amountDamage;dest.soakTaken+=incoming.soakDamage;
        dest.vigorTaken+=incoming.vigorDamage;dest.woundTaken+=incoming.woundDamage+incoming.hpDamage;
        if(amountDamage && !owner) dest.unattributedDamageTaken+=amountDamage;
        dest.healingReceived+=amountHealing;
        dest.excessDamageTaken+=knownOverkill;
      }
      if(incoming.type==='downed' && incoming.isDeath && dest){
        state.defeated??=[];
        const uuid=incoming.targetCombatantKey??incoming.targetActorUuid??incoming.targetActorId;
        if(!state.defeated.some(x=>x.uuid===uuid)) {
          state.defeated.push({uuid,name:incoming.targetName??target?.name??'Unknown',killedBy:owner?(incoming.sourceCombatantKey??incoming.sourceActorId):null});
          if(owner)owner.kills++;
        }
      }
      if(owner && (amountDamage||amountHealing)){
        const dealt=game.settings.get(MODULE_ID,'includeSoakInTotal')?amountDamage:amountDamage-incoming.soakDamage;
        if(amountDamage){
          owner.damageDealt+=dealt;owner.overdamage+=knownOverkill;owner.soakDealt+=incoming.soakDamage;
          owner.vigorDealt+=incoming.vigorDamage;owner.woundDealt+=incoming.woundDamage+incoming.hpDamage;
          if(dealt>owner.maxSingleHit){owner.maxSingleHit=dealt;owner.maxSingleHitSource=incoming.sourceItemName||'—';owner.maxSingleHitRound=incoming.round;}
          const name=String(incoming.sourceItemName||'—');
          const ab=owner.abilities[name]??={damageDealt:0,hits:0,maxHit:0};
          ab.damageDealt+=dealt;ab.hits++;ab.maxHit=Math.max(ab.maxHit,dealt);
        }
        if(amountHealing){owner.healingDone+=amountHealing;if(amountHealing>owner.maxSingleHeal){owner.maxSingleHeal=amountHealing;owner.maxSingleHealSource=incoming.sourceItemName||'—';}}
      }
      if(owner && amountDamage && incoming.targetActorUuid)
        this._recentDamage.set(incoming.targetCombatantKey??incoming.targetActorUuid,{source:participant(src),
          sourceCombatantKey:incoming.sourceCombatantKey,ts:now(),combatId:incoming.combatId,attribution:incoming.attribution});
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
    if(!tgt || ![...combat.combatants].some(c=>matchesCombatant(c,tgt)) ||
      (src && ![...combat.combatants].some(c=>matchesCombatant(c,src)))) return false;
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

export { actorUuidForCombatant, matchesCombatant, actorForCombatant, healthPatch };
