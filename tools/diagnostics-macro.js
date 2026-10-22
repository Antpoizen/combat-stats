// Run this as a Foundry Script macro during an active encounter.
// Read-only; does not change actors or combat statistics.
const stats = game.modules.get('pf1e-combat-stats')?.api;
if (!stats?.getDiagnostics) {
  ui.notifications.warn('PF1e Combat Stats v1.0.13 or later is not active.');
} else if (!game.combat?.combatants?.some?.(c=>c.initiative != null) && !game.combat?.started) {
  ui.notifications.warn('Add combatants and roll initiative before running this diagnostic.');
} else {
  const rows=stats.getDiagnostics();
  console.group('PF1e Combat Stats — Initiative / Health Snapshot');
  console.table(rows);
  console.log(rows);
  console.groupEnd();
  ui.notifications.info(`Captured ${rows.length} combatant records in browser Console (F12).`);
}
