// The way back from an aircraft picked while an airport's Ops tab was open. The airport panel and the
// aircraft panel share one place on screen, so picking an aircraft replaces the airport's; the Ops
// tab goes on watching meanwhile (its traffic, the marks on the map) and the panel can return to the
// airport. These decide what happens, from the page's state ({ detail, detailTab, opsReturn }): the
// airport detail to return to is `opsReturn`. Pure, so that main.js only carries the decisions out.

// The airport detail to return to for an aircraft picked now: the one open on its Ops tab, or the one
// already being returned to while another aircraft is picked from the aircraft panel; else null.
export function opsReturnFor({ detail, detailTab, opsReturn }, item) {
  if (item?.kind !== 'aircraft') return null;
  if (detail?.airport && detailTab === 'ops') return detail;
  if (detail?.traffic) return opsReturn ?? null;
  return null;
}

// Whether the Ops tab keeps watching though the panel shows an aircraft.
export const opsKeepsWatching = ({ detail, opsReturn }) => Boolean(detail?.traffic && opsReturn);

// What the page does when the selected aircraft is deselected (another picked, the layer switched
// off, no longer received): null if no aircraft panel was open; else the panel closes and the way
// back goes, so that nothing is left watching for a panel that is not there.
export function afterDeselect({ detail }) {
  return detail?.traffic ? { detail: null, opsReturn: null } : null;
}

// What Escape does, in order: stop following; go back to the airport from an aircraft picked on its
// Ops tab, as the back button does; go back to the wind check; close the panel; else nothing.
export function escapeAction({ detail, opsReturn }, { following = false } = {}) {
  if (following) return 'stop-following';
  if (opsKeepsWatching({ detail, opsReturn })) return 'back-to-airport';
  if (detail?.fromList) return 'back-to-wind-check';
  if (detail) return 'close';
  return null;
}

// What the back button does: to the airport from such an aircraft, else to the wind check.
export const backAction = ({ detail, opsReturn }) => (opsKeepsWatching({ detail, opsReturn }) ? 'back-to-airport' : 'back-to-wind-check');
