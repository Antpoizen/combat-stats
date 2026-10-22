# PF1e Combat Stats — v1.0.13 (development / integration-test build)

A Pathfinder 1e (system **11.11**) adaptation of **Combat Stats v4.0.0**, originally by **Smantella**. Targets **Foundry 13.351**. Active PF1e required; **no D&D5e or Midi-QOL dependency**.

**This is a development/validation candidate, NOT a fully runtime-tested release.** Tested off-line: JS syntax, JSON, resource accounting, locally generated XLSX via Python/openpyxl. Needs actual Foundry v13.351 + PF1e v11.11 + Nevela + Armor Soak integration testing before production. Do not publish as a stable release until the checklist is completed.

## How the module works

- Reuses the upstream Combat Stats charts window, combat recap presentation, settings/theme UI, English/Italian localization, historical fight records, and the spreadsheet export layout.
- Automatically observes **actual** decreases of supported actor resource fields during an active combat, rather than roll messages. In v13 it also polls only initiative combatants every 250 ms as a fallback when synthetic ActorDelta updates do not trigger a usable actor hook.
- Tracks separate Soak, Vigor, Wounds, and HP fallback damage, and distinguishes automatic **Soak increases** from healing.
- Uses an active GM as authoritative recorder; does not replace or patch `ActorPF.applyDamage`, libWrapper, PF1e's damage system, Nevela's Automation Suite, or Armor Soak.
- Creates per-combat statistics and summary when combat is deleted. A Charts tool is added to scene controls. Only actors actually enrolled in the initiative tracker appear. Duplicate unlinked NPCs are isolated by their scene token IDs, and duplicate display names gain [1], [2] suffixes.
- Offers a GM-only **Record verified event** tool and programmable source-attribution API for ambiguous workflows.
- Charts and `.xlsx` exports function without network/CDN access using small bundled canvas and OOXML writers. The chart renderer replicates the main bar/line/doughnut charts, not the full interactive Chart.js behavior. Excel formatting is basic, with numeric cells and all source rows preserved.

## Integration status

| Integration | Status |
|---|---|
| Foundry v13 manifest + source JS syntax | Statically checked |
| PF1e 11.11 health paths | Configurable; requires checking in your world |
| Nevela's Automation Suite | Non-invasive actor resource observer; no Nevela-specific post-damage API has been verified |
| Easy Target | No direct coupling. Targeting is **not** considered evidence of damage |
| Armor Soak Pool | Reads `flags.armor-soak-pool.current` and ignores all Soak increases; uses no damage monkey patch |
| Wounds/Vigor | Default resource paths `system.attributes.vigor.value` and `system.attributes.wounds.value`; verify these in the target world |
| Attribute attacker automatically | Chat-card context when verifiable; otherwise optional **initiative-turn fallback**, enabled by default in rc4 and explicitly marked `inferred-turn`. Reactions, traps, and delayed damage can be wrongly inferred. Disable for strictly confirmed attribution. |
| Confirmed kills/downed | Defeated/downed transition support exists; a kill can be credited to a recently confirmed or *turn-inferred* attacker. Live-world validation is still required. The combat end handler waits for pending defeat transitions. |
| Multiplayer GM observation | Implemented as active GM `updateActor` hook listener; not runtime-tested |
| Summon/polymorph attribution | Manual/explicit only; do not enable legacy speculative attribution |
| Overkill/overheal/excess | Not calculated unless exact verified pre/post amount becomes available; displayed zeros are not proof of absent damage |
| Persistence | World settings, current combat and completed history. Active encounter interrupted before deletion is retained |
| XLSX export | Verified offline via `openpyxl`; local OOXML writer |
| Localization | Original English and Italian retained; new integration controls currently English only |

Because the upstream ZIP did not include README/LICENSE, full upstream license review should be completed prior to public publication. The upstream `module.json` declares CC-BY-SA-4.0; this derivative retains attribution and share-alike notice.

## Install

