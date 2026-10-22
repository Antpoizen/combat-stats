/** PF1e Combat Stats -- presentation port from Combat Stats v4 by Smantella (CC BY-SA 4.0) */
import { CombatTracker } from './tracker.js';
import { ChartsApp } from './charts.js';
import { CombatStatsSettings } from './settings-menu.js';

export const MODULE_ID='pf1e-combat-stats';
export const SETTING_CURRENT='currentCombatData';
export const SETTING_HISTORY='combatHistory';
export const SETTING_HISTORY_BACKUP='combatHistoryBackup';
export const COLOR_DEFAULTS={accent:'#d4af37',bg:'#1a1a24',bgRow:'#252530',dealt:'#ff2020',taken:'#52a8e0',healed:'#2ecc71',text:'#eeeeee',bigHit:'#ff6a00',overkill:'#cc2200',excessTaken:'#a855f7',overhealing:'#1abc9c',maxSingleHit:'#ff4500',maxSingleHeal:'#27ae60',timesDowned:'#e8e8e8'};
const FormBase=globalThis.FormApplication ?? foundry.appv1.api.FormApplication;

class TrackedStatsDialog extends FormBase {
  static get defaultOptions(){return foundry.utils.mergeObject(super.defaultOptions,{id:'pf1cs-tracked-stats',title:'PF1e Combat Stats — Tracked Statistics',template:`modules/${MODULE_ID}/templates/tracked-stats.hbs`,width:400,height:'auto',classes:['combat-stats','cs-settings-window']});}
  getData(){ const g=k=>game.settings.get(MODULE_ID,k);return {
    isMidi:false,trackKills:g('trackKills'),trackDamageDealt:g('trackDamageDealt'),trackOverdamage:g('trackOverdamage'),trackDamageTaken:g('trackDamageTaken'),trackExcessDamageTaken:g('trackExcessDamageTaken'),trackHealingDone:g('trackHealingDone'),trackOverhealing:g('trackOverhealing'),trackMaxSingleHeal:g('trackMaxSingleHeal'),trackTimesDowned:g('trackTimesDowned'),chatShowKills:g('chatShowKills'),chatShowDamageDealt:g('chatShowDamageDealt'),chatShowDamageTaken:g('chatShowDamageTaken'),chatShowHealingDone:g('chatShowHealingDone')};}
  async _updateObject(event,data){for(const [k,v] of Object.entries(data)) if(game.settings.settings.has(`${MODULE_ID}.${k}`)) await game.settings.set(MODULE_ID,k,v);}
}
const add=(k,value,scope='world',config=false,rest={})=>game.settings.register(MODULE_ID,k,{name:k,scope,config,type:typeof value==='boolean'?Boolean:typeof value==='string'?String:typeof value==='number'?Number:Array.isArray(value)?Array:Object,default:value,...rest});
Hooks.once('init',()=>{
  add(SETTING_CURRENT,{});add(SETTING_HISTORY,[]);add(SETTING_HISTORY_BACKUP,null,'world',false,{type:Object});
  for(const k of ['trackKills','trackDamageDealt','trackOverdamage','trackDamageTaken','trackExcessDamageTaken','trackHealingDone','trackOverhealing','trackMaxSingleHeal','trackTimesDowned','chatShowKills','chatShowDamageDealt','chatShowDamageTaken','chatShowHealingDone']) add(k,true);
  for(const [name,col] of Object.entries({colorAccent:COLOR_DEFAULTS.accent,colorBg:COLOR_DEFAULTS.bg,colorBgRow:COLOR_DEFAULTS.bgRow,colorDealt:COLOR_DEFAULTS.dealt,colorTaken:COLOR_DEFAULTS.taken,colorHealed:COLOR_DEFAULTS.healed,colorText:COLOR_DEFAULTS.text,colorOverkill:COLOR_DEFAULTS.overkill,colorExcessTaken:COLOR_DEFAULTS.excessTaken,colorOverhealing:COLOR_DEFAULTS.overhealing,colorMaxSingleHit:COLOR_DEFAULTS.maxSingleHit,colorMaxSingleHeal:COLOR_DEFAULTS.maxSingleHeal,colorTimesDowned:COLOR_DEFAULTS.timesDowned})) add(name,col,'world',false,{onChange:applyTheme});
  add('bigHitColor',COLOR_DEFAULTS.bigHit);add('bigHitMessage','');
  add('trackerMode','pf1e','world',true,{name:'Tracking source',hint:'Observes completed PF1e actor resource changes; never uses Midi-QOL or applies damage.',choices:{pf1e:'PF1e Applied Resource Changes'}});
  add('enabled',true,'world',true,{name:'Enable tracking'});
  add('playersCanViewCharts',false,'world',true,{name:'Players may open charts'});
  add('summaryEnabled',true,'world',true,{name:'Post end-of-combat summary'});
  add('nameDisplay','full','world',true,{name:'Display names',choices:{full:'Full',firstname:'First name',lastname:'Last name',username:'Foundry user'}});
  add('trackEnemies',true,'world',true,{name:'Track enemy stats'});
  add('attributeSummons',false,'world',true,{name:'Attempt summon attribution',hint:'Only explicit attribution is used automatically. This toggle is reserved for future verified adapters.'});
  add('askSummonAttribution',false);
  add('aoeCountsAsOne',false,'world',true,{name:'Count AoE as one hit',hint:'Requires explicit shared workflow IDs; no approximate grouping of independent attacks.'});
  add('bigHitThreshold',30,'world',true,{name:'Big-hit achievement threshold',range:{min:0,max:9999,step:1}});
  add('chatMessageActorId','','world',true,{name:'Summary sender Actor ID'});
  add('includeSoakInTotal',true,'world',true,{name:'Include Soak absorption in damage dealt'});
  add('strictHealing',true,'world',true,{name:'Only count healing with a verified source',hint:'Resource increases without an explicit healer stay uncredited. Soak refill is never healing.'});
  add('vigorPath','system.attributes.vigor.value','world',true,{name:'Vigor resource path'});
  add('woundsPath','system.attributes.wounds.value','world',true,{name:'Wounds resource path'});
  add('hpPath','system.attributes.hp.value','world',true,{name:'HP fallback path'});
  add('turnAttributionFallback',true,'world',true,{name:'Use current initiative turn when attacker is not otherwise identified',hint:'Marks damage as INFERRED; reactions and delayed effects can be misattributed. Disable for strictly verified statistics.'});
  add('chatCardAttribution',true,'world',true,{name:'Attribute damage from explicit PF1e chat-card Apply actions',hint:'Only when a chat card identifies its actor and the affected token documents. Does not infer damage from targeting alone.'});
  add('defeatedCountsAsKill',true,'world',true,{name:'Count defeated combatants as kills',hint:'Credit a kill to the most recent explicitly attributed attacker. Disable if Defeated means unconscious rather than killed in your campaign.'});
  add('debug',false,'world',true,{name:'Diagnostic logging'});
  game.settings.registerMenu(MODULE_ID,'trackedStatsMenu',{name:'Tracked statistics',label:'Configure',icon:'fa-solid fa-list-check',type:TrackedStatsDialog,restricted:true});
  game.settings.registerMenu(MODULE_ID,'themeMenu',{name:'Theme & Data',label:'Configure',icon:'fa-solid fa-palette',type:CombatStatsSettings,restricted:true});
});
Hooks.once('ready',()=>{
  applyTheme();
  if(game.system.id!=='pf1'){ui.notifications.error('PF1e Combat Stats requires PF1e.');return;}
  const t=new CombatTracker();game.pf1eCombatStats=t;
  game.modules.get(MODULE_ID).api={tracker:t,openCharts:()=>new ChartsApp().render(true),queueSource:options=>t.queueSource(options),recordEvent:ev=>t.acceptEvent(ev),recordManual:opts=>t.manualEvent(opts),getHistory:()=>game.settings.get(MODULE_ID,SETTING_HISTORY),getDiagnostics:()=>t.diagnostics(),openManualDialog:openManualEventDialog};
  t.init();
  if(game.user.isGM && !game.modules.get('nevelas-automation-suite')?.active) console.info(`${MODULE_ID}: Nevela is inactive. Raw PF1e health changes can still be observed.`);
});
Hooks.on('getSceneControlButtons',controls=>{
  if(!game.user.isGM && !game.settings.get(MODULE_ID,'playersCanViewCharts')) return;
  // Foundry 13.351 scene controls: object keyed by control id.
  const tool={name:'pf1e-combat-stats',title:'PF1e Combat Stats',icon:'fa-solid fa-chart-column',visible:true,tools:{charts:{name:'charts',title:'Open Combat Stats',icon:'fa-solid fa-chart-simple',button:true,onClick:()=>new ChartsApp().render(true)},manual:{name:'manual',title:'Record verified event',icon:'fa-solid fa-pen',button:true,visible:game.user.isGM,onClick:()=>openManualEventDialog()}}};
  if(Array.isArray(controls)) controls.push(tool);else controls['pf1e-combat-stats']=tool;
});
export function applyTheme(){if(!globalThis.document) return;const root=document.documentElement; const entries={colorAccent:'--cs-accent',colorBg:'--cs-bg',colorBgRow:'--cs-bg-row',colorDealt:'--cs-dealt',colorTaken:'--cs-taken',colorHealed:'--cs-healed',colorText:'--cs-text',colorOverkill:'--cs-overkill',colorExcessTaken:'--cs-excess-taken',colorOverhealing:'--cs-overhealing',colorMaxSingleHit:'--cs-maxhit',colorMaxSingleHeal:'--cs-maxheal',colorTimesDowned:'--cs-downed'};
  for(const [key,v] of Object.entries(entries)){try{root.style.setProperty(v,game.settings.get(MODULE_ID,key));}catch{}}
}

