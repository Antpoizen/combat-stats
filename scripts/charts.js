/**
 * ChartsApp v2.0.0
 * - Supporto completo a 3 tab (Totals, History Chart, Single Fight)
 * - nameDisplay, colori dei giocatori ed esportazione Excel
 * - Chart.js da CDN caricato in modo dinamico e asincrono
 */

import { exportToExcel } from "./exporter.js";
import { ChartLite } from "./vendor/chart-lite.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const MODULE_ID   = "pf1e-combat-stats";
const S_HISTORY   = "combatHistory";
const S_HISTORY_BACKUP = "combatHistoryBackup";
// Include the active encounter as an in-memory display-only fight. Previously
// Charts rendered combatHistory alone, so initiative combatants (including
// zero-action actors) remained invisible until the fight was deleted.
export function chartFights() {
  const archived=game.settings.get(MODULE_ID,S_HISTORY)??[];
  const current=game.settings.get(MODULE_ID,'currentCombatData')??{};
  if(!current.combatId) return archived;
  const count=Object.keys(current.characters??{}).length+Object.keys(current.enemies??{}).length;
  if(!count || archived.some(f=>f.combatId===current.combatId)) return archived;
  return [...archived,{...current,id:`live-${current.combatId}`,
    name:`${current.fightName??'Combat'} (In Progress)`,date:current.startedAt,isLive:true}];
}
const UNDO_CLEAR_TTL_MS = 60000;
// Bundled local canvas fallback. Do not require an online Chart.js CDN.
const Chart = ChartLite;
async function ensureChartJs() { return; }

function buildPlayerColourMap() {
  const map = {};
  for (const user of game.users ?? []) {
    const actor = user.character;
    if (!actor) continue;
    const col = user.color?.css ?? user.color ?? null;
    if (col) { map[actor.id] = col; map[actor.name] = col; }
  }
  return map;
}

function resolveDisplayName(actorId, actorName, mode) {
  if (mode === "username") {
    const u = game.users?.find(usr => usr.character?.id === actorId);
    if (u) return u.name ?? actorName;
  }
  if (mode === "firstname") return actorName.split(" ")[0];
  if (mode === "lastname")  { const p = actorName.split(" "); return p[p.length - 1]; }
  return actorName;
}

// Palette ciclica per colorare le barre del "damage meter" quando non c'è
// un colore giocatore da riusare — stile Warcraft Logs: una tinta per riga,
// non legata a un personaggio specifico.
const ABILITY_PALETTE = [
  "#d4af37", "#ff2020", "#52a8e0", "#2ecc71", "#a855f7",
  "#ff8c00", "#1abc9c", "#e84393", "#4682b4", "#c0392b"
];

// Le prime 3 righe (danno più alto) prendono sempre oro/argento/bronzo,
// dalla 4a in poi si torna alla palette ciclica.
const MEDAL_COLORS = ["#e6c34a", "#c7ccd1", "#cd7f32"];

// Costruisce il "damage meter" per-abilità di un personaggio: una riga per
// abilità, ordinata per danno totale decrescente, con lunghezza della barra
// proporzionale alla riga più alta (stile Warcraft Logs), invece della
// vecchia tabella con una colonna per scontro.
function buildAbilityTable(actorId, history, nameDisplay, userColors) {
  if (!actorId) return null;

  let rawName = actorId;
  for (const fight of history) {
    if (fight.characters?.[actorId]) { rawName = fight.characters[actorId].name; break; }
  }
  const displayName = resolveDisplayName(actorId, rawName, nameDisplay);
  const color = userColors[actorId] ?? null;

  const abilityKeys = new Set();
  for (const fight of history) {
    const abilities = fight.characters?.[actorId]?.abilities ?? {};
    for (const key of Object.keys(abilities)) abilityKeys.add(key);
  }

  const rows = [];
  let grandTotal = 0;
  for (const key of abilityKeys) {
    let total = 0, hits = 0, max = 0;
    for (const fight of history) {
      const ab = fight.characters?.[actorId]?.abilities?.[key];
      total += Number(ab?.damageDealt) || 0;
      hits  += Number(ab?.hits) || 0;
      max    = Math.max(max, Number(ab?.maxHit) || 0);
    }
    grandTotal += total;
    rows.push({
      ability: key,
      total,
      hits,
      avg: hits > 0 ? Math.round(total / hits) : 0,
      max
    });
  }
  rows.sort((a, b) => b.total - a.total);

  const topTotal = rows[0]?.total || 1;
  rows.forEach((row, i) => {
    row.pct = Math.round((row.total / topTotal) * 100);
    row.sharePct = grandTotal > 0 ? Math.round((row.total / grandTotal) * 100) : 0;
    row.color = MEDAL_COLORS[i] ?? ABILITY_PALETTE[i % ABILITY_PALETTE.length];
  });

  return { displayName, color, rows };
}

