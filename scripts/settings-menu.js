/**
 * CombatStatsSettings v2.0.0 — Theme & Data FormApplication
 */

const MODULE_ID = "pf1e-combat-stats";

const LegacyForm = globalThis.FormApplication ?? foundry.appv1.api.FormApplication;
const LegacyApp = globalThis.Application ?? foundry.appv1.api.Application;
export class CombatStatsSettings extends LegacyForm {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:       "pf1e-combat-stats-settings",
      title:    game.i18n.localize("COMBATSTATS.Settings.ThemeMenu"),
      template: "modules/pf1e-combat-stats/templates/settings.hbs",
      width:    460,
      height:   "auto",
      classes:  ["combat-stats", "pf1e-combat-stats", "settings-form"]
    });
  }

  getData() {
    const g = k => game.settings.get(MODULE_ID, k);
    const defaultMsg = game.i18n.localize("COMBATSTATS.Chat.BigHit");
    return {
      colorAccent:          g("colorAccent"),
      colorBg:              g("colorBg"),
      colorBgRow:           g("colorBgRow"),
      colorDealt:           g("colorDealt"),
      colorTaken:           g("colorTaken"),
      colorHealed:          g("colorHealed"),
      colorText:            g("colorText"),
      bigHitColor:          g("bigHitColor"),
      colorOverkill:        g("colorOverkill"),
      colorExcessTaken:     g("colorExcessTaken"),
      colorOverhealing:     g("colorOverhealing"),
      colorMaxSingleHit:    g("colorMaxSingleHit"),
      colorMaxSingleHeal:   g("colorMaxSingleHeal"),
      colorTimesDowned:     g("colorTimesDowned"),
      bigHitMessage:        g("bigHitMessage") || "",
      bigHitMessageDefault: defaultMsg,
    };
  }

  async _updateObject(event, formData) {
    // Strip any stray workflow keys that may appear in older cached forms
    const colorKeys = ["colorAccent","colorBg","colorBgRow","colorDealt","colorTaken",
      "colorHealed","colorText","bigHitColor","colorOverkill","colorExcessTaken",
      "colorOverhealing","colorMaxSingleHit","colorMaxSingleHeal","colorTimesDowned","bigHitMessage"];
    for (const [key, value] of Object.entries(formData)) {
      if (colorKeys.includes(key)) await game.settings.set(MODULE_ID, key, value);
    }
    const { applyTheme } = await import("./module.js");
    applyTheme();
    ui.notifications.info(game.i18n.localize("COMBATSTATS.Theme.Saved"));
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Live preview as colour picker moves
    html.find("input[type=color]").on("input", (ev) => {
      const key = ev.currentTarget.name;
      const val = ev.currentTarget.value;
      const varMap = {
        colorAccent: "--cs-accent", colorBg: "--cs-bg", colorBgRow: "--cs-bg-row",
        colorDealt:  "--cs-dealt",  colorTaken: "--cs-taken",
        colorHealed: "--cs-healed", colorText:  "--cs-text"
      };
      if (varMap[key]) document.documentElement.style.setProperty(varMap[key], val);
    });

    // Open Data Management sub-dialog
    html.find("#cs-open-data-mgmt").on("click", () => {
      new CombatStatsDataDialog().render(true);
    });

    // Live preview
    const _previewNames   = ["Krk","Nowann","Cyrano","Fjorn","Thorinn","Bjorn","Takk","Frida","Yrsa","Berenhilde","Albert","Frys","Raphael"];
    const _previewSources = ["Longsword","Fireball","Greataxe","Inflict Wounds","Maul","Thunder Step","Divine Smite","Crossbow","Chromatic Orb","Fire Bolt","Ray of Frost","Lightning Bolt","Ice Storm"];
    const _previewName    = _previewNames[Math.floor(Math.random() * _previewNames.length)];
    const _previewSource  = _previewSources[Math.floor(Math.random() * _previewSources.length)];
    const _previewValue   = Math.floor(Math.random() * 38) + 5; // 5–42
    const _previewRound   = Math.floor(Math.random() * 8) + 1;  // 1–8
    const updatePreview = () => {
      const input    = html.find("#cs-bighit-msg-input");
      const preview  = html.find("#cs-bighit-preview");
      const raw      = input.val().trim() || input.attr("placeholder") || "";
      const rendered = raw
        .replace(/\{\{name\}\}/g,   `<strong style='color:#d4af37'>${_previewName}</strong>`)
        .replace(/\{\{value\}\}/g,  `<strong style='color:#ce4141'>${_previewValue}</strong>`)
        .replace(/\{\{source\}\}/g, `<strong style='color:#52a8e0'>${_previewSource}</strong>`)
        .replace(/\{\{round\}\}/g,  `<strong style='color:#9b59b6'>${game.i18n.lang === "it" ? `${_previewRound}°` : _previewRound}</strong>`);
      preview.html(`<i class="fa-solid fa-meteor" style="margin-right:5px;"></i>${rendered}`);
    };
    html.find("#cs-bighit-msg-input").on("input", updatePreview);
    updatePreview();

    // Placeholder buttons
    html.find(".cs-placeholder-btn").on("click", (ev) => {
      const input = html.find("#cs-bighit-msg-input")[0];
      const ph    = `{{${ev.currentTarget.dataset.placeholder}}}`;
      const start = input.selectionStart ?? input.value.length;
      const end   = input.selectionEnd   ?? input.value.length;
      input.value = input.value.slice(0, start) + ph + input.value.slice(end);
      input.focus();
      input.setSelectionRange(start + ph.length, start + ph.length);
      updatePreview();
    });

    // Reset big hit message
    html.find("#cs-reset-bighit-msg").on("click", () => {
      html.find("input[name='bigHitMessage']").val("");
    });

    // Reset colours
    html.find("#cs-reset-colors").on("click", async () => {
      const { COLOR_DEFAULTS } = await import("./module.js");
      const resetMap = {
        colorAccent:        COLOR_DEFAULTS.accent,
        colorBg:            COLOR_DEFAULTS.bg,
        colorBgRow:         COLOR_DEFAULTS.bgRow,
        colorDealt:         COLOR_DEFAULTS.dealt,
        colorTaken:         COLOR_DEFAULTS.taken,
        colorHealed:        COLOR_DEFAULTS.healed,
        colorText:          COLOR_DEFAULTS.text,
        bigHitColor:        COLOR_DEFAULTS.bigHit,
        colorOverkill:      COLOR_DEFAULTS.overkill,
        colorExcessTaken:   COLOR_DEFAULTS.excessTaken,
        colorOverhealing:   COLOR_DEFAULTS.overhealing,
        colorMaxSingleHit:  COLOR_DEFAULTS.maxSingleHit,
        colorMaxSingleHeal: COLOR_DEFAULTS.maxSingleHeal,
        colorTimesDowned:   COLOR_DEFAULTS.timesDowned,
      };
      for (const [k, v] of Object.entries(resetMap)) {
        html.find(`input[name="${k}"]`).val(v);
      }
    });
  }
}

