/** PF1e-native dashboard. No Combat Stats v4 table assumptions or CDN. */
import {exportToExcel} from './exporter.js';
import {ChartLite} from './vendor/chart-lite.js';
const MODULE_ID='pf1e-combat-stats';
const {ApplicationV2,HandlebarsApplicationMixin}=foundry.applications.api;
const number=x=>Number(x)||0;
const settings=key=>game.settings.get(MODULE_ID,key);
const clone=x=>foundry.utils.deepClone(x);
const stats=['damageDealt','damageTaken','kills','maxSingleHit','healingDone','overdamage','timesDowned'];
const tableKeys=['damageDealt','overdamage','damageTaken','excessDamageTaken','healingDone','overhealing','kills','maxSingleHit','timesDowned'];

export function chartFights(){
  const previous=settings('combatHistory')??[];
  const live=game.pf1eCombatStats?.getLiveRecord?.()??settings('currentCombatData')??{};
  if(!live.combatId || previous.some(x=>x.combatId===live.combatId))return previous;
  return [...previous,{...live,id:`live-${live.combatId}`,name:`${live.fightName??'Encounter'} (In Progress)`,date:live.startedAt,isLive:true}];
}
function rowsFor(fight,side){return Object.values(fight?.[side]??{}).map(x=>({...x,damageDealt:number(x.damageDealt),damageTaken:number(x.damageTaken),kills:number(x.kills),maxSingleHit:number(x.maxSingleHit),overdamage:number(x.overdamage),timesDowned:number(x.timesDowned)}));}
function aggregate(fights,side){
  const result=new Map();
  for(const fight of fights)for(const row of rowsFor(fight,side)){
    const key=row.actorUuid??row.uuid??row.id??row.name;
    const current=result.get(key)??{...row};
    if(result.has(key))for(const field of tableKeys)current[field]=field==='maxSingleHit'?Math.max(number(current[field]),number(row[field])):number(current[field])+number(row[field]);
    result.set(key,current);
  }
  return [...result.values()].sort((a,b)=>number(b.damageDealt)-number(a.damageDealt)||a.name.localeCompare(b.name));
}
export class ChartsApp extends HandlebarsApplicationMixin(ApplicationV2){
  constructor(options={}){super(options);this.tab='totals';this.fightId=null;this.metric='damageDealt';this.chart=null;this._bound=false;this._refreshTimer=null;this._fingerprint='';}
  static get DEFAULT_OPTIONS(){return foundry.utils.mergeObject(super.DEFAULT_OPTIONS,{id:'pf1e-combat-stats-dashboard',tag:'div',window:{title:'PF1e Combat Stats',icon:'fa-solid fa-chart-column',resizable:true},position:{width:1200,height:780}},{inplace:false});}
  static get PARTS(){return {main:{template:`modules/${MODULE_ID}/templates/pf1e-dashboard.hbs`}};}
  async _prepareContext(){
    const fights=chartFights();
    const selected=fights.find(f=>f.id===this.fightId)??fights.at(-1)??null;
    const show=this.tab==='fight' ? [selected].filter(Boolean) : fights;
    const chars=aggregate(show,'characters'),enemies=aggregate(show,'enemies');
    return {tabTotals:this.tab==='totals',tabEnemies:this.tab==='enemies',tabChart:this.tab==='chart',tabMeter:this.tab==='meter',tabFight:this.tab==='fight',
      chartsEnabled:settings('trackEnemies')!==false,
      fights:fights.map(f=>({id:f.id,name:f.name??f.fightName??'Encounter',selected:selected?.id===f.id,isLive:f.isLive})),
      selectedName:selected?.name??selected?.fightName??'No encounter',hasFights:fights.length>0,
      chars,enemies,party:rowsFor(selected,'characters'),hostiles:rowsFor(selected,'enemies'),
      partyTotal:this._sum(chars),enemyTotal:this._sum(enemies),partyFightTotal:this._sum(rowsFor(selected,'characters')),
      enemyFightTotal:this._sum(rowsFor(selected,'enemies')),
      metric:this.metric,metricDealt:this.metric==='damageDealt',metricTaken:this.metric==='damageTaken',metricKills:this.metric==='kills',metricMax:this.metric==='maxSingleHit',
      isGM:Boolean(game.user?.isGM),activeLabel:selected?.isLive?'Live encounter':'Completed encounter'};
  }
  _sum(rows){return {damageDealt:rows.reduce((s,r)=>s+number(r.damageDealt),0),damageTaken:rows.reduce((s,r)=>s+number(r.damageTaken),0),kills:rows.reduce((s,r)=>s+number(r.kills),0),maxSingleHit:Math.max(0,...rows.map(r=>number(r.maxSingleHit)))};}
  async _onRender(context,options){
    await super._onRender(context,options);
    if(!this._bound){
      this._bound=true;
      this.element.addEventListener('click',ev=>{
        const el=ev.target.closest?.('[data-tab], [data-fight], [data-metric], [data-action]');if(!el)return;
        ev.preventDefault();
        if(el.dataset.tab){this.tab=el.dataset.tab;this.render({parts:['main']});return;}
        if(el.dataset.fight){this.fightId=el.dataset.fight;this.tab='fight';this.render({parts:['main']});return;}
        if(el.dataset.metric){this.metric=el.dataset.metric;this.render({parts:['main']});return;}
        if(el.dataset.action==='refresh'){this.render({parts:['main']});return;}
        if(el.dataset.action==='export'){exportToExcel(settings('combatHistory')??[],'pf1e-combat-stats');return;}
        if(el.dataset.action==='delete'&&game.user?.isGM)this._deleteFight(el.dataset.id);
      });
    }
    if(this.tab==='chart')this._draw();
    this._fingerprint=this._liveFingerprint();
    if(!this._refreshTimer)this._refreshTimer=setInterval(()=>{
      if(!this.rendered)return;
      const current=this._liveFingerprint();
      if(current!==this._fingerprint){this._fingerprint=current;this.render({parts:['main']});}
    },850);
  }
  _liveFingerprint(){
    const c=game.pf1eCombatStats?.getLiveRecord?.()??settings('currentCombatData')??{};
    return `${c.combatId??''}:${Object.keys(c.characters??{}).length}:${Object.keys(c.enemies??{}).length}:${c.events?.length??0}:${c.defeated?.length??0}`;
  }
  async _onClose(options){clearInterval(this._refreshTimer);this._refreshTimer=null;await super._onClose(options);}
  async _deleteFight(id){
    const history=settings('combatHistory')??[];
    const ok=await foundry.applications.api.DialogV2.confirm({window:{title:'Delete encounter'},content:'Delete this completed encounter from statistics? This cannot be undone.'});
    if(ok){await game.settings.set(MODULE_ID,'combatHistory',history.filter(f=>f.id!==id));this.fightId=null;this.render({parts:['main']});}
  }
  _draw(){
    const canvas=this.element.querySelector('#pf1cs-chart');if(!canvas)return;
    const fights=chartFights();
    const selected=fights.find(f=>f.id===this.fightId)??fights.at(-1);
    const rows=[...rowsFor(selected,'characters'),...rowsFor(selected,'enemies')];
    if(this.chart){this.chart.destroy();this.chart=null;}
    if(!rows.length)return;
    const palette=['#e5b54e','#e45a42','#62aeed','#72c892','#b68ce6','#f09a5d'];
    this.chart=new ChartLite(canvas.getContext('2d'),{type:'bar',data:{labels:rows.map(r=>r.name),datasets:[{label:this.metric,backgroundColor:rows.map((r,i)=>palette[i%palette.length]),data:rows.map(r=>number(r[this.metric]))}]},options:{}});
  }
}
