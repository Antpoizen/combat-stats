# PF1e Combat Stats — Native Rebuild 1.0.14 (Experimental)

This version **replaces the original tracker and dashboard**, instead of continuing to port Combat Stats 4's event assumptions. It is not a fork of the original damage ingestion path; the licensing and attribution files remain because some supporting UI, settings and export components derive from the upstream project.

**Targets:** Foundry VTT 13.351; Pathfinder 1e v11.11; optional Armor Soak Pool and Nevela's Automation Suite.

## Core rules

- A combat begins to have a roster **as soon as one initiative value is set** (or combat starts). All members of that combat's `combatants` collection are included, even members with zero initiative and zero damage. Actors outside initiative are excluded.
- The record key is the **Combatant ID**, never an Actor ID. Each linked or unlinked token has its own Combatant ID. Full Actor UUIDs are retained for targeting. Two unlinked Bloodlings from one base actor produce distinct records.
- Friendly (+1) token disposition goes in **Players**; Hostile (-1) in **Enemies**. Missing/neutral dispositions fall back to `character`/`npc` actor types, then ownership. Every participant is still recorded.
- Damage is counted from **actual resource decreases**, not from roll-card totals. The tracker observes `updateActor`, `updateToken`, `updateActorDelta`, and reconciles combatant values every 300ms. Soak, Vigor, Wounds, and HP are included. Soak restoration is not healing.
- Damage dealt is credited to an explicit PF1e chat-card Apply Damage source when available, or an explicit `queueSource` call. When no verified source is present, the enabled-by-default initiative-turn fallback credits the active combatant and labels the event `inferred-turn`. This inference may be wrong for reactions, traps, and delayed effects. Disable in settings for strictly verified credits.
- `maxSingleHit` uses the greatest observed **application**, grouping separate Soak and Vigor/HP writes within 180ms. Two repeated same-resource changes are considered separate hits. A long delay or unusually quick overlapping spells may still require live verification.
- Kills occur when a tracked combatant is marked **Defeated** (or has the dead status). Merely unconscious/dying counts as downed but not defeated. The last attributed damaging combatant receives the kill; an unattributed kill remains in the defeated record without guessing a killer.
- State is updated **synchronously in an in-memory ledger**. A serialized world-setting write persists it for reconnects and final history; live Charts reads the ledger directly. Existing completed history remains accessible.

## Install from ZIP

Extract the module files to `Data/modules/pf1e-combat-stats` so `module.json` is at the folder's root, or publish the included `v1.0.14.zip` through your release workflow. Enable in the world and reload every connected GM and player browser after an upgrade. For the GitHub action in `.github/workflows/release.yml`, push the source files and then push a **new** `v1.0.14` tag against that same commit.

### Live verification — six participants

1. Add four friendly PC combatants and two hostile Bloodlings. Roll initiative for one combatant (without starting the fight). Open **PF1e Combat Stats → Fight Details** and verify **all six** appear at zero. If not, run `tools/diagnostics-macro.js` in the F12 console and capture its output.
2. Start combat. Apply 14 HP to Bloodling A using PF1e / Armor Soak. Inspect the **Enemies** tab: only Bloodling A should show 14 damage taken.
3. Use Tangra to apply 41 and 43 HP to the same Bloodling on separate actions. Confirm Tangra's damage dealt is 84 and max single hit is 43 (assuming no prior larger hit).
4. Apply an AoE that damages both Bloodlings; confirm both individual records update. Mark A Unconscious, then Defeated; confirm one kill credited to the last recorded damaging source, not an extra downed count.
5. End combat, reopen Charts, and verify all six are still present under the archived fight.
6. Repeat step 2 from a **different player's browser**, with the GM connected. This is crucial: our automated test stubs socket delivery and cannot prove real multi-client chat attribution works.

### Diagnostics

Run in F12:

```javascript
console.table(game.modules.get('pf1e-combat-stats').api.getDiagnostics())
```

For a complete event and snapshot report:

```javascript
console.log(JSON.stringify(game.modules.get('pf1e-combat-stats').api.getDebugReport(),null,2))
```

The module's `tools/diagnostics-macro.js` prints a concise table and the full report. The report includes event attribution method and hook counters to distinguish missing registration from missing damage events.

## API

- `game.modules.get('pf1e-combat-stats').api.getRoster()` — all initiative participants and current resource state.
- `getDiagnostics()` — same roster and tracking state.
- `getDebugReport()` — detailed roster, settings, and event logs.
- `queueSource({sourceActor,targetActor,itemName,messageId})` — set an explicit attack source *before* applying resources. No health change occurs here.
- `recordEvent(event)` — GM authoritative manual event with explicit Combatant IDs.
- `recordManual({...})` — records a statistics event, **does not apply damage**.
- `openCharts()` — open PF1e-native dashboard.

## Testing limitations

Run the included regression suite with:

```bash
node tests/pf1e-engine.test.mjs
```

The suite exercises combat lifecycle Hooks, player socket intents, two unlinked actors sharing a world Actor ID, stale `ActorDelta` values, a six-participant initiative roster, damage, max hits, deaths and final history. **The tests use a mocked Foundry environment. They do not test a live Foundry/Nevela/Armor Soak integration or real multiplayer sockets.** The live checklist above is required before calling this stable.

## Attribution and upstream code

See `ATTRIBUTION.md` and `LICENSE` for the original Combat Stats components retained for styling, settings, summaries and exporters. This rebuild replaces `scripts/tracker.js`, `scripts/charts.js` and adds `templates/pf1e-dashboard.hbs` / `styles/pf1e-dashboard.css`.