/** GM-only manual attribution tool; never changes actual actor HP. */
export async function openManualEventDialog(){
  if(!game.user?.isGM){ui.notifications.warn(game.i18n.localize('PF1CS.Warning.GmOnly'));return;}
  if(!game.combat?.started){ui.notifications.warn(game.i18n.localize('PF1CS.Warning.NoCombat'));return;}
  const roster=[...(game.combat?.combatants??[])].map(c=>c.actor).filter(Boolean);
  const actors=[...new Map(roster.filter(a=>a && (a.type==='character'||a.type==='npc')).map(a=>[a.uuid,a])).values()];
  const esc=v=>foundry.utils.escapeHTML(String(v??''));
  const opts=(empty=false)=>`${empty?'<option value="">— Unattributed —</option>':''}${actors.map(a=>`<option value="${esc(a.uuid)}">${esc(a.name)}</option>`).join('')}`;
  const content=`<div class="pf1e-combat-stats"><div class="form-group"><label>Source actor</label><select name="source">${opts(true)}</select></div><div class="form-group"><label>Target</label><select name="target">${opts()}</select></div><div class="form-group"><label>Event</label><select name="kind"><option value="damage">Damage</option><option value="healing">Healing</option></select></div><div class="form-group"><label>Resource</label><select name="resource"><option value="soak">Soak</option><option value="vigor" selected>Vigor</option><option value="wounds">Wounds</option><option value="hp">HP</option></select></div><div class="form-group"><label>Amount</label><input name="amount" type="number" min="1" step="1" value="1"/></div><div class="form-group"><label>Item/ability</label><input name="itemName" type="text" value="Manual attribution" /></div><p>This records a statistics event only. It never applies damage or healing to an actor.</p></div>`;
  const Dialog=foundry.applications.api.DialogV2;
  await Dialog.wait({window:{title:'PF1e Combat Stats — Record Verified Event'},content,buttons:[{action:'record',label:'Record event',default:true,callback:(event,button,dialog)=>{
    const form=button.form;
    const value=k=>form.elements.namedItem(k)?.value;
    return game.pf1eCombatStats?.manualEvent({sourceActor:value('source'),targetActor:value('target'),kind:value('kind'),resource:value('resource'),amount:Number(value('amount')),itemName:value('itemName')});
  }},{action:'cancel',label:'Cancel'}]});
}
