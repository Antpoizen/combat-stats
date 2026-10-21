// Offline event accounting and lifecycle tests; not a replacement for a Foundry v13 world test.
import assert from 'node:assert/strict';
const noop=()=>{};
class Base {static get defaultOptions(){return {}};static get DEFAULT_OPTIONS(){return {}};}
const clone=x=>JSON.parse(JSON.stringify(x));
const props=(o,p)=>p?.split('.').reduce((v,k)=>v?.[k],o);
let i=0;
globalThis.foundry={utils:{getProperty:props,deepClone:clone,mergeObject:(a,b)=>({...a,...b}),randomID:()=>`event${++i}`,escapeHTML:s=>s},appv1:{api:{FormApplication:Base,Application:Base}},applications:{api:{ApplicationV2:Base,HandlebarsApplicationMixin:x=>x}}};
globalThis.FormApplication=Base;
const hooks=new Map();globalThis.Hooks={on:(k,fn)=>{hooks.set(k,[...(hooks.get(k)||[]),fn]);},once:noop,callAll:noop};
const values={currentCombatData:{},combatHistory:[],strictHealing:true,includeSoakInTotal:true,enabled:true,
  vigorPath:'system.attributes.vigor.value',woundsPath:'system.attributes.wounds.value',hpPath:'system.attributes.hp.value',
  defeatedCountsAsKill:true,chatCardAttribution:true,debug:false};
const store=new Map(Object.entries(values).map(([k,v])=>[`pf1e-combat-stats.${k}`,v]));
function actor(id,name,type,stats,flags={},token=null){return {id,uuid:token?`Scene.scene.Token.${token}.Actor.${id}`:`Actor.${id}`,name,type,hasPlayerOwner:type==='character',system:{attributes:{vigor:{value:stats[0]},wounds:{value:stats[1]},hp:{value:stats[0]+stats[1]}}},flags,statuses:new Set(),isToken:!!token,token:token?{id:token,parent:{id:'scene'}}:null};}
const a=actor('A','Alchemist','character',[40,20]),b=actor('B','Fighter','character',[28,20]),c=actor('C','Shaman','character',[27,20]);
const x=actor('X','Goblin','npc',[30,15],{'armor-soak-pool':{current:12}});
const y=actor('Y','Wolf','npc',[22,15],{'armor-soak-pool':{current:8}},'T2');
const z=actor('Z','Specter','npc',[18,15],{'armor-soak-pool':{current:0}},'T3');
const actors=[a,b,c,x,y,z];actors.get=id=>actors.find(v=>v.id===id);actors.find=Array.prototype.find.bind(actors);
globalThis.fromUuidSync=(id)=>actors.find(a=>a.uuid===id || a.id===id)??null;
const combat={id:'combat',scene:{id:'scene'},started:true,name:'Goblin Raid',round:1,turn:0,
  combatants:[{actor:a,actorId:'A'},{actor:b,actorId:'B'},{actor:c,actorId:'C'},{actor:x,actorId:'X'},{actor:y,actorId:'Y',tokenId:'T2',sceneId:'scene',defeated:false}]};