1. Back up your world.
2. Install `pf1e-combat-stats/` in Foundry `Data/modules`, or push source and tag **v1.0.13** so GitHub Actions attaches `module.json` and `v1.0.13.zip`.
3. Enable the module in a PF1e 11.11 world running Foundry 13.351.
4. Configure **Vigor resource path**, **Wounds resource path**, and **HP fallback** in module settings after inspecting one PC and one NPC.
5. Begin a new combat; apply damage as usual. The GM's client must be online and active.
6. End/delete the combat tracker encounter to save the history and see the summary.
7. Open scene-control **PF1e Combat Stats → Charts** or call `game.modules.get("pf1e-combat-stats").api.openCharts()`.

## How to associate an attacker with damage

The tracker never infers responsibility from Easy Target alone. **rc4 enables an initiative-turn fallback** in settings: when a damage event has no explicitly resolved source, the combatant whose turn is current is assigned as `inferred-turn` (not verified). This covers normal attacks and AoE during initiative but can misattribute damage from reactions, traps, ongoing effects, and out-of-turn actions; turn it off if you require strictly confirmed statistics. For workflows that don't supply a trustworthy source, use the GM **Record verified event** tool, but be careful: a manual event is **added** to statistics and would duplicate an automatic resource observation if both are used. For an automated event with no source, update the event attribution rather than adding a duplicate; that UI is not yet implemented.

A macro may explicitly queue trusted source attribution **on the GM client before applying damage**:

```js
const api = game.modules.get('pf1e-combat-stats')?.api;
const source = game.actors.get('SOURCE_ACTOR_ID');
const target = game.actors.get('TARGET_ACTOR_ID');
api.queueSource({ sourceActor: source, targetActor: target, itemName: 'Shortsword', ttl: 12000 });
```

This associates a *single subsequent* target resource-change transaction with the attacker. Do not queue multiple contexts for the same target simultaneously. This is intended for manually verified GM use; contexts queued from a player's own client do not automatically reach the authoritative GM.

Examples to read history:

```js
const api = game.modules.get('pf1e-combat-stats')?.api;
console.log(api.getHistory());
api.openCharts();
```

### GM-only manual event

```js
game.modules.get('pf1e-combat-stats')?.api.openManualDialog();
```

The dialog records statistics, **not** actor damage. It must not be used to double-count damage already observed.

## rc4 regression test (offline, not a world integration test)

Replays the observed encounter with Daleira and Tangra against two Bloodling synthetic tokens sharing the same base Actor ID. Expected: Daleira 57 dealt / 61 taken / 1 kill, Tangra 84 dealt; Bloodling [1] takes 127 HP and deals 28, Bloodling [2] takes 14 HP and deals 33. Checks immediate end-of-combat defeat processing, initiative-only enrollment, and synthetic token polling without an updateActor hook.

**Important:** Turn-based credits are probabilistic attribution and should be reviewed in unexpected damage workflows. The GM console shows `PF1e Combat Stats | resource delta` with debug logging enabled.

## Tests to complete in Foundry before calling it stable

- [ ] Module enables with no init exceptions; menus and charts open.
- [ ] PC Vigor damage produces one damage-taken event with correct amount.
- [ ] Soak-only damage is recorded as Soak damage, not healing.
- [ ] Combined Soak/Vigor damage is grouped into one event when updates are part of a single application; test rapid consecutive attacks separately.
- [ ] Soak refill on turn start does not count as healing.
- [ ] Wounds damage and healing use correct PF1e 11.11 paths.
- [ ] Nevela's Automation Suite mitigation results in final applied-damage amounts (not raw roll damage).
- [ ] Damage applied by player shows up with active GM connected; test GM reconnect.
- [ ] Multiple targeted enemies don't cause false hit or attribution.
- [ ] Downed/dead PF1e statuses and token defeat flag transitions do not double trigger.
- [ ] Linked/unlinked tokens are distinct where needed.
- [ ] End fight once, refresh, and check persistence.
- [ ] Export/import `.xlsx` and JSON from settings; inspect generated values.
- [ ] Duplicate event safeguards under simultaneous client interactions.

## Known design caveats

- Actor resource increases are treated as healing only when attributed explicitly, by default (`strictHealing=true`).
- Raw damage, mitigation and overkill cannot be safely reconstructed from after-the-fact resource deltas.
- Default paths must be checked against PF1e actor documents. Alternate HP and Wounds/Vigor modes vary.
- Unattributed target damage is tracked on the **damage taken** side but does **not** earn damage dealt leaderboard credit.
- Some upstream UI columns represent unsupported metrics (overdamage/excess/overhealing); these are not synthesized.
- Kills and Summon attribution require further validation and can remain unattributed.
- The original Chart.js client behavior is replaced with bundled local drawing of bar, line and doughnut charts; tooltips are not identical.
- Never leave a custom source context queued across unrelated hits to the same target.

