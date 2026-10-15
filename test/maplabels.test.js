import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupMapFeatures } from '../src/map.js';
import { setupRunways } from '../src/runwaymap.js';

// Just enough of an element for the labels.
const element = () => ({ style: {}, setAttribute() {}, append() {}, addEventListener() {} });

// A globe whose setters can be chained, and which keeps the HTML elements it is given.
function fakeGlobe() {
  const scene = { children: [], add: (obj) => scene.children.push(obj) };
  const globe = new Proxy(
    { html: [], scene: () => scene, getGlobeRadius: () => 100 },
    {
      get(target, name) {
        if (name in target) return target[name];
        if (name === 'htmlElementsData') return (data) => ((target.html = data), globe);
        return () => globe;
      },
    },
  );
  return globe;
}

const runwayLabel = (ident, overrides = {}) => ({ key: `EHAM:${ident}:ok::${ident} ✓`, kind: 'runway', status: 'ok', use: false, text: `${ident} ✓`, title: `Runway ${ident}: Within limits`, lat: 52.3, lng: 4.76, ...overrides });

describe('the runway labels on the map', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: element, body: { classList: { toggle() {} } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the element of a label that shows the same, and moves it to its new place', () => {
    const globe = fakeGlobe();
    const features = setupMapFeatures(globe);
    features.setRunwayLabels([runwayLabel('18R'), runwayLabel('36L')]);
    const [first, second] = globe.html.filter((d) => d.kind === 'runway');
    features.setRunwayLabels([runwayLabel('18R', { lat: 52.31 }), runwayLabel('36L', { status: 'caution', text: '36L !' })]);
    const [again, changed] = globe.html.filter((d) => d.kind === 'runway');
    expect(again).toBe(first);
    expect(again.el).toBe(first.el);
    expect(again.lat).toBe(52.31);
    expect(changed).not.toBe(second);
    expect(changed.el).not.toBe(second.el);
  });

  it('does not tell the globe of the same wind check markers again', () => {
    const globe = fakeGlobe();
    const features = setupMapFeatures(globe);
    const airport = { ident: 'EHAM', iata: 'AMS', name: 'Schiphol', lat: 52.3, lng: 4.76 };
    features.setAirports([{ airport, status: 'nogo' }], () => {});
    const shown = globe.html;
    features.setAirports([{ airport, status: 'nogo' }], () => {});
    expect(globe.html).toBe(shown);
    features.setAirports([{ airport, status: 'caution' }], () => {});
    expect(globe.html).not.toBe(shown);
  });
});

describe('the runways on the map', () => {
  const strips = (status) => [{ ends: [{ lat: 52.3, lng: 4.7 }, { lat: 52.33, lng: 4.7 }], widthFt: 150, status }];

  it('keeps the shapes when only the colours change, and writes the colours in place', () => {
    const globe = fakeGlobe();
    const runways = setupRunways(globe);
    const [outline, strip] = globe.scene().children;
    runways.draw(strips('ok'), 2);
    const geometry = strip.geometry;
    const outlineGeometry = outline.geometry;
    const color = geometry.getAttribute('color');
    const version = color.version;
    runways.draw(strips('nogo'), 2);
    expect(strip.geometry).toBe(geometry);
    expect(outline.geometry).toBe(outlineGeometry);
    expect(color.version).toBe(version + 1);
    expect(color.array[0]).toBeCloseTo(1);
    // The same again: nothing to do.
    runways.draw(strips('nogo'), 2);
    expect(color.version).toBe(version + 1);
    // A new scale makes new shapes.
    runways.draw(strips('nogo'), 3);
    expect(strip.geometry).not.toBe(geometry);
  });
});
