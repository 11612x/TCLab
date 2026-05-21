/* Loads maritime GeoJSON layers used by route-engine.js */
(function () {
  const GRID_DEG = 2;
  const WATERWAY_BUFFER_KM = 2;
  const NEARBY_CELL_RADIUS = 1;

  let waterwaysNetwork = null;
  let landmassFeatures = null;
  let ecaFeatures = null;
  let segmentIndex = null;
  let landBboxIndex = null;
  let loadError = null;
  const segmentBufferCache = new Map();

  function normalizeAntimeridian(fc) {
    if (!fc?.features) return fc;
    for (const f of fc.features) {
      const coords = f.geometry?.coordinates;
      if (!coords) continue;
      const walk = (c) => {
        if (typeof c[0] === 'number') {
          if (c[0] === 180) c[0] = -180;
          return;
        }
        c.forEach(walk);
      };
      walk(coords);
    }
    return fc;
  }

  function cellKey(lon, lat) {
    const gx = Math.floor(lon / GRID_DEG);
    const gy = Math.floor(lat / GRID_DEG);
    return `${gx},${gy}`;
  }

  function cellsForBbox(west, south, east, north, pad) {
    const keys = new Set();
    const x0 = Math.floor(west / GRID_DEG) - pad;
    const x1 = Math.floor(east / GRID_DEG) + pad;
    const y0 = Math.floor(south / GRID_DEG) - pad;
    const y1 = Math.floor(north / GRID_DEG) + pad;
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        keys.add(`${gx},${gy}`);
      }
    }
    return keys;
  }

  function buildSegmentIndex(fc) {
    const index = new Map();
    let count = 0;
    for (const feature of fc.features) {
      const geom = feature.geometry;
      if (!geom || geom.type !== 'LineString') continue;
      const coords = geom.coordinates;
      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i];
        const b = coords[i + 1];
        const west = Math.min(a[0], b[0]);
        const east = Math.max(a[0], b[0]);
        const south = Math.min(a[1], b[1]);
        const north = Math.max(a[1], b[1]);
        const seg = { a, b, feature };
        for (const key of cellsForBbox(west, south, east, north, 0)) {
          if (!index.has(key)) index.set(key, []);
          index.get(key).push(seg);
        }
        count++;
      }
    }
    return { index, count };
  }

  function nearbySegments(lon, lat) {
    if (!segmentIndex) return [];
    const keys = cellsForBbox(lon, lat, lon, lat, NEARBY_CELL_RADIUS);
    const seen = new Set();
    const out = [];
    for (const key of keys) {
      const list = segmentIndex.index.get(key);
      if (!list) continue;
      for (const seg of list) {
        const id = seg.a[0] + ',' + seg.a[1] + '|' + seg.b[0] + ',' + seg.b[1];
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(seg);
      }
    }
    return out;
  }

  function segmentBufferPolygon(seg) {
    const id = seg.a[0] + ',' + seg.a[1] + '|' + seg.b[0] + ',' + seg.b[1];
    let buf = segmentBufferCache.get(id);
    if (!buf) {
      const line = turf.lineString([seg.a, seg.b]);
      buf = turf.buffer(line, WATERWAY_BUFFER_KM, { units: 'kilometers' });
      segmentBufferCache.set(id, buf);
    }
    return buf;
  }

  function pointInWaterwayCorridor(lon, lat) {
    if (typeof turf === 'undefined') return true;
    const pt = turf.point([lon, lat]);
    const segs = nearbySegments(lon, lat);
    for (const seg of segs) {
      if (turf.booleanPointInPolygon(pt, segmentBufferPolygon(seg))) return true;
    }
    return false;
  }

  function snapToWaterway(lon, lat) {
    if (typeof turf === 'undefined') return [lon, lat];
    const pt = turf.point([lon, lat]);
    if (pointInWaterwayCorridor(lon, lat)) return [lon, lat];

    const segs = nearbySegments(lon, lat);
    let best = null;
    let bestKm = Infinity;
    for (const seg of segs) {
      const line = turf.lineString([seg.a, seg.b]);
      const nearest = turf.nearestPointOnLine(line, pt, { units: 'kilometers' });
      const d = nearest.properties?.dist ?? Infinity;
      if (d < bestKm) {
        bestKm = d;
        best = nearest.geometry.coordinates;
      }
    }
    if (best) return best;
    return [lon, lat];
  }

  function pointOnLand(lon, lat) {
    if (!landmassFeatures?.length || typeof turf === 'undefined') return false;

    if (typeof rbush !== 'function') {
      if (!document.querySelector('script[data-arctium-rbush]')) {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/rbush@3.0.1/rbush.min.js';
        s.dataset.arctiumRbush = '1';
        document.head.appendChild(s);
      }
      const pt = turf.point([lon, lat]);
      for (const f of landmassFeatures) {
        if (turf.booleanPointInPolygon(pt, f)) return true;
      }
      return false;
    }

    if (!landBboxIndex) {
      const tree = rbush();
      const items = landmassFeatures.map((feature) => {
        const bbox = turf.bbox(feature);
        return {
          minX: bbox[0],
          minY: bbox[1],
          maxX: bbox[2],
          maxY: bbox[3],
          feature,
        };
      });
      tree.load(items);
      landBboxIndex = tree;
    }

    const pt = turf.point([lon, lat]);
    const nearby = landBboxIndex.search({ minX: lon, minY: lat, maxX: lon, maxY: lat });
    for (const item of nearby) {
      if (turf.booleanPointInPolygon(pt, item.feature)) return true;
    }
    return false;
  }

  function ecaZonesFromFeatureCollection(fc) {
    const zones = [];
    const features = [];
    for (const feat of fc.features) {
      const name = feat.properties?.name || 'Unknown ECA';
      const geom = feat.geometry;
      if (!geom) continue;
      features.push(feat);
      let ring;
      if (geom.type === 'Polygon') {
        ring = geom.coordinates[0];
      } else if (geom.type === 'MultiPolygon') {
        ring = geom.coordinates[0][0];
      } else {
        continue;
      }
      zones.push({
        name,
        polygon: ring.map(c => [Number(c[0]), Number(c[1])]),
      });
    }
    return { zones, features };
  }

  function geoAssetBase() {
    const scripts = document.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) {
      const src = scripts[i].src;
      if (src && /route-geo-loader\.js(?:\?|$)/.test(src)) {
        return new URL('.', src).href;
      }
    }
    return new URL('./', document.baseURI || window.location.href).href;
  }

  async function fetchGeoJson(file) {
    const url = new URL(file, geoAssetBase()).href;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      const hint = window.location.protocol === 'file:'
        ? ' Serve the app over HTTP (e.g. python3 -m http.server), not file://.'
        : '';
      throw new Error(`NetworkError loading ${file}${hint} (${e.message || e})`);
    }
    if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
    return normalizeAntimeridian(await res.json());
  }

  let geoLoaded = false;

  function constrainWaypoints(coords) {
    console.time('constrainWaypoints');
    console.log('[route] constraining waypoints:', coords?.length);
    try {
      if (!Array.isArray(coords) || coords.length < 2) return coords;
      const out = [];
      for (let i = 0; i < coords.length; i++) {
        let [lon, lat] = coords[i];
        if (!pointInWaterwayCorridor(lon, lat)) {
          [lon, lat] = snapToWaterway(lon, lat);
        }
        if (pointOnLand(lon, lat)) continue;
        const prev = out[out.length - 1];
        if (prev && prev[0] === lon && prev[1] === lat) continue;
        out.push([lon, lat]);
      }
      return out.length >= 2 ? out : coords;
    } finally {
      console.timeEnd('constrainWaypoints');
    }
  }

  const api = {
    ready: null,
    isReady: () => geoLoaded,
    error: null,
    getWaterwaysNetwork: () => waterwaysNetwork,
    getLandmassFeatures: () => landmassFeatures,
    getEcaFeatures: () => ecaFeatures,
    pointInWaterwayCorridor,
    snapToWaterway,
    pointOnLand,
    constrainWaypoints,
    get segmentCount() {
      return segmentIndex?.count ?? 0;
    },
  };

  api.ready = (async () => {
    if (typeof turf === 'undefined') {
      loadError = 'Turf.js not loaded';
      api.error = loadError;
      return false;
    }
    try {
      const waterways = await fetchGeoJson('2km.geojson');
      const landmass = await fetchGeoJson('landmass.geojson');
      const ecaWater = await fetchGeoJson('eca-zones-water.geojson');

      waterwaysNetwork = waterways;
      segmentIndex = buildSegmentIndex(waterways);
      landmassFeatures = landmass.features;

      const eca = ecaZonesFromFeatureCollection(ecaWater);
      window.ARCTIUM_ECA_ZONES = eca.zones;
      ecaFeatures = eca.features;

      geoLoaded = true;
      console.log(
        `[arctium-geo] waterways: ${waterways.features.length} features, ${segmentIndex.count} segments; ` +
        `landmass: ${landmassFeatures.length}; ECA: ${eca.zones.length}`
      );
      window.dispatchEvent(new Event('arctium-geo-ready'));
      return true;
    } catch (e) {
      loadError = e.message || String(e);
      api.error = loadError;
      console.error('[arctium-geo] load failed:', e);
      window.dispatchEvent(new Event('arctium-geo-ready'));
      return false;
    }
  })();

  window.ArctiumGeo = api;
})();