const gm={id:'gm',isGM:true,active:true};
const users=[gm];users.get=id=>users.find(u=>u.id===id);
globalThis.game={settings:{get:(_,key)=>store.get(`pf1e-combat-stats.${key}`),set:async(_,key,value)=>{store.set(`pf1e-combat-stats.${key}`,clone(value));}},user:gm,users,combats:[combat],combat,actors,modules:new Map(),messages:new Map(),socket:{on:noop,emit:noop},i18n:{localize:()=>''}};
globalThis.canvas={scene:{id:'scene',tokens:{get:id=>({T2:y,T3:z})[id]?{actor:({T2:y,T3:z})[id]}:null}},tokens:{placeables:[{actor:y},{actor:z}]}};
const {CombatTracker,resourceDelta}=await import('../scripts/tracker.js');
const tracker=new CombatTracker();tracker.refreshSnapshots();await tracker._begin(combat);
let cur=()=>store.get('pf1e-combat-stats.currentCombatData');
assert.equal(Object.keys(cur().characters).length,3,'all three PCs registered before taking damage');
assert.equal(Object.keys(cur().enemies).length,2,'enemies in initiative registered before taking damage');
assert.equal(tracker._combat(z)?.id,'combat','token enemy not in initiative can be tracked');
// Damage absorbed by Soak then Vigor is one applied event and one attacker.
tracker.queueSource({sourceActor:a,targetActor:x,itemName:'Bomb'});
x.flags['armor-soak-pool'].current=0;tracker._update(x,{}, {},'gm');
x.system.attributes.vigor.value=12;tracker._update(x,{}, {},'gm');
await tracker._flush('combat|Actor.X');
assert.equal(cur().events.length,1);
assert.equal(cur().events[0].soakDamage,12);assert.equal(cur().events[0].vigorDamage,18);
assert.equal(cur().characters.A.damageDealt,30);
assert.equal(cur().enemies.X.damageTaken,30);
// Second character attacks different unlinked-token enemy.
tracker.queueSource({sourceActor:b,targetActor:y,itemName:'Longsword'});
y.system.attributes.vigor.value=17;tracker._update(y,{}, {},'gm');
await tracker._flush(`combat|${y.uuid}`);
assert.equal(cur().characters.B.damageDealt,5);
assert.equal(cur().enemies[y.uuid].damageTaken,5);
// Third character attacks an enemy not enrolled in initiative; it must still be recorded.
tracker.queueSource({sourceActor:c,targetActor:z,itemName:'Hex'});
z.system.attributes.vigor.value=11;tracker._update(z,{}, {},'gm');
await tracker._flush(`combat|${z.uuid}`);
assert.equal(cur().characters.C.damageDealt,7);
assert.equal(cur().enemies[z.uuid].damageTaken,7);
// With no explicit source, damage taken still recorded, but not credited to a random PC.
x.flags['armor-soak-pool'].current=12;tracker._update(x,{}, {},'gm');
assert.equal(cur().events.length,3,'Soak refill is not a healing event');
x.system.attributes.vigor.value=5;tracker._update(x,{}, {},'gm');await tracker._flush('combat|Actor.X');
assert.equal(cur().events.length,4);assert.equal(cur().enemies.X.unattributedDamageTaken,7);
// Defeated counts as one kill for an explicitly confirmed recent attacker.
tracker.queueSource({sourceActor:b,targetActor:y,itemName:'Finishing Strike'});
y.system.attributes.vigor.value=0;tracker._update(y,{}, {},'gm');await tracker._flush(`combat|${y.uuid}`);
combat.combatants[4].defeated=true;
tracker._scheduleDefeat(y,combat,true);
await new Promise(resolve=>setTimeout(resolve,480));
assert.equal(cur().characters.B.kills,1,'confirmed defeat credits the attacker');
assert.equal(cur().enemies[y.uuid].timesDowned,1);
assert.equal(cur().defeated.length,1);
tracker._scheduleDefeat(y,combat,true);
await new Promise(resolve=>setTimeout(resolve,420));
assert.equal(cur().characters.B.kills,1,'repeat defeated event does not award another kill');
// Explicitly rejected source case: dead without source is recorded defeated, not randomly credited.
tracker._recentDamage.delete(z.uuid);tracker._scheduleDefeat(z,combat,true);await new Promise(resolve=>setTimeout(resolve,450));
assert.equal(cur().defeated.length,2);
assert.equal(cur().characters.C.kills,0,'stale or missing source must not earn a kill');
const event=cur().events.find(e=>e.type==='damage');await tracker.acceptEvent(event);
assert.equal(cur().events.filter(e=>e.eventId===event.eventId).length,1,'idempotent event IDs');
const msg={id:'M1',user:{id:'gm'},speaker:{actor:'A'},system:{targets:['T2']}};
game.messages.set(msg.id,msg);
tracker._socketMessage({type:'chatApplied',messageId:'M1',targetUuids:[y.uuid]},'gm');
assert.equal(tracker._claimSource(y)?.source.id,'A','GM-validated PF1e chat-card source context');
tracker._socketMessage({type:'chatApplied',messageId:'M1',targetUuids:[z.uuid]},'gm');
assert.equal(tracker._claimSource(z),null,'unlisted target is not attributed');
await tracker._finish(combat);
assert.equal(store.get('pf1e-combat-stats.combatHistory').length,1);
assert.equal(Object.keys(store.get('pf1e-combat-stats.combatHistory')[0].characters).length,3);
console.log('OK: party/enemy discovery, unlinked tokens, damage dealt/taken, soak, independent kills, deduplication, completed history');
