# v1.0.13

- Complete initiative roster, including unresolved actor documents and zero-damage characters/enemies.
- Classify combat participants by token disposition first (+1 friendly, -1 hostile), with PF1e actor type/ownership fallbacks.
- Resolve full Actor UUID for damage and Combatant IDs for encounter-specific records.
- Allow client-to-GM chat attribution by sending a validated sender ID with socket payload; permit GM-initiated Apply clicks on player chat cards.
- Fix unconscious-to-Defeated transitions so downed and death events are distinct; award each target at most one kill.
- Retain last attributed damaging source throughout the active combat for deferred GM Defeated marks.
- Show the current (In Progress) combat in Charts, including zero-value roster entries; keep exports/history operations archived-only.
- Extend regression suite with eight initiative entries, two shared-actor Bloodlings, ActorDelta updates, player socket messages and kill transitions.
- Live Foundry 13.351 / PF1e 11.11 / Nevela / Armor Soak validation still required.

# v1.0.11

- Unified attacker/recipient identity around full Actor UUIDs, resolving initiative membership via Combatant IDs.
- Resolve live token document actors before stale combatant actors and handle v13 ActorDelta absolute overrides.
- Apply post-update resource fields directly even when synthetic actors lag behind.
- Register every initiative member even when damage and healing are zero.
- Track maximum single hit per verified/inferred applied damage transaction.
- Credit kills when defeated status follows a recently attributed hit; otherwise leave killer unattributed.
- Only calculate overkill when remaining HP/Wounds are verifiably negative; never infer from clamped bars.
- Expose getDiagnostics() and getRoster() for troubleshooting.

# v1.0.0-rc5

- Fix synthetic unlinked token identity using Combatant ID rather than base Actor ID.
- Observe ActorDelta post-update resource changes and prevent stale rehydration double-counts.
- Prefer authoritative Combatant.token.actor over world actor when available.
- Provide `api.getDiagnostics()` for in-world resource/identity troubleshooting.
- Expand offline tests for delayed ActorDelta synthetic actor updates.
- Still requires live Foundry v13.351/PF1e v11.11 integration validation.

# v1.0.0-rc4

- Fixed multiple unlinked tokens using the same base Actor ID collapsing into a single combatant. Combatant-scoped keys now distinguish Token IDs and display same-named NPCs as `Bloodling [1]` and `Bloodling [2]`.
- Added initiative-combatant-only 250 ms resource polling fallback for synthetic token ActorDelta updates not visible to the previous observer.
- Tracked source and target by combatant identity rather than resolving shared world Actor IDs.
- Added initiative-turn fallback for unmatched source damage (default on, marked `inferred-turn`). Documented the out-of-turn and delayed damage misattribution risk; can be disabled in settings.
- Reconciled resource changes and waited for pending downed/defeated events at combat end.
- Added offline reproduction of the October 21 Daleira/Tangra/two-Bloodlings encounter (57 dealt/61 taken for Daleira, 84 dealt by Tangra, Bloodlings 127 and 14 taken, and a kill).
- Version remains a runtime-unverified development release candidate.

# v1.0.0-rc3

- Fixed missing initiative roster members and excluded off-initiative tokens.
- Fixed HP delta omission when unused Wounds/Vigor paths coexist with HP.
- Added synthetic token update observation.
- Aligned Apply Damage chat source capture with NAS target selection order.
- Enabled module socket for player -> GM click attribution.
- Added initiative-gated manual recording and defeated transitions.
- Extended offline test suite and documented rc1 mismatch in live logs.
- Remains a test candidate requiring runtime verification.

# v1.0.0-rc2

- Register every combatant when combat starts and as combatants join, even at zero damage.
- Match unlinked and synthetic token actors by their unique token-backed UUID instead of ambiguous world actor IDs.
- Track damage against on-scene tokens even if the GM did not add them to the initiative tracker.
- Separate defeated/downed processing from damage and healing totals; previous kill-awarding branch was unreachable.
- Recognize combatant Defeated flags and confirmed dead conditions; only attribute a kill to an explicitly traced recent damage source.
- Add opt-in configurable treatment of Defeated as killed (default enabled).
- Add conservative chat-card Apply Damage attribution when the PF1e chat card declares exact affected token IDs; send verified card context to the GM recorder from player clients.
- Avoid inferring attackers from Easy Target selection alone; unattributed damage remains correctly recorded as damage taken.
- Expand manual event selector to include unlinked token combatants.
- Correct release metadata to https://github.com/Antpoizen/combat-stats.
- Offline tests expanded to verify roster, multi-character attribution, defeat deduplication, and source/event accounting.

**Still requires live Foundry testing:** Not every workflow exposes a chat-card source/target pair. In those workflows attacker attribution stays unattributed unless explicit context is provided. Never enter a manual event for a damage event that was already observed: use a source attribution macro or GM-confirmed correction instead.

# v1.0.0-rc1

- First PF1e proof-of-integration conversion from Combat Stats v4.0.0.
- Migrated upstream layout, charts, summary, settings and history UI under a separate module ID.
- Replaced D&D5e/Midi-QOL tracker with non-invasive active-GM resource observation for Soak, Vigor, Wounds and HP fallback.
- Added strict healing attribution, manual source queue API and manual event recording.
- Bundled local chart renderer and offline XLSX writer for simple spreadsheet output.
- Included attribution and testing documentation.
- This is a development candidate requiring world integration tests, not a verified production port.