export class ChartsApp extends HandlebarsApplicationMixin(ApplicationV2) {

  constructor(options = {}) {
    super(options);
    
    // Inizializzazione dello stato interno dei tab e del grafico
    this._activeTab = "totals";       // tab correntemente attivo ('totals', 'history', 'fight')
    this._selectedFightId = null;     // ID del singolo scontro aperto
    this._metric = "dealt";           // metrica del grafico ('dealt', 'over', 'taken', ecc.)
    this._chartType = "bar";          // tipo di grafico ('bar', 'doughnut')
    this._chart = null;
    this._abilityChars = new Set();   // ID personaggi selezionati nel tab Abilities (N-way compare)
  }

  static get DEFAULT_OPTIONS() {
    return foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
      id: "combat-stats-charts",
      tag: "form",
      window: {
        title: "Combat Stats — Analysis & Charts",
        icon: "fa-solid fa-chart-simple",
        resizable: true
      },
      position: { width: 1150, height: 700 },
      form: { closeOnSubmit: false }
    }, { inplace: false }); 
  }

  static get PARTS() {
    return {
      main: { template: "modules/pf1e-combat-stats/templates/charts.hbs" }
    };
  }

  async _prepareContext(options) {
    const history = chartFights();
    const isGM = game.user.isGM;
    const g = k => { try { return game.settings.get(MODULE_ID, k); } catch { return null; } };
    const nameDisplay = g("nameDisplay") ?? "full";
    const userColors = buildPlayerColourMap();

    // Impostazioni di tracciamento abilitate o disabilitate
    const show = {
      overdamage:        g("trackOverdamage")        !== false,
      excessDamageTaken: g("trackExcessDamageTaken") !== false,
      overhealing:       g("trackOverhealing")       !== false,
    };

    // 1. Calcolo Totali Globali (Tab Totals)
    const totalsMap = {};
    const grandTotal = {
      damageDealt: 0, overdamage: 0, damageTaken: 0, excessDamageTaken: 0,
      healingDone: 0, overhealing: 0, kills: 0, timesDowned: 0
    };

    for (const fight of history) {
      for (const [actorId, char] of Object.entries(fight.characters ?? {})) {
        if (!totalsMap[actorId]) {
          totalsMap[actorId] = {
            id: actorId,
            rawName: char.name,
            displayName: resolveDisplayName(actorId, char.name, nameDisplay),
            playerColor: userColors[actorId] ?? null,
            damageDealt: 0, overdamage: 0, damageTaken: 0, excessDamageTaken: 0,
            healingDone: 0, overhealing: 0, kills: 0, maxSingleHit: 0, maxSingleHeal: 0, timesDowned: 0
          };
        }
        const t = totalsMap[actorId];
        t.damageDealt       += Number(char.damageDealt) || 0;
        t.overdamage        += Number(char.overdamage) || 0;
        t.damageTaken       += Number(char.damageTaken) || 0;
        t.excessDamageTaken += Number(char.excessDamageTaken) || 0;
        t.healingDone       += Number(char.healingDone) || 0;
        t.overhealing       += Number(char.overhealing) || 0;
        t.kills             += Number(char.kills) || 0;
        t.timesDowned       += Number(char.timesDowned) || 0;
        t.maxSingleHit       = Math.max(t.maxSingleHit, Number(char.maxSingleHit) || 0);
        t.maxSingleHeal      = Math.max(t.maxSingleHeal, Number(char.maxSingleHeal) || 0);
      }
    }

    // Calcolo della riga del totale complessivo (Footer)
    for (const char of Object.values(totalsMap)) {
      grandTotal.damageDealt       += char.damageDealt;
      grandTotal.overdamage        += char.overdamage;
      grandTotal.damageTaken       += char.damageTaken;
      grandTotal.excessDamageTaken += char.excessDamageTaken;
      grandTotal.healingDone       += char.healingDone;
      grandTotal.overhealing       += char.overhealing;
      grandTotal.kills             += char.kills;
      grandTotal.timesDowned       += char.timesDowned;
    }

    // 1b. Nemici — solo se l'opzione è attiva, e solo per la finestra Charts
    // (mai nella chat card, gestita separatamente da summary.js).
    const enemiesEnabled = g("trackEnemies") ?? false;
    const enemyTotalsMap = {};
    for (const fight of history) {
      for (const [actorId, mob] of Object.entries(fight.enemies ?? {})) {
        if (!enemyTotalsMap[actorId]) {
          enemyTotalsMap[actorId] = {
            id: actorId, name: mob.name,
            damageDealt: 0, overdamage: 0, damageTaken: 0, excessDamageTaken: 0,
            healingDone: 0, overhealing: 0, kills: 0, maxSingleHit: 0, maxSingleHeal: 0
          };
        }
        const e = enemyTotalsMap[actorId];
        e.damageDealt       += Number(mob.damageDealt) || 0;
        e.overdamage         += Number(mob.overdamage) || 0;
        e.damageTaken        += Number(mob.damageTaken) || 0;
        e.excessDamageTaken += Number(mob.excessDamageTaken) || 0;
        e.healingDone        += Number(mob.healingDone) || 0;
        e.overhealing        += Number(mob.overhealing) || 0;
        e.kills               += Number(mob.kills) || 0;
        e.maxSingleHit  = Math.max(e.maxSingleHit, Number(mob.maxSingleHit) || 0);
        e.maxSingleHeal = Math.max(e.maxSingleHeal, Number(mob.maxSingleHeal) || 0);
      }
    }
    const enemyTotals = Object.values(enemyTotalsMap).sort((a, b) => b.damageDealt - a.damageDealt);
    const enemyGrandTotal = enemyTotals.reduce((a, e) => {
      a.damageDealt       += e.damageDealt;
      a.overdamage         += e.overdamage;
      a.damageTaken        += e.damageTaken;
      a.excessDamageTaken += e.excessDamageTaken;
      a.healingDone        += e.healingDone;
      a.overhealing        += e.overhealing;
      a.kills               += e.kills;
      return a;
    }, { damageDealt: 0, overdamage: 0, damageTaken: 0, excessDamageTaken: 0, healingDone: 0, overhealing: 0, kills: 0 });

    // 2. Tab Scontro Singolo (Tab Fight)
    let selectedFight = null;
    let fightChars = [];
    let fightTotal = {
      damageDealt: 0, overdamage: 0, damageTaken: 0, excessDamageTaken: 0,
      healingDone: 0, overhealing: 0, kills: 0, timesDowned: 0
    };
    let fightDefeated = [];
    let formattedDate = "";
    let fightEnemies = [];
    let fightEnemyTotal = { damageDealt: 0, overdamage: 0, damageTaken: 0, excessDamageTaken: 0, healingDone: 0, overhealing: 0, kills: 0 };

    if (this._selectedFightId) {
      selectedFight = history.find(f => f.id === this._selectedFightId);
      if (selectedFight) {
        formattedDate = selectedFight.date ? new Date(selectedFight.date).toLocaleString() : "";
        fightDefeated = selectedFight.defeated ?? [];

        for (const [actorId, mob] of Object.entries(selectedFight.enemies ?? {})) {
          const e = {
            name:              mob.name,
            damageDealt:       Number(mob.damageDealt)       || 0,
            overdamage:        Number(mob.overdamage)        || 0,
            damageTaken:       Number(mob.damageTaken)       || 0,
            excessDamageTaken: Number(mob.excessDamageTaken) || 0,
            healingDone:       Number(mob.healingDone)       || 0,
            overhealing:       Number(mob.overhealing)       || 0,
            kills:             Number(mob.kills)             || 0,
            maxSingleHit:      Number(mob.maxSingleHit)      || 0,
            maxSingleHeal:     Number(mob.maxSingleHeal)     || 0
          };
          fightEnemies.push(e);
          fightEnemyTotal.damageDealt       += e.damageDealt;
          fightEnemyTotal.overdamage         += e.overdamage;
          fightEnemyTotal.damageTaken        += e.damageTaken;
          fightEnemyTotal.excessDamageTaken += e.excessDamageTaken;
          fightEnemyTotal.healingDone        += e.healingDone;
          fightEnemyTotal.overhealing        += e.overhealing;
          fightEnemyTotal.kills               += e.kills;
        }
        fightEnemies.sort((a, b) => b.damageDealt - a.damageDealt);

        for (const [actorId, char] of Object.entries(selectedFight.characters ?? {})) {
          const charData = {
            displayName: resolveDisplayName(actorId, char.name, nameDisplay),
            playerColor: userColors[actorId] ?? null,
            damageDealt: Number(char.damageDealt) || 0,
            overdamage: Number(char.overdamage) || 0,
            damageTaken: Number(char.damageTaken) || 0,
            excessDamageTaken: Number(char.excessDamageTaken) || 0,
            healingDone: Number(char.healingDone) || 0,
            overhealing: Number(char.overhealing) || 0,
            kills: Number(char.kills) || 0,
            maxSingleHit: Number(char.maxSingleHit) || 0,
            maxSingleHeal: Number(char.maxSingleHeal) || 0,
            timesDowned: Number(char.timesDowned) || 0
          };
          fightChars.push(charData);

          fightTotal.damageDealt       += charData.damageDealt;
          fightTotal.overdamage        += charData.overdamage;
          fightTotal.damageTaken       += charData.damageTaken;
          fightTotal.excessDamageTaken += charData.excessDamageTaken;
          fightTotal.healingDone       += charData.healingDone;
          fightTotal.overhealing       += charData.overhealing;
          fightTotal.kills             += charData.kills;
          fightTotal.timesDowned       += charData.timesDowned;
        }
      }
    }

    // 3. Tab Abilities (dettaglio danno per abilità, WoW-raid-log style)
    // Selezione multipla: un chip per personaggio, click per attivare/
    // disattivare, un blocco "damage meter" per ogni personaggio selezionato.
    const abilityIds = new Set();
    for (const fight of history) for (const id of Object.keys(fight.characters ?? {})) abilityIds.add(id);
    // Un personaggio uscito dalla history (es. cronologia cancellata) non
    // deve restare "fantasma" selezionato: ripuliamo lo stato ad ogni render.
    for (const id of this._abilityChars) if (!abilityIds.has(id)) this._abilityChars.delete(id);

    const abilityCharacters = Array.from(abilityIds).map(id => {
      let rawName = id;
      for (const fight of history) {
        if (fight.characters?.[id]) { rawName = fight.characters[id].name; break; }
      }
      return {
        id,
        name: resolveDisplayName(id, rawName, nameDisplay),
        selected: this._abilityChars.has(id)
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const abilityTables = Array.from(this._abilityChars)
      .map(id => buildAbilityTable(id, history, nameDisplay, userColors))
      .filter(Boolean);

    const historyBackup = game.settings.get(MODULE_ID, S_HISTORY_BACKUP);
    const canUndoClear = !!(historyBackup && Date.now() < historyBackup.expiresAt);

    return {
      tab: this._activeTab,
      history,
      hasData: history.length > 0,
      canUndoClear,
      totals: Object.values(totalsMap),
      grandTotal,
      selectedFight,
      fightChars,
      fightTotal,
      fightDefeated,
      enemiesEnabled,
      enemyTotals,
      enemyGrandTotal,
      hasEnemyData: enemyTotals.length > 0,
      fightEnemies,
      fightEnemyTotal,
      hasFightEnemyData: fightEnemies.length > 0,
      date: formattedDate,
      metric: this._metric,
      chartType: this._chartType,
      isBar: this._chartType === "bar",
      isDoughnut: this._chartType === "doughnut",
      isTrend: this._chartType === "trend",
      abilityCharacters,
      abilityTables,
      show,
      isGM
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    // Se siamo nel tab 'history' che deve mostrare il grafico, lo renderizziamo
    if (this._activeTab === "history") {
      await ensureChartJs();
      // Piccolo timeout per consentire al browser di calcolare le dimensioni del canvas
      setTimeout(() => this._renderChart(), 50);
    }
  }

  _renderChart() {
    const canvas = this.element.querySelector("#cs-chart-canvas");
    if (!canvas) return;

    if (this._chart) { 
      this._chart.destroy(); 
      this._chart = null; 
    }

    const history = chartFights();
    const g = k => { try { return game.settings.get(MODULE_ID, k); } catch { return null; } };
    const nameDisplay = g("nameDisplay") ?? "full";

    const themeColors = {
      accent:            g("colorAccent")        ?? "#d4af37",
      dealt:             g("colorDealt")         ?? "#ff2020",
      taken:             g("colorTaken")         ?? "#52a8e0",
      healed:            g("colorHealed")        ?? "#2ecc71",
      over:              g("colorOverkill")      ?? "#cc2200",
      overheal:          g("colorOverhealing")   ?? "#1abc9c",
      excess:            g("colorExcessTaken")   ?? "#a855f7",
      kills:             g("colorAccent")        ?? "#d4af37",
      maxhit:            g("colorMaxSingleHit")  ?? "#ff4500",
      maxheal:           g("colorMaxSingleHeal") ?? "#1abc9c",
      downed:            "#e8e8e8",
      text:              g("colorText")          ?? "#eeeeee"
    };

    // Mappatura delle metriche per corrispondere ai chiavi salvate negli attori
    const metricKeyMap = {
      dealt: "damageDealt",
      over: "overdamage",
      taken: "damageTaken",
      excess: "excessDamageTaken",
      healed: "healingDone",
      overheal: "overhealing",
      kills: "kills",
      maxhit: "maxSingleHit",
      maxheal: "maxSingleHeal",
      downed: "timesDowned"
    };

    const metric = this._metric;
    const dbKey = metricKeyMap[metric] ?? "damageDealt";
    const isMax = metric === "maxhit" || metric === "maxheal";
    const userColors = buildPlayerColourMap();
    const rootStyle = getComputedStyle(document.documentElement);
    const textColor = rootStyle.getPropertyValue("--cs-text")?.trim() || themeColors.text;

    // ── Trend: andamento della metrica scontro per scontro, una linea per
    // personaggio. Se un personaggio non compare in uno scontro (assente,
    // entrato dopo, ecc.) quel punto vale 0 — scelta esplicita: niente buchi
    // o interpolazioni, si vede chiaramente "zero in quello scontro".
    if (this._chartType === "trend") {
      const allIds = new Set();
      for (const fight of history) for (const id of Object.keys(fight.characters ?? {})) allIds.add(id);

      const labels = history.map(f => f.name ?? f.id);
      const datasets = [];
      for (const actorId of allIds) {
        let rawName = actorId;
        for (const fight of history) {
          if (fight.characters?.[actorId]) { rawName = fight.characters[actorId].name; break; }
        }
        const displayName = resolveDisplayName(actorId, rawName, nameDisplay);
        const colour = userColors[actorId] ?? themeColors[metric] ?? themeColors.accent;
        const data = history.map(fight => {
          const char = fight.characters?.[actorId];
          return char ? (Number(char[dbKey]) || 0) : 0;
        });
        datasets.push({
          label: displayName,
          data,
          borderColor: colour,
          backgroundColor: colour + "33",
          pointBackgroundColor: colour,
          tension: 0.3,
          fill: false
        });
      }

      this._chart = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: true, position: "top", labels: { color: textColor, padding: 12, font: { size: 12 } } },
            tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.raw}` } }
          },
          scales: {
            x: { grid: { color: "rgba(255,255,255,0.05)" }, ticks: { color: textColor, font: { family: "Signika, sans-serif", size: 11 } } },
            y: { grid: { color: "rgba(255,255,255,0.08)" }, ticks: { color: textColor, font: { family: "Signika, sans-serif", size: 12 } }, beginAtZero: true }
          }
        }
      });
      return;
    }

    const rawData = {};
    for (const fight of history) {
      for (const [actorId, char] of Object.entries(fight.characters ?? {})) {
        if (!rawData[actorId]) {
          rawData[actorId] = { name: char.name, values: [] };
        }
        const val = Number(char[dbKey]) || 0;
        rawData[actorId].values.push(val);
      }
    }

    const labels = [];
    const barData = [];
    const barColors = [];
    const barBorders = [];

    for (const [id, data] of Object.entries(rawData)) {
      const displayName = resolveDisplayName(id, data.name, nameDisplay);
      const colour      = userColors[id] ?? themeColors[metric] ?? themeColors.accent;

      const total = isMax ? Math.max(...data.values, 0) : data.values.reduce((sum, v) => sum + v, 0);

      labels.push(displayName);
      barData.push(total);
      barColors.push(colour + "99");
      barBorders.push(colour);
    }

    const isDoughnut = this._chartType === "doughnut";
    const datasets = [{
      label: "",
      data: barData,
      backgroundColor: isDoughnut ? barBorders.map(c => c + "cc") : barColors,
      borderColor:     isDoughnut ? barBorders.map(c => c + "ff") : barBorders,
      borderWidth: 2,
      tension: 0.3
    }];

    this._chart = new Chart(canvas.getContext("2d"), {
      type: this._chartType,
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: isDoughnut
            ? { display: true, position: "right", labels: { color: textColor, padding: 16, font: { size: 13 } } }
            : { display: false },
          tooltip: {
            callbacks: {
              label: isDoughnut
                ? c => ` ${c.label}: ${c.parsed}`
                : c => ` ${c.label}: ${c.raw}`
            }
          }
        },
        scales: isDoughnut ? {} : {
          x: { grid: { color: "rgba(255,255,255,0.05)" }, ticks: { color: textColor, font: { family: "Signika, sans-serif", size: 12 } } },
          y: { grid: { color: "rgba(255,255,255,0.08)" }, ticks: { color: textColor, font: { family: "Signika, sans-serif", size: 12 } }, beginAtZero: true }
        }
      }
    });
  }

  // Intercettiamo i click sui bottoni ed elementi interattivi dell'applicazione
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);

    // Collega gli eventi della Tab Bar, Toolbar e Pulsanti speciali
    this.element.addEventListener("click", event => {
      
      // 1. Cambio Tab
      const tabBtn = event.target.closest(".cs-tab-btn");
      if (tabBtn) {
        event.preventDefault();
        this._activeTab = tabBtn.dataset.tab;
        this.render({ parts: ["main"] });
        return;
      }

      // 2. Chiusura Tab Single Fight
      const closeTabBtn = event.target.closest("#cs-close-fight-tab");
      if (closeTabBtn) {
        event.preventDefault();
        this._selectedFightId = null;
        if (this._activeTab === "fight") this._activeTab = "totals";
        this.render({ parts: ["main"] });
        return;
      }

      // 3. Cambio Metrica del Grafico
      const modeBtn = event.target.closest(".cs-mode-btn");
      if (modeBtn) {
        event.preventDefault();
        this._metric = modeBtn.dataset.mode;
        this.render({ parts: ["main"] });
        return;
      }

      // 4. Cambio Tipo di Grafico (Bar / Doughnut)
      const typeBtn = event.target.closest(".cs-type-btn");
      if (typeBtn) {
        event.preventDefault();
        this._chartType = typeBtn.dataset.type;
        this.render({ parts: ["main"] });
        return;
      }

      // 5. Esportazione in Excel
      const exportBtn = event.target.closest("#cs-export-excel");
      if (exportBtn) {
        event.preventDefault();
        const history = game.settings.get(MODULE_ID, S_HISTORY) ?? [];
        exportToExcel(history, "pf1e-combat-stats");
        return;
      }

      // 6. Svuota Cronologia Completa (GM Only)
      const clearBtn = event.target.closest("#cs-clear-history");
      if (clearBtn && game.user.isGM) {
        event.preventDefault();
        const currentHistory = game.settings.get(MODULE_ID, S_HISTORY) ?? [];
        const count = currentHistory.length;
        Dialog.confirm({
          title: game.i18n.localize("COMBATSTATS.Btn.ClearAll"),
          content: `<p>${game.i18n.format("COMBATSTATS.Dialog.ClearHistoryMsg", { count })}</p>`,
          yes: () => {
            // Backup di sicurezza: permette "Annulla" per un tempo limitato,
            // per evitare perdite accidentali di dati (es. click sul cestino sbagliato).
            const backup = { data: foundry.utils.deepClone(currentHistory), expiresAt: Date.now() + UNDO_CLEAR_TTL_MS };
            game.settings.set(MODULE_ID, S_HISTORY_BACKUP, backup).then(() => {
              return game.settings.set(MODULE_ID, S_HISTORY, []);
            }).then(() => {
              this._selectedFightId = null;
              this._activeTab = "totals";
              this.render({ parts: ["main"] });
              setTimeout(() => {
                // Scaduta la finestra di undo: pulizia silenziosa del backup e refresh UI.
                const b = game.settings.get(MODULE_ID, S_HISTORY_BACKUP);
                if (b && b.expiresAt === backup.expiresAt) {
                  game.settings.set(MODULE_ID, S_HISTORY_BACKUP, null).then(() => this.render({ parts: ["main"] }));
                }
              }, UNDO_CLEAR_TTL_MS + 200);
            });
          }
        });
        return;
      }

      // 6c. Annulla l'ultima cancellazione totale (entro la finestra di tempo)
      const undoClearBtn = event.target.closest("#cs-undo-clear-history");
      if (undoClearBtn && game.user.isGM) {
        event.preventDefault();
        const backup = game.settings.get(MODULE_ID, S_HISTORY_BACKUP);
        if (backup && Date.now() < backup.expiresAt) {
          game.settings.set(MODULE_ID, S_HISTORY, backup.data).then(() => {
            return game.settings.set(MODULE_ID, S_HISTORY_BACKUP, null);
          }).then(() => this.render({ parts: ["main"] }));
        }
        return;
      }

      // 7b. Toggle chip personaggio nel tab Abilities (selezione multipla)
      const charChip = event.target.closest(".cs-char-chip");
      if (charChip) {
        event.preventDefault();
        const id = charChip.dataset.actorId;
        if (this._abilityChars.has(id)) this._abilityChars.delete(id);
        else this._abilityChars.add(id);
        this.render({ parts: ["main"] });
        return;
      }

      // 6b. Elimina una singola voce nemico (GM Only) — rimuove SOLO
      // fight.enemies[id] da ogni scontro, mai fight.characters: il danno
      // inflitto dai giocatori a quel nemico resta invariato nei loro totali,
      // perché è già accumulato lato personaggio indipendentemente.
      const delEnemyBtn = event.target.closest(".cs-delete-enemy-row");
      if (delEnemyBtn && game.user.isGM) {
        event.preventDefault();
        const enemyId = delEnemyBtn.dataset.enemyId;
        const enemyName = delEnemyBtn.dataset.enemyName ?? "";
        Dialog.confirm({
          title: game.i18n.localize("COMBATSTATS.Enemies.Delete"),
          content: `<p>${game.i18n.format("COMBATSTATS.Enemies.DeleteMsg", { name: enemyName })}</p>`,
          yes: () => {
            const history = foundry.utils.deepClone(game.settings.get(MODULE_ID, S_HISTORY) ?? []);
            let changed = false;
            for (const fight of history) {
              if (fight.enemies && Object.prototype.hasOwnProperty.call(fight.enemies, enemyId)) {
                delete fight.enemies[enemyId];
                changed = true;
              }
            }
            if (changed) {
              game.settings.set(MODULE_ID, S_HISTORY, history).then(() => this.render({ parts: ["main"] }));
            }
          }
        });
        return;
      }

      // 7. Elimina Scontro Singolo (GM Only)
      const deleteFightBtn = event.target.closest("#cs-delete-fight");
      if (deleteFightBtn && game.user.isGM) {
        event.preventDefault();
        const historyForName = game.settings.get(MODULE_ID, S_HISTORY) ?? [];
        const fightName = historyForName.find(f => f.id === this._selectedFightId)?.name ?? "";
        Dialog.confirm({
          title: game.i18n.localize("COMBATSTATS.Fight.Delete"),
          content: `<p>${game.i18n.format("COMBATSTATS.Dialog.DeleteFightMsg", { name: fightName })}</p>`,
          yes: () => {
            const history = game.settings.get(MODULE_ID, S_HISTORY) ?? [];
            const updated = history.filter(f => f.id !== this._selectedFightId);
            game.settings.set(MODULE_ID, S_HISTORY, updated).then(() => {
              this._selectedFightId = null;
              this._activeTab = "totals";
              this.render({ parts: ["main"] });
            });
          }
        });
        return;
      }
    });

    // Intercettiamo il cambio della tendina del singolo combattimento nel tab "Totals"
    this.element.addEventListener("change", event => {
      const select = event.target.closest("#cs-fight-select");
      if (select && select.value) {
        this._selectedFightId = select.value;
        this._activeTab = "fight";
        this.render({ parts: ["main"] });
        return;
      }

    });
  }
}