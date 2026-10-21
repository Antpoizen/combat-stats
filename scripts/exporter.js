/**
 * exporter.js v1.6.0
 * Uses SheetJS + FileSaver.js for reliable cross-platform Excel download.
 * FileSaver.js is the industry standard for browser-based file saving —
 * handles Chrome, Firefox, Safari, and Foundry on Sqyre/remote hosting.
 */

import { XLSXLite, saveFile } from './vendor/xlsx-lite.js';
const ensureDeps = async()=>{ globalThis.XLSX=XLSXLite; globalThis.saveAs=saveFile; };

// Column set shared by per-fight sheets, the enemies sections, and the
// summary sheets. Keys map directly to the fields tracked in tracker.js —
// keep in sync if new tracked stats are added there.
const STAT_COLUMNS = [
  { key: "damageDealt",         labelKey: "DamageDealt" },
  { key: "overdamage",          labelKey: "Overkill" },
  { key: "damageTaken",         labelKey: "DamageTaken" },
  { key: "excessDamageTaken",   labelKey: "ExcessTaken" },
  { key: "healingDone",         labelKey: "HealingDone" },
  { key: "overhealing",         labelKey: "Overhealing" },
  { key: "kills",               labelKey: "Kills" },
  { key: "maxSingleHit",        labelKey: "MaxHit" },
  { key: "maxSingleHitSource",  labelKey: "MaxHitSource",  numeric: false },
  { key: "maxSingleHeal",       labelKey: "MaxHeal" },
  { key: "maxSingleHealSource", labelKey: "MaxHealSource", numeric: false },
  { key: "timesDowned",         labelKey: "TimesDowned" }
];

// ─── Main export ──────────────────────────────────────────────────────────────

export async function exportToExcel(history, filename = "pf1e-combat-stats") {
  const i18n = key => game.i18n.localize(`COMBATSTATS.Export.${key}`);
  const columns = STAT_COLUMNS.map(c => ({ ...c, label: i18n(c.labelKey) }));

  const statValues = c => columns.map(col => {
    const v = c[col.key];
    if (col.numeric === false) return v ?? "";
    return v ?? 0;
  });
  const totalsRow = chars => columns.map(col => {
    if (col.numeric === false) return ""; // source columns aren't summable
    return chars.reduce((sum, c) => sum + (c[col.key] ?? 0), 0);
  });

  if (!history?.length) {
    ui.notifications.warn(i18n("NoData"));
    return;
  }

  try {
    await ensureDeps();
  } catch(e) {
    ui.notifications.error(i18n("LoadError"));
    console.error(e);
    return;
  }

  const XLSX = globalThis.XLSX;
  const wb   = XLSX.utils.book_new();
  const locale = game.i18n.lang === "it" ? "it-IT" : "en-US";
  const colWidths = columns.map(c => ({ wch: c.numeric === false ? 18 : Math.max(12, c.label.length + 2) }));

  // ── Per-fight sheets ──────────────────────────────────────────────────────
  history.forEach((fight, idx) => {
    const chars = Object.values(fight.characters ?? {}).sort((a, b) => (b.damageDealt ?? 0) - (a.damageDealt ?? 0));

    const rows = [[i18n("Character"), ...columns.map(c => c.label)]];
    chars.forEach(c => rows.push([c.name, ...statValues(c)]));
    rows.push([i18n("Total"), ...totalsRow(chars)]);

    // Defeated enemies section
    if ((fight.defeated ?? []).length > 0) {
      rows.push([]);
      rows.push([i18n("DefeatedEnemies"), i18n("KilledBy")]);
      fight.defeated.forEach(d => {
        const killerName = d.killedBy ? (game.actors.get(d.killedBy)?.name ?? i18n("Unknown")) : "—";
        rows.push([d.name, killerName]);
      });
    }

    // Enemies section — only present if "Track enemy stats" was enabled during
    // the fight. Same column set as the party table, since the enemies bucket
    // in tracker.js shares the exact same data shape.
    const enemies = Object.values(fight.enemies ?? {}).sort((a, b) => (b.damageDealt ?? 0) - (a.damageDealt ?? 0));
    if (enemies.length > 0) {
      rows.push([]);
      rows.push([i18n("Enemies"), ...columns.map(c => c.label)]);
      enemies.forEach(e => rows.push([e.name, ...statValues(e)]));
      rows.push([i18n("Total"), ...totalsRow(enemies)]);
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 24 }, ...colWidths];
    _boldRow(ws, XLSX, 0);

    XLSX.utils.book_append_sheet(wb, ws, _sheetName(fight.name, idx + 1, i18n("SheetPrefix")));
  });

  // ── All Fights summary sheet ──────────────────────────────────────────────
  const summaryRows = [[i18n("Fight"), i18n("Date"), i18n("Character"), ...columns.map(c => c.label)]];
  history.forEach(fight => {
    const date = new Date(fight.date).toLocaleDateString(locale);
    Object.values(fight.characters ?? {})
      .sort((a, b) => (b.damageDealt ?? 0) - (a.damageDealt ?? 0))
      .forEach(c => summaryRows.push([fight.name, date, c.name, ...statValues(c)]));
    summaryRows.push([]);
  });
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary["!cols"] = [{ wch: 22 }, { wch: 12 }, { wch: 24 }, ...colWidths];
  _boldRow(wsSummary, XLSX, 0);
  XLSX.utils.book_append_sheet(wb, wsSummary, i18n("AllFightsSheet"));

  // ── All Enemies summary sheet ─────────────────────────────────────────────
  // Only added if "Track enemy stats" produced data in at least one fight.
  const hasAnyEnemyData = history.some(f => Object.keys(f.enemies ?? {}).length > 0);
  if (hasAnyEnemyData) {
    const enemySummaryRows = [[i18n("Fight"), i18n("Date"), i18n("Character"), ...columns.map(c => c.label)]];
    history.forEach(fight => {
      const date = new Date(fight.date).toLocaleDateString(locale);
      Object.values(fight.enemies ?? {})
        .sort((a, b) => (b.damageDealt ?? 0) - (a.damageDealt ?? 0))
        .forEach(e => enemySummaryRows.push([fight.name, date, e.name, ...statValues(e)]));
      enemySummaryRows.push([]);
    });
    const wsEnemySummary = XLSX.utils.aoa_to_sheet(enemySummaryRows);
    wsEnemySummary["!cols"] = [{ wch: 22 }, { wch: 12 }, { wch: 24 }, ...colWidths];
    _boldRow(wsEnemySummary, XLSX, 0);
    XLSX.utils.book_append_sheet(wb, wsEnemySummary, i18n("AllEnemiesSheet"));
  }

  // ── Save with FileSaver.js (works on all browsers + Sqyre) ───────────────
  const safeFilename = `${filename}_${_dateStamp()}.xlsx`;
  const wbArray = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob    = new Blob([wbArray], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

  globalThis.saveAs(blob, safeFilename);
  ui.notifications.info(game.i18n.format("COMBATSTATS.Export.Success", { filename: safeFilename }));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _sheetName(name, idx, prefix = "Fight") {
  const fallback = `${prefix} ${idx}`;
  return ((name ?? fallback).replace(/[\\\/\?\*\[\]:]/g, "").trim().slice(0, 31)) || fallback;
}

function _dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
}

function _boldRow(ws, XLSX, rowIdx) {
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  for (let col = range.s.c; col <= range.e.c; col++) {
    const addr = XLSX.utils.encode_cell({ r: rowIdx, c: col });
    if (ws[addr]) ws[addr].s = { font: { bold: true } };
  }
}
