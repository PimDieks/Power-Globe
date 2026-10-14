// Storms and lightning for the Ops view: what the lightning module found near the airport, or
// where there is nothing of it, what the forecast says of thunderstorms, and the status fact made
// from them. Pure functions of the data, so they can be tested without a browser.
import { compassOf, isCovered, thunderstormRisk, uncovered } from './lightning.js';

// The status of the Ops strip for how near the lightning is, and for the forecast's risk.
export const LEVEL_STATUS = { none: 'ok', distant: 'caution', near: 'caution', close: 'nogo', overhead: 'nogo' };
export const RISK_STATUS = { none: 'ok', low: 'ok', moderate: 'caution', high: 'nogo' };

// The names the forecast uses for what the risk is made of.
const RISK_FIELDS = ['weather_code', 'cape', 'lifted_index'];

// What the forecast of an airport has for judging thunderstorms: the names of its fields.
export const riskFields = (hourly) => RISK_FIELDS.filter((name) => hourly?.[name]?.some((v) => v != null));

// The airport's lightning situation for one render. `result` is what the monitor last gave for this
// airport (see lightning.js), or null while there is none: `loading` is then true for a covered
// airport. The risk from the forecast is there whenever the forecast has the fields for it.
export function analyseLightning({ airport, hourly, now = Date.now(), result = null, hours = 6, timeZone }) {
  const lat = airport?.lat;
  const lon = airport?.lng;
  const covered = isCovered(lat, lon);
  const lightning = covered ? result : uncovered(lat, lon, now);
  const fields = riskFields(hourly);
  return {
    covered,
    lightning,
    loading: covered && !result,
    risk: fields.length ? thunderstormRisk(hourly, { now, hours, timeZone }) : null,
    fields,
  };
}

const TREND_WORDS = { rising: 'rising', steady: 'steady', falling: 'falling', none: 'no lightning', unknown: 'not enough images' };
export const trendText = (trend) => `Last 30 min ${TREND_WORDS[trend.min30]}, last 60 min ${TREND_WORDS[trend.min60]}`;

// The sentence about the movement of the nearest cell, or '' when there is none to say.
export function motionLine({ motion, status }) {
  const way = motion.headingDeg == null ? '' : `${compassOf(motion.headingDeg)} at ${motion.speedKmh} km/h`;
  switch (motion.state) {
    case 'approaching':
    case 'passing':
      return status.detail;
    case 'receding':
      return `Moving away, ${way}.`;
    case 'stationary':
      return 'Hardly moving.';
    case 'unclear':
      return `Movement unclear: ${motion.reason.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}.`;
    default:
      return '';
  }
}

const riskNote = (data) => (data.risk ? `${data.risk.text} (forecast)` : null);

// The one line for the status strip: { text, status }.
export function lightningFact(data) {
  const { lightning: r, risk } = data;
  if (r?.state === 'ok') {
    const old = r.stale ? `, data ${r.behindMin} min behind` : '';
    return { text: `${r.status.text}${old}`, status: LEVEL_STATUS[r.status.level] ?? 'unknown' };
  }
  const forecast = risk && riskNote(data);
  if (forecast) return { text: r?.state === 'uncovered' ? `${forecast}, no lightning data here` : forecast, status: RISK_STATUS[risk.level] ?? 'unknown' };
  if (data.loading) return { text: 'Loading lightning data', status: 'unknown' };
  if (r?.state === 'uncovered') return { text: 'Not covered here', status: 'unknown' };
  return { text: 'No lightning data', status: 'unknown' };
}