/* ── Data Management Dialog ── */
export class CombatStatsDataDialog extends LegacyApp {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:       "pf1e-combat-stats-data-mgmt",
      title:    game.i18n.localize("COMBATSTATS.Theme.DataTitle"),
      template: "modules/pf1e-combat-stats/templates/data-management.hbs",
      width:    300,
      height:   "auto",
      classes:  ["combat-stats", "pf1e-combat-stats", "settings-form"]
    });
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Export JSON
    html.find("#cs-export-json-settings").on("click", () => {
      const history = game.settings.get(MODULE_ID, "combatHistory") ?? [];
      if (!history.length) { ui.notifications.warn("Combat Stats | No history to export."); return; }
      const blob = new Blob([JSON.stringify({ version: "2.0.0", history }, null, 2)], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `combat-stats-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    // Import JSON
    html.find("#cs-import-json-settings").on("click", () => {
      html.find("#cs-import-json-input")[0].click();
    });

    html.find("#cs-import-json-input").on("change", async (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      let parsed;
      try {
        const text = await file.text();
        parsed = JSON.parse(text);
      } catch {
        ui.notifications.error("Combat Stats | Invalid JSON file.");
        return;
      }
      const raw = parsed?.history ?? (Array.isArray(parsed) ? parsed : null);
      const incoming = Array.isArray(raw) ? raw.filter(f => f && typeof f === "object" && typeof f.id === "string" && f.id.length && typeof f.name === "string" && typeof f.characters === "object" && !Array.isArray(f.characters)) : null;
      if (!incoming?.length) { ui.notifications.warn("Combat Stats | No fight data found in file."); return; }

      const existing = game.settings.get(MODULE_ID, "combatHistory") ?? [];

      if (existing.length === 0) {
        await game.settings.set(MODULE_ID, "combatHistory", incoming);
        ui.notifications.info(`Combat Stats | Imported ${incoming.length} fight(s).`);
        return;
      }

      const choice = await foundry.applications.api.DialogV2.wait({
        window:  { title: game.i18n.localize("COMBATSTATS.Dialog.ImportTitle") },
        content: `<p>${game.i18n.localize("COMBATSTATS.Dialog.ImportMsg")}</p>`,
        buttons: [
          { action: "merge",   label: game.i18n.localize("COMBATSTATS.Dialog.ImportMerge"),   default: true },
          { action: "replace", label: game.i18n.localize("COMBATSTATS.Dialog.ImportReplace") },
          { action: "cancel",  label: game.i18n.localize("COMBATSTATS.Dialog.Cancel") }
        ]
      });

      if (!choice || choice === "cancel") return;

      let result;
      if (choice === "replace") {
        result = incoming;
      } else {
        const existingIds = new Set(existing.map(f => f.id));
        const newFights   = incoming.filter(f => !existingIds.has(f.id));
        result = [...existing, ...newFights];
        if (!newFights.length) { ui.notifications.info("Combat Stats | No new fights to import (all already present)."); return; }
      }

      await game.settings.set(MODULE_ID, "combatHistory", result);
      const count = choice === "replace" ? incoming.length : result.length - existing.length;
      ui.notifications.info(`Combat Stats | ${choice === "replace" ? "Replaced" : "Merged"}: ${count} fight(s) imported.`);
    });

    // Export to Excel
    html.find("#cs-export-excel-settings").on("click", async () => {
      const { exportToExcel } = await import("./exporter.js");
      const history = game.settings.get(MODULE_ID, "combatHistory") ?? [];
      if (!history.length) { ui.notifications.warn("Combat Stats | No history to export."); return; }
      exportToExcel(history, "pf1e-combat-stats");
    });

    // Clear history
    html.find("#cs-clear-history-settings").on("click", async () => {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window:  { title: game.i18n.localize("COMBATSTATS.Dialog.ClearHistory") },
        content: `<p>${game.i18n.localize("COMBATSTATS.Dialog.ClearHistoryMsg")}</p>`
      });
      if (!ok) return;
      await game.settings.set(MODULE_ID, "combatHistory", []);
      ui.notifications.info("Combat Stats | History cleared.");
    });
  }
}