## Credits and license

Based on Combat Stats v4.0.0 by **Smantella**; redistributed with changes under **CC BY-SA 4.0**. See `ATTRIBUTION.md` and `LICENSE` and https://github.com/Smantella/combat-stats . All other combat modules remain independently owned; their source code was not copied.

## v1.0.0-rc5 tracking fixes

Combat participants are now registered as soon as they join an active combat, whether or not they have taken damage. Scene-token enemies damaged during a combat can be recorded even if omitted from initiative. Unlinked token actors are matched by their unique token-backed UUIDs.

Kills/downed transitions now have their own event path; the previous kill-credit code incorrectly required a damage or healing amount on a `downed` event, which was impossible. A combatant marked **Defeated** is considered a kill only when **Count defeated combatants as kills** is enabled (default on), or their `dead` condition is present. The NPC is included in the defeated list even if no attacker can be identified. Repeated updates do not create multiple kills.

**Automatic attack-source linking is conservative.** When someone clicks a Foundry PF1e chat card's Apply Damage button and the originating chat message explicitly lists target token IDs, the module associates that confirmed source speaker with ensuing *applied* changes to those target actors. Player clicks send the application context to the authoritative GM via Foundry socket, with server-side verification of the message and targets. This does **not** cover every Nevela/PF1e workflow, and does not guess from user target selections or chat rolls. For workflows that supply no explicit target-bearing chat card, use the verified `queueSource` API/macro or manually annotate damage in the GM interface. Do not count an observed change again as a separate manual damage event.

**Required live tests:** two different PCs damaging two separate enemies; an enemy outside initiative damaged on scene; an NPC with zero HP marked Defeated; player-client Apply Damage click; Soak refills; unlinked token actors; manual Wounds/Vigor healing; one downed creature that is later healed and downed again. Observe the Debug setting for why source attribution may be absent.

## rc3 fixes from live combat test (Daleira / Tangra / two Bloodlings)

- The actual console showed `tracker.js:114`, confirming the world was still loading rc1 rather than rc2. Check the module version and restart Foundry clients after updating.
- Registers all enrolled initiative combatants at fight start, even if they never roll or take damage.
- Strict initiative-only membership: scene enemies not in combat never enter the meter.
- Observes token synthetic-actor deltas through `updateToken` as well as actor updates.
- Preserves HP changes for NPCs with inactive but present Wounds/Vigor fields.
- Captures Apply Damage button source intent using the verified Nevela target order (controlled, targeted, message targets), then waits for actual resource changes before scoring damage.
- Enables the module Socket channel needed to forward player-side damage-click intent to the authoritative GM recorder.
- Keeps kill attribution limited to a verified recent source, and responds to combatant Defeated updates.
- Old fights cannot be retroactively repaired from insufficient event data; test these changes with a **new** encounter.

**Important:** Targeting or clicking Apply Damage is never counted as damage on its own. Source credit depends on a click-context match and an observed resource change. If damage is applied without a source signal, it stays unattributed; watch the diagnostic log and report both the Apply Damage workflow and the emitted event. The live environment has not yet been verified on rc3.

## rc5: Investigation and damage-tracking fixes

**This remains a testing release.** Changes relative to rc4:

- Uses unique Foundry Combatant document IDs for per-initiative member records (particularly important when two tokens share a world Actor ID).
- Prioritizes `combatant.token.actor` for v13 unlinked-token synthetic Actor reading rather than assuming world Actor data is up to date.
- Listens to v13 ActorDelta post-update events and reads explicit resource values from delta changes, even when token.actor has not yet rehydrated.
- Guards future ActorDelta snapshots against being reset by a poll of an old synthetic Actor (preventing duplicated damage).
- Keeps a 250 ms initiative-only poll and never adds off-initiative tokens.
- Adds an inspection API to diagnose which participants are registered and which resource values are readable.

Run this **while combat is underway**, as the GM, in browser Console or a Foundry script macro:

```js
console.table(game.modules.get('pf1e-combat-stats').api.getDiagnostics());
```

Compare `trackedSnapshot` with `currentHealth` and `matched` for each initiative combatant. If unlinked NPCs still fail to count HP damage, capture the table immediately after a hit and provide it with the console log.

**Attribution warning:** the setting `turnAttributionFallback` infers attacker from whose initiative turn it is when a verified actor source is unavailable. It can misattribute reactions, delayed effects and ready actions. The module does not currently calculate overkill correctly for Wounds/Vigor and cannot automatically recover events from earlier builds.



## v1.0.13 — complete initiative roster and credited kills

- **Everyone in initiative appears immediately**, including players/enemies with 0 damage dealt, 0 damage taken and 0 kills. Participants with temporarily unavailable synthetic actors get provisional roster entries that are filled in once Foundry resolves the actor.
- **Who counts as a PC/enemy?** Friendly token disposition (+1) puts the combatant in the player/ally section; hostile (-1) puts it in the enemy section. For other/unavailable dispositions, actor `type` (`character` vs `npc`) and player ownership serve as fallbacks. GM should ensure encounter token disposition reflects the desired side.
- Combat statistics use unique Combatant IDs for roster rows and full actor UUIDs for damage correlation. Two unlinked tokens sharing one world Actor remain distinct.
- The Charts menu now includes an **In Progress** fight while a combat is tracked, so you can see zero-damage participants before the fight ends. Reopen/refresh the menu for updated live numbers. Exports and history deletion operate on completed combats only.
- Player chat Apply Damage attribution sends a user ID in the socket payload. GM verifies it against the message author (or permits GM clicks) and the sender's ownership for non-GMs before associating any subsequent *observed* damage.
- An unconscious/dying enemy can later be marked Defeated: it gains one downed count and at most one kill. Kill attribution uses the last identified damaging source during the encounter, not a narrow 15-second timeout. If the source was inferred from initiative order, the kill credit is **inferred**, not verified.
- Max single hit records the largest captured *applied-resource loss* transaction, combining Soak/Vigor/Wounds where possible. It is not the raw attack-roll amount. Overkill remains unknowable when health is clamped at zero.
- Enable **Diagnostic logging** under settings and run `console.table(game.modules.get('pf1e-combat-stats').api.getDiagnostics())` to inspect roster/side/resource values. For accurate attribution validate damage from a player client as well as from the GM.

**Verification status:** Source parses, ZIP validation and local simulations passed, including an 8-combatant mixed-disposition encounter, client socket validation, repeated defeat transitions, and both Bloodling scenarios. Live Foundry/Nevela/Armor Soak testing is still required; this is not a guarantee of production behavior.

## v1.0.11 — Actor UUID combatant attribution

This version uses the **full Actor UUID** to correlate applied resource changes and source actions, with a stable **Combatant ID** to ensure only initiative participants appear in the fight report. For unlinked tokens the full UUID includes the scene and token identity. All combatants get zero-valued report rows even if they do not attack.

**Testing:** `console.table(game.modules.get('pf1e-combat-stats').api.getDiagnostics())` shows the Actor UUID, token UUID, Combatant ID, snapshot, and ActorDelta-aware health values for every initiative member. If the API is not present, the installed script is not this v1.0.11 build.

**Damage dealt:** When no explicit chat/automation source is available, the optional current-turn attribution setting (enabled by default) provides an *inferred* attacker; reactions and delayed effects can be miscredited. Damage taken still comes from actual resource changes.

**Kills:** A defeated marker credits the most recent attributed damaging hit within the active encounter, if one was identified. If no matching damaging event exists, the defeat is recorded with no killer.

**Max single hit:** Highest post-mitigation damage event, grouped across Soak/Vigor/Wounds where possible.

**Overkill:** Only recorded if the observed HP or Wounds resource falls below zero. When PF1e clamps values at zero, excess damage cannot be recovered from resource deltas alone; do not interpret zero as reliable overkill.

**Version continuity:** This was rebuilt from the provided rc5 source. If your deployed v1.0.10 had divergent local edits, reconcile those before overwriting it. Back up your world and test with Foundry 13.351 and PF1e 11.11.
