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
