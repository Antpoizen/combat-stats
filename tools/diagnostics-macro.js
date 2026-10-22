// Run this as a Foundry Script macro during an active encounter.
// Read-only; does not change actors or combat statistics.
const stats = game.modules.get('pf1e-combat-stats')?.api;
if (!stats?.getDiagnostics) {
  ui.notifications.warn('PF1e Combat Stats rc5 or later is not active.');
} else if (!game.combat?.started) {
  ui.notifications.warn('Begin an encounter before running this diagnostic.');
} else {
  const rows=stats.getDiagnostics();
  console.group('PF1e Combat Stats — Initiative / Health Snapshot');
  console.table(rows);
  console.log(rows);
  console.groupEnd();
  ui.notifications.info(`Captured ${rows.length} combatant records in browser Console (F12).`);
}
