// What the map shows around the open airport for each tab of the airport panel, in one place: the
// airport map (runway colours, wind labels, ARR/DEP labels) and the parts' own overlays (lightning,
// traffic marks, roads) read it. It is only about the open airport's surroundings; the user's own
// settings (weather layer, wind flow, map style, flight layers) are never changed by it, and nothing
// here outlives the panel: with the panel closed there is no profile and the map is as it is.
//
//   runwayStatus  the open airport's runways coloured by whether the wind allows them, and the
//                 status on its labels; off draws plain outlines and bare runway names
//   windLabels    the wind label at the open airport
//   runwayUse     ARR and DEP on the runway ends the traffic uses
//   lightning     the lightning rings and image
//   trafficMarks  the inbound tints, holding marks and stacks on the aircraft
//   roads         road colours and jams (for the Access part, which draws them while its tab is open)
//
// A part that draws on the map declares `overlay` (its own key among the last three) and draws it
// only while its tab is bound and `api.mapProfile()` has that key on, so the table is the one place
// that says what is drawn (a test also keeps it in step with the parts' tabs). The aircraft sprites
// themselves are the user's flight layer and are left alone on every tab.
export const MAP_PROFILES = {
  details: { runwayStatus: true, windLabels: true, runwayUse: false, lightning: false, trafficMarks: false, roads: false },
  weather: { runwayStatus: true, windLabels: true, runwayUse: false, lightning: true, trafficMarks: false, roads: false },
  traffic: { runwayStatus: false, windLabels: false, runwayUse: true, lightning: false, trafficMarks: true, roads: false },
  access: { runwayStatus: false, windLabels: false, runwayUse: false, lightning: false, trafficMarks: false, roads: true },
};

export const mapProfileFor = (tab) => MAP_PROFILES[tab] ?? MAP_PROFILES.details;

// How the airport map draws one airport: the open airport as its tab's profile says, any other as
// always (and the open one too while no profile is set).
const AS_ALWAYS = { runwayStatus: true, windLabels: true, runwayUse: true };
export const airportView = (airport, selected, profile) => (profile && airport?.ident === selected?.ident ? profile : AS_ALWAYS);

// The text of a runway end's label: its name, the status icon that goes with the colours, and what
// traffic uses it, as the view allows. `use` is { tag } or null.
export function runwayEndText(ident, icon, use, view) {
  return [ident, view.runwayStatus ? icon : null, view.runwayUse && use ? use.tag : null].filter(Boolean).join(' ');
}
