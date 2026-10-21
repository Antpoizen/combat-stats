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
assert.equal(tracker._combat(z),null,'token enemy not in initiative must be ignored');
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
// A v13 synthetic token delta may be surfaced through updateToken only.
tracker.queueSource({sourceActor:b,targetActor:y,itemName:'Shield Bash'});
y.flags['armor-soak-pool'].current=5;
const tokenUpdate=tracker._observeToken.bind(tracker);
tokenUpdate({actor:y},{delta:{flags:{'armor-soak-pool':{current:5}}}},{},'gm');
await tracker._flush(`combat|${y.uuid}`);
assert.equal(cur().characters.B.damageDealt,8,'token-delta Soak loss is captured');
assert.equal(cur().enemies[y.uuid].soakTaken,3);
// Second observation with identical post-state must not duplicate damage.
tokenUpdate({actor:y},{delta:{flags:{'armor-soak-pool':{current:5}}}},{},'gm');
await tracker._flush(`combat|${y.uuid}`);
assert.equal(cur().characters.B.damageDealt,8,'duplicate token observation ignored');
// Off-initiative enemy damage must not be recorded or attributed.
assert.equal(tracker.queueSource({sourceActor:c,targetActor:z,itemName:'Hex'}),false);
z.system.attributes.vigor.value=11;tracker._update(z,{}, {},'gm');
await tracker._flush(`combat|${z.uuid}`);
assert.equal(cur().characters.C.damageDealt,0);
assert.equal(cur().enemies[z.uuid],undefined);
// A character enrolled in initiative still receives credit against enrolled enemies.
tracker.queueSource({sourceActor:c,targetActor:x,itemName:'Hex'});
x.system.attributes.vigor.value=5;tracker._update(x,{}, {},'gm');
await tracker._flush('combat|Actor.X');
assert.equal(cur().characters.C.damageDealt,7);
// With no explicit source, damage taken still recorded, but not credited to a random PC.
x.flags['armor-soak-pool'].current=12;tracker._update(x,{}, {},'gm');
assert.equal(cur().events.length,4,'Soak refill is not a healing event');
x.system.attributes.vigor.value=2;tracker._update(x,{}, {},'gm');await tracker._flush('combat|Actor.X');
assert.equal(cur().events.length,5);assert.equal(cur().enemies.X.unattributedDamageTaken,3);
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
assert.equal(cur().defeated.length,1,'off-initiative defeated actors are ignored');
assert.equal(cur().characters.C.kills,0,'stale or missing source must not earn a kill');
const inactive=resourceDelta({hp:100,vigor:0,wounds:0,soak:null},{hp:69,vigor:0,wounds:0,soak:null});
assert.equal(inactive.hpDamage,31,'NPC hit points count even when dormant Wounds/Vigor paths exist');
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
// Regression from live October 21 combat: two PCs, two initiative Bloodlings.
combat.id='daleira-tangra-regression';
combat.name='Two PCs vs Two Bloodlings';
combat.combatants=[{actor:a,actorId:a.id},{actor:b,actorId:b.id},
  {actor:x,actorId:x.id},{actor:y,actorId:y.id,tokenId:'T2',sceneId:'scene',defeated:false}];
a.name='Daleira';b.name='Tangra';x.name='Bloodling';y.name='Bloodling';
a.system.attributes.vigor.value=100;
b.system.attributes.vigor.value=100;
for(const enemy of [x,y]) { enemy.system.attributes.vigor.value=0;enemy.system.attributes.wounds.value=0;enemy.system.attributes.hp.value=150; }
x.flags['armor-soak-pool'].current=0;
y.flags['armor-soak-pool'].current=70;
tracker._snapshot.clear(); tracker._sourceContext.clear();tracker._recentDamage.clear();tracker._pending.clear();
tracker.refreshSnapshots();await tracker._begin(combat);
assert.equal(Object.keys(cur().characters).length,2,'Daleira and Tangra appear before attacking');
assert.equal(Object.keys(cur().enemies).length,2,'both initiative Bloodlings appear before damage');
tracker.queueSource({sourceActor:x,targetActor:a,itemName:'Bloodling Claws'});
a.system.attributes.vigor.value=61;tracker._update(a,{}, {},'gm');await tracker._flush(`daleira-tangra-regression|${a.uuid}`);
tracker.queueSource({sourceActor:a,targetActor:x,itemName:'Daleira sword'});
x.system.attributes.hp.value=119;tracker._update(x,{}, {},'gm');await tracker._flush(`daleira-tangra-regression|${x.uuid}`);
tracker.queueSource({sourceActor:b,targetActor:x,itemName:'Tangra sword'});
x.system.attributes.hp.value=25;tracker._update(x,{}, {},'gm');await tracker._flush(`daleira-tangra-regression|${x.uuid}`);
tracker.queueSource({sourceActor:b,targetActor:y,itemName:'Tangra second attack'});
y.flags['armor-soak-pool'].current=37;tracker._observeToken({actor:y},{delta:{flags:{'armor-soak-pool':{current:37}}}},{},'gm');
await tracker._flush(`daleira-tangra-regression|${y.uuid}`);
combat.combatants[2].defeated=true;tracker._scheduleDefeat(x,combat,true);
await new Promise(resolve=>setTimeout(resolve,450));
assert.equal(cur().characters.A.damageDealt,31);
assert.equal(cur().characters.A.damageTaken,39);
assert.equal(cur().characters.B.damageDealt,127);
assert.equal(cur().characters.B.kills,1);
assert.equal(cur().enemies.X.damageTaken,125);
assert.equal(cur().enemies[y.uuid].damageTaken,33);
assert.equal(cur().enemies.X.damageDealt,39);
assert.equal(Object.keys(cur().enemies).length,2,'off-initiative actors excluded');
await tracker._finish(combat);
assert.equal(store.get('pf1e-combat-stats.combatHistory').length,2);
console.log('OK: 2 PCs + 2 Bloodlings: Daleira 31/39, Tangra 127 dealt + 1 kill, enemies 125 HP / 33 Soak');

console.log('OK: initiative-only registration, unlinked tokens, applied HP/Vigor/Soak, attribution, kills, deduplication, persistence');
