/**
 * SummaryApp v2.0.0
 * End-of-combat chat card with:
 * - nameDisplay support (full / firstname / lastname / username)
 * - all 7 tracked stats with sub-values (overdamage / excess / overhealing)
 * - big hit achievement callout
 * - grouped defeated enemies with count badges
 */

const MODULE_ID = "pf1e-combat-stats";
const _posted   = new Set();
const esc = value => foundry.utils.escapeHTML(String(value ?? ""));

// ─── Name helpers ─────────────────────────────────────────────────────────────

function resolveDisplayName(actorId, actorName, mode) {
  if (mode === "username") {
    const user = game.users?.find(u => u.character?.id === actorId);
    if (user) return user.name ?? actorName;
  }
  if (mode === "firstname") return actorName.split(" ")[0];
  if (mode === "lastname")  { const parts = actorName.split(" "); return parts[parts.length - 1]; }
  return actorName; // "full"
}

// ─── SummaryApp ───────────────────────────────────────────────────────────────

export class SummaryApp {

  static openOnce(record) {
    if (_posted.has(record.id)) return;
    _posted.add(record.id);
    SummaryApp.postToChat(record);
  }

  static async postToChat(record) {
    const chars = Object.values(record.characters ?? {})
      .sort((a, b) => (b.damageDealt ?? 0) - (a.damageDealt ?? 0));
    if (!chars.length) return;

    // ── Settings ──
    const g = k => { try { return game.settings.get(MODULE_ID, k); } catch { return null; } };
    const nameDisplay     = g("nameDisplay")     ?? "full";
    const bigHitThreshold = g("bigHitThreshold") ?? 30;
    const bigHitColor     = g("bigHitColor")     ?? "#ff6a00";

    // Theme colours (use saved settings, fallback to defaults)
    const cAccent = g("colorAccent") ?? "#d4af37";
    const cDealt  = g("colorDealt")  ?? "#ce4141";
    const cTaken  = g("colorTaken")  ?? "#e67e22";
    const cHealed = g("colorHealed") ?? "#2ecc71";
    const cBg     = g("colorBg")     ?? "#1a1a24";
    const cBgRow  = g("colorBgRow")  ?? "#252530";
    const cText   = g("colorText")   ?? "#eeeeee";

    // Mostriamo SEMPRE i dati di Over se sono abilitati nelle impostazioni generali,
    // senza verificare forzatamente se siamo in modalità midi (visto che midi-auto bypassa il check standard)
    const show = {
      kills:             g("trackKills")             !== false,
      damageDealt:       g("trackDamageDealt")       !== false,
      overdamage:        g("trackOverdamage")        !== false,
      damageTaken:       g("trackDamageTaken")               !== false,
      excessDamageTaken: g("trackExcessDamageTaken") !== false,
      healingDone:       g("trackHealingDone")               !== false,
      overhealing:       g("trackOverhealing")       !== false,
    };

    // ── Player colours ──
    const colourMap = {};
    for (const user of game.users ?? []) {
      const actor = user.character;
      if (!actor) continue;
      const col = user.color?.css ?? user.color ?? null;
      if (col) { colourMap[actor.id] = col; colourMap[actor.name] = col; }
    }

    // ── Layout helpers ──
    const cellS = `flex:1;display:flex;align-items:center;justify-content:center;padding:8px 4px;`;
    const valS  = `font-weight:700;line-height:1;white-space:nowrap;`;
    const subS  = `font-size:0.75em;font-weight:600;opacity:0.9;white-space:nowrap;`;
    const rowS  = `display:flex;align-items:stretch;border-bottom:1px solid rgba(255,255,255,0.04);background:${cBgRow};`;
    const nameS = `width:90px;min-width:60px;max-width:90px;flex-shrink:0;display:flex;align-items:center;padding:0 8px;overflow:hidden;`;

    // ── Active columns list ──
    const chatShow = {
      kills:       g("chatShowKills")       !== false,
      damageDealt: g("chatShowDamageDealt") !== false,
      damageTaken: g("chatShowDamageTaken") !== false,
      healingDone: g("chatShowHealingDone") !== false,
    };
    const activeCols = [];
    if (chatShow.kills)       activeCols.push({ key:"kills",       color:cAccent,   sub:null });
    if (chatShow.damageDealt) activeCols.push({ key:"damageDealt", color:cDealt,    sub:"overdamage",        subColor:"#ff2020", subLabel:"over", subTitle:"Overkill — excess damage dealt past 0 HP" });
    if (chatShow.damageTaken) activeCols.push({ key:"damageTaken", color:"#52a8e0", sub:"excessDamageTaken", subColor:"#1a6fa8", subLabel:"over", subTitle:"Excess damage taken — damage absorbed beyond max HP" });
    if (chatShow.healingDone) activeCols.push({ key:"healingDone", color:cHealed,   sub:"overhealing",       subColor:"#1a8a4a", subLabel:"over", subTitle:"Overhealing — healing beyond max HP" });

    // ── Header ──
    const headerIcons = { kills:"fa-skull", damageDealt:"fa-burst", damageTaken:"fa-shield-halved", healingDone:"fa-heart" };
    const headerColors = { kills:cAccent, damageDealt:cDealt, damageTaken:"#52a8e0", healingDone:cHealed };
    const headerCells = activeCols.map(col =>
      `<div style="${cellS}background:${cBg};padding:6px 4px;">
        <i class="fa-solid ${headerIcons[col.key]}" style="color:${headerColors[col.key]};font-size:1.05em;"></i>
      </div>`
    ).join("");
    const headerRow = `
      <div style="display:flex;align-items:stretch;background:${cBg};border-bottom:1px solid rgba(255,255,255,0.08);">
        <div style="${nameS}height:34px;background:${cBg};"></div>
        ${headerCells}
      </div>`;

    // ── Character rows ──
    const rows = chars.map(c => {
      const displayName = esc(resolveDisplayName(c.id, c.name, nameDisplay));
      const nameColour  = colourMap[c.id] ?? colourMap[c.name] ?? cText;
      const shadow      = "text-shadow:0 0 4px rgba(0,0,0,0.9),0 0 8px rgba(0,0,0,0.7);";

      const cells = activeCols.map(col => {
        const val    = c[col.key] ?? 0;
        const subVal = col.sub ? (c[col.sub] ?? 0) : 0;
        const showSub = col.sub && show[col.sub] && subVal > 0;
        const subSpan = showSub
          ? ` <span style="${subS}color:${col.subColor};" title="${col.subTitle}">(+${subVal})</span>`
          : "";
        return `<div style="${cellS}"><span style="${valS}color:${col.color};">${val}</span>${subSpan}</div>`;
      }).join("");

      return `
      <div style="${rowS}">
        <div style="${nameS}">
          <span style="font-weight:700;font-size:0.88em;color:${nameColour};${shadow};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;width:100%;">${displayName}</span>
        </div>
        ${cells}
      </div>`;
    }).join("");

    // ── Totals row ──
    const totals = chars.reduce((a, c) => {
      a.kills             += c.kills             ?? 0;
      a.damageDealt       += c.damageDealt       ?? 0;
      a.damageTaken       += c.damageTaken       ?? 0;
      a.healingDone       += c.healingDone       ?? 0;
      a.overdamage         += c.overdamage         ?? 0;
      a.excessDamageTaken += c.excessDamageTaken ?? 0;
      a.overhealing       += c.overhealing       ?? 0;
      return a;
    }, { kills:0, damageDealt:0, damageTaken:0, healingDone:0, overdamage:0, excessDamageTaken:0, overhealing:0 });

    const totalCells = activeCols.map(col =>
      `<div style="${cellS}"><span style="${valS}color:${col.color};">${totals[col.key]}</span></div>`
    ).join("");
    const totalsRow = `
      <div style="display:flex;align-items:stretch;background:${cBg};border-top:2px solid ${cAccent}55;">
        <div style="${nameS}background:${cBg};height:40px;">
          <span style="font-size:0.8em;font-weight:700;color:${cAccent};">${game.i18n.localize("COMBATSTATS.Table.Total")}</span>
        </div>
        ${totalCells}
      </div>`;

    // ── Big hit achievement ──
    let bigHitHTML = "";
    if (bigHitThreshold > 0) {
      let bestHit = 0, bestChar = null;
      for (const c of chars) {
        if ((c.maxSingleHit ?? 0) > bestHit) {
          bestHit = c.maxSingleHit;
          bestChar = c;
        }
      }
      if (bestChar && bestHit >= bigHitThreshold) {
        const name = esc(resolveDisplayName(bestChar.id, bestChar.name, nameDisplay));
        const customMsg = g("bigHitMessage") ?? "";
        const defaultMsg = game.i18n.localize("COMBATSTATS.Chat.BigHit");
        const msgTemplate = customMsg.trim() || defaultMsg;
        const source = esc(bestChar.maxSingleHitSource?.trim() ?? "");
        const round  = bestChar.maxSingleHitRound ?? null;
        let bigHitText = msgTemplate
          .replace(/\{\{name\}\}/g, name)
          .replace(/\{\{value\}\}/g, bestHit);
        if (round !== null) {
          // "1°" è la convenzione ordinale italiana; in inglese si direbbe
          // "1st/2nd/3rd" (lavoro diverso), quindi il suffisso resta legato
          // alla lingua attiva invece di essere forzato sempre.
          const formattedRound = game.i18n.lang === "it" ? `${round}°` : String(round);
          bigHitText = bigHitText.replace(/\{\{round\}\}/g, formattedRound);
        } else {
          bigHitText = bigHitText.replace(/\s*(at|al)\s*round\s*\{\{round\}\}/gi, "").replace(/\{\{round\}\}/g, "");
        }
        if (source) {
          bigHitText = bigHitText.replace(/\{\{source\}\}/g, source);
        } else {
          bigHitText = bigHitText.replace(/\s*(with|con|using|tramite)\s*\{\{source\}\}/gi, "").replace(/\{\{source\}\}/g, "");
        }
        bigHitHTML = `
      <div style="padding:6px 10px 8px;border-top:1px solid rgba(255,106,0,0.3);
                  background:rgba(255,106,0,0.05);display:flex;align-items:center;gap:8px;">
        <i class="fa-solid fa-khanda" style="color:${bigHitColor};font-size:1.1em;flex-shrink:0;"></i>
        <span style="color:${bigHitColor};font-weight:700;font-size:0.88em;">
          ${bigHitText}
        </span>
      </div>`;
      }
    }

    // ── Defeated enemies (grouped) ──
    const defeated = record.defeated ?? [];
    let defeatedHTML = "";
    if (defeated.length) {
      const groups = new Map();
      for (const d of defeated) {
        const killerActor = d.killedBy ? game.actors.get(d.killedBy) : null;
        const killerName  = killerActor?.name ?? null;
        const key = `${d.killedBy ?? ""}|${d.name.toLowerCase()}`;
        if (!groups.has(key)) groups.set(key, { name: d.name, killerName, count: 0 });
        groups.get(key).count++;
      }
      const tags = [...groups.values()].map(grp => {
        const badge = grp.count > 1
          ? `<span style="background:${cAccent}33;border-radius:8px;padding:0 5px;font-size:0.9em;font-weight:700;color:${cAccent};">${grp.count}×</span>`
          : "";
        return `<span style="background:${cDealt}1a;border:1px solid ${cDealt}55;
                      border-radius:10px;padding:2px 9px;font-size:0.8em;
                      display:inline-flex;align-items:center;gap:5px;">
          ${grp.killerName ? `<span style="color:${cAccent};font-weight:700;">${esc(grp.killerName)}</span>
            <i class="fa-solid fa-skull" style="color:${cDealt};font-size:0.75em;"></i>` : ""}
          <span style="opacity:0.7;color:${cText};">${esc(grp.name)}</span>
          ${badge}
        </span>`;
      }).join("");
      const defeatedLabel = game.i18n.localize("COMBATSTATS.Chat.Defeated");
      defeatedHTML = `
      <div style="padding:6px 10px 8px;border-top:1px solid ${cAccent}33;background:${cBgRow};">
        <div style="font-size:0.75em;color:${cAccent};font-weight:700;margin-bottom:5px;letter-spacing:0.04em;">
          <i class="fa-solid fa-skull"></i> ${defeatedLabel} (${defeated.length})
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;">${tags}</div>
      </div>`;
    }

    // ── Assemble card ──
    const content = `
<div style="font-family:'Signika',sans-serif;border:2px solid ${cAccent};border-radius:8px;
            background:${cBg};overflow:hidden;color:${cText};width:100%;box-sizing:border-box;">
  <div style="background:linear-gradient(135deg,${cAccent},${cAccent}bb);color:${cBg};
              padding:7px 12px;display:flex;align-items:center;gap:8px;">
    <i class="fa-solid fa-swords" style="font-size:0.9em;"></i>
    <strong style="font-size:1em;">${esc(record.name)}</strong>
  </div>
  ${headerRow}
  ${rows}
  ${totalsRow}
  ${bigHitHTML}
  ${defeatedHTML}
</div>`;

    await ChatMessage.create({
      content,
      speaker: SummaryApp._resolveSpeaker(g),
      style:   CONST.CHAT_MESSAGE_STYLES?.OTHER ?? "other",
      flags:   { "pf1e-combat-stats": { summary: true, fightId: record.id } }
    });
  }

  // Se il GM ha impostato un ID Attore valido in "Chat message sender", il
  // messaggio viene inviato come quell'Attore (nome + ritratto). Altrimenti
  // si usa l'alias fisso "⚔️ Combat Stats". ID vuoto o non risolvibile →
  // fallback silenzioso all'alias, con un warning in console per il debug.
  static _resolveSpeaker(g) {
    const actorId = (g("chatMessageActorId") ?? "").trim();
    if (!actorId) return { alias: "⚔️ Combat Stats" };

    const actor = game.actors?.get(actorId);
    if (!actor) {
      console.warn(`Combat Stats | chatMessageActorId "${actorId}" non trovato tra gli Attori. Uso l'alias predefinito.`);
      return { alias: "⚔️ Combat Stats" };
    }

    return ChatMessage.getSpeaker({ actor });
  }
}