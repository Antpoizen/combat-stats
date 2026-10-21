# PF1e Combat Stats — v1.0.0-rc1 (development / integration-test build)

A Pathfinder 1e (system **11.11**) adaptation of **Combat Stats v4.0.0**, originally by **Smantella**. Targets **Foundry 13.351**. Active PF1e required; **no D&D5e or Midi-QOL dependency**.

**This is a development/validation candidate, NOT a fully runtime-tested release.** Tested off-line: JS syntax, JSON, resource accounting, locally generated XLSX via Python/openpyxl. Needs actual Foundry v13.351 + PF1e v11.11 + Nevela + Armor Soak integration testing before production. Do not publish as a stable release until the checklist is completed.

## How the module works

- Reuses the upstream Combat Stats charts window, combat recap presentation, settings/theme UI, English/Italian localization, historical fight records, and the spreadsheet export layout.
- Automatically observes **actual** decreases of supported actor resource fields during an active combat, rather than roll messages.
- Tracks separate Soak, Vigor, Wounds, and HP fallback damage, and distinguishes automatic **Soak increases** from healing.
- Uses an active GM as authoritative recorder; does not replace or patch `ActorPF.applyDamage`, libWrapper, PF1e's damage system, Nevela's Automation Suite, or Armor Soak.
- Creates per-combat statistics and summary when combat is deleted. A Charts tool is added to scene controls.
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
| Attribute attacker automatically | **Not verified**; ambiguous damage counts as damage taken but is NOT credited to a guessed attacker |
| Confirmed kills/downed | Defeated/downed transition support exists but requires live-world validation; strict linking to recent explicitly attributed damage |
| Multiplayer GM observation | Implemented as active GM `updateActor` hook listener; not runtime-tested |
| Summon/polymorph attribution | Manual/explicit only; do not enable legacy speculative attribution |
| Overkill/overheal/excess | Not calculated unless exact verified pre/post amount becomes available; displayed zeros are not proof of absent damage |
| Persistence | World settings, current combat and completed history. Active encounter interrupted before deletion is retained |
| XLSX export | Verified offline via `openpyxl`; local OOXML writer |
| Localization | Original English and Italian retained; new integration controls currently English only |

Because the upstream ZIP did not include README/LICENSE, full upstream license review should be completed prior to public publication. The upstream `module.json` declares CC-BY-SA-4.0; this derivative retains attribution and share-alike notice.

## Install

1. Back up your world.
2. Install `pf1e-combat-stats/` in Foundry `Data/modules`, or attach `module.json` + the matching ZIP to a GitHub **v1.0.0-rc1** release.
3. Enable the module in a PF1e 11.11 world running Foundry 13.351.
4. Configure **Vigor resource path**, **Wounds resource path**, and **HP fallback** in module settings after inspecting one PC and one NPC.
5. Begin a new combat; apply damage as usual. The GM's client must be online and active.
6. End/delete the combat tracker encounter to save the history and see the summary.
7. Open scene-control **PF1e Combat Stats → Charts** or call `game.modules.get("pf1e-combat-stats").api.openCharts()`.

## How to associate an attacker with damage

The tracker never infers responsibility from Easy Target alone. For workflows that don't supply a trustworthy source, use the GM **Record verified event** tool, but be careful: a manual event is **added** to statistics and would duplicate an automatic resource observation if both are used. For an automated event with no source, update the event attribution rather than adding a duplicate; that UI is not yet implemented.

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
