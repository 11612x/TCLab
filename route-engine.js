/* Shared maritime route + ECA distance engine (searoute-ts + 2km network + turf) */
(function () {
  const ECA_SUBDIVIDE_NM = 25;
  /** Commercial shipping — no Arctic / North Pole corridors. */
  const MAX_ROUTE_LAT_N = 70;
  const MIN_ROUTE_LAT_S = -60;
  const ARCTIC_PASSAGE_RESTRICTIONS = ['northwest', 'northeast'];
  const NETWORK_ANNOTATION_VERSION = 2;

  let routeEngineReady = false;
  let geoReady = false;
  let ecaPolygons = null;

  function waitForGeo() {
    const geo = window.ArctiumGeo;
    if (geo?.isReady?.()) {
      geoReady = true;
      return Promise.resolve(true);
    }
    if (geo?.ready) {
      return geo.ready.then((ok) => {
        geoReady = !!ok;
        return geoReady;
      });
    }
    return new Promise((resolve) => {
      const finish = () => {
        geoReady = !!window.ArctiumGeo?.isReady?.();
        resolve(geoReady);
      };
      window.addEventListener('arctium-geo-ready', finish, { once: true });
      setTimeout(finish, 120000);
    });
  }

  function waitForRouteEngine() {
    if (typeof window.searoute === 'function') {
      routeEngineReady = true;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        routeEngineReady = typeof window.searoute === 'function';
        resolve(routeEngineReady);
      };
      window.addEventListener('searoute-ready', finish, { once: true });
      const poll = setInterval(() => {
        if (typeof window.searoute === 'function') finish();
      }, 50);
      setTimeout(() => {
        clearInterval(poll);
        finish();
      }, 120000);
    });
  }

  function isValidCoordinatePair(coord) {
    if (!Array.isArray(coord) || coord.length < 2) return false;
    const lon = Number(coord[0]);
    const lat = Number(coord[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
    return true;
  }

  function validateWaypoints(coords) {
    if (!Array.isArray(coords) || coords.length < 2) {
      return { valid: false, message: 'Route has fewer than 2 waypoints after waterway constraint.' };
    }
    const geo = window.ArctiumGeo;
    for (let i = 0; i < coords.length; i++) {
      if (!isValidCoordinatePair(coords[i])) {
        return { valid: false, message: `Invalid coordinates at waypoint ${i + 1}.` };
      }
      const lon = Number(coords[i][0]);
      const lat = Number(coords[i][1]);
      if (geo?.pointOnLand?.(lon, lat)) {
        return {
          valid: false,
          message: `Waypoint ${i + 1} falls on land — route could not be constrained to waterways.`,
        };
      }
      if (geo?.pointInWaterwayCorridor && !geo.pointInWaterwayCorridor(lon, lat)) {
        return {
          valid: false,
          message: `Waypoint ${i + 1} is outside the 2 km waterway network.`,
        };
      }
      if (lat > MAX_ROUTE_LAT_N) {
        return {
          valid: false,
          message: `Waypoint ${i + 1} is above ${MAX_ROUTE_LAT_N}°N — Arctic routing is not allowed.`,
        };
      }
      if (lat < MIN_ROUTE_LAT_S) {
        return {
          valid: false,
          message: `Waypoint ${i + 1} is below ${MIN_ROUTE_LAT_S}°S.`,
        };
      }
    }
    return { valid: true };
  }

  function portCoords(p) {
    return [Number(p.lon), Number(p.lat)];
  }

  function isValidPort(p) {
    if (!p) return false;
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    if (Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01) return false;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
    return true;
  }

  function haversineNM(lat1, lon1, lat2, lon2) {
    const R = 3440.065;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function waypointsLengthNM(waypoints) {
    let total = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i];
      const b = waypoints[i + 1];
      total += haversineNM(a[1], a[0], b[1], b[0]);
    }
    return total;
  }

  function initECA() {
    const ecaFeatures = window.ArctiumGeo?.getEcaFeatures?.();
    if (ecaFeatures?.length && typeof turf !== 'undefined') {
      ecaPolygons = ecaFeatures;
      return;
    }
    const zones = window.ARCTIUM_ECA_ZONES;
    if (!zones?.length || typeof turf === 'undefined') return;
    ecaPolygons = zones.map(z => turf.polygon([[...z.polygon, z.polygon[0]]]));
  }

  function constrainWaypoints(coords) {
    const geo = window.ArctiumGeo;
    if (!geo?.constrainWaypoints) return coords;
    return geo.constrainWaypoints(coords);
  }

  function directLineCrossesLand(from, to) {
    const landmass = window.ArctiumGeo?.getLandmassFeatures?.();
    if (!landmass?.length || typeof turf === 'undefined') return true;
    const line = turf.lineString([[from[0], from[1]], [to[0], to[1]]]);
    for (const land of landmass) {
      const hits = turf.lineIntersect(line, land);
      if (hits?.features?.length > 0) return true;
    }
    return false;
  }

  function greatCircleNMForDirectLine(from, to) {
    if (directLineCrossesLand(from, to)) return null;
    return haversineNM(from[1], from[0], to[1], to[0]);
  }

  /** Passage bboxes for gate checks (aligned with searoute-ts). [minLon, minLat, maxLon, maxLat] */
  const PASSAGE_BBOXES = {
    suez: [[32.0, 29.5, 32.9, 31.5]],
    panama: [[-80.2, 8.85, -79.3, 9.45]],
    babelmandeb: [[42.9, 12.3, 43.6, 13.0]],
    gibraltar: [[-5.95, 35.7, -5.2, 36.2]],
    malacca: [[99.0, 1.0, 104.0, 6.0]],
    northwest: [[-130.0, 66.0, -60.0, 80.0]],
    northeast: [[30.0, 68.0, 180.0, 82.0]],
  };

  const ROUTE_RESTRICTION_VARIANTS = [
    [],
    ['suez', 'babelmandeb'],
    ['panama'],
    ['suez', 'babelmandeb', 'panama'],
    ['malacca'],
    ['gibraltar'],
    ['panama', 'malacca'],
  ];

  let networkPassagesAnnotated = false;

  function pointInBbox(lon, lat, bbox) {
    return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
  }

  function edgeIntersectsBboxes(a, b, bboxes) {
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const lon = a[0] + (b[0] - a[0]) * t;
      const lat = a[1] + (b[1] - a[1]) * t;
      for (const bb of bboxes) {
        if (pointInBbox(lon, lat, bb)) return true;
      }
    }
    return false;
  }

  /** 2km.geojson has no `pass` tags — annotate once so restrictions (canals + Arctic) apply. */
  function prepareRoutingNetwork(network) {
    if (!network?.features?.length) return network;
    if (network.__arctiumAnnotationVersion === NETWORK_ANNOTATION_VERSION) return network;

    for (const feature of network.features) {
      const geom = feature.geometry;
      if (!geom || geom.type !== 'LineString' || !geom.coordinates?.length) continue;
      const coords = geom.coordinates;
      let tagged = false;

      for (const c of coords) {
        const lat = Number(c[1]);
        if (Number.isFinite(lat) && lat > MAX_ROUTE_LAT_N) {
          feature.properties = feature.properties || {};
          feature.properties.pass = 'northwest';
          tagged = true;
          break;
        }
      }

      if (!tagged) {
        for (const passage of Object.keys(PASSAGE_BBOXES)) {
          const bboxes = PASSAGE_BBOXES[passage];
          for (let i = 0; i < coords.length - 1; i++) {
            if (edgeIntersectsBboxes(coords[i], coords[i + 1], bboxes)) {
              feature.properties = feature.properties || {};
              feature.properties.pass = passage;
              tagged = true;
              break;
            }
          }
          if (tagged) break;
        }
      }
    }

    network.__arctiumAnnotationVersion = NETWORK_ANNOTATION_VERSION;
    if (!networkPassagesAnnotated) {
      networkPassagesAnnotated = true;
      if (typeof window.clearSearouteCache === 'function') window.clearSearouteCache();
    }
    return network;
  }

  function latitudeGateError(waypoints) {
    if (!waypoints?.length) return null;
    for (let i = 0; i < waypoints.length; i++) {
      const lat = Number(waypoints[i][1]);
      if (!Number.isFinite(lat)) continue;
      if (lat > MAX_ROUTE_LAT_N) {
        return `Route cannot go above ${MAX_ROUTE_LAT_N}°N (Arctic and polar routes are excluded).`;
      }
      if (lat < MIN_ROUTE_LAT_S) {
        return `Route cannot go below ${MIN_ROUTE_LAT_S}°S.`;
      }
    }
    return null;
  }

  function passagesAlongWaypoints(waypoints) {
    const hit = new Set();
    for (const c of waypoints) {
      const lon = Number(c[0]);
      const lat = Number(c[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      for (const name of Object.keys(PASSAGE_BBOXES)) {
        if (hit.has(name)) continue;
        if (PASSAGE_BBOXES[name].some(bb => pointInBbox(lon, lat, bb))) hit.add(name);
      }
    }
    return [...hit];
  }

  function passagesHas(passages, name) {
    return Array.isArray(passages) && passages.includes(name);
  }

  /** Mandatory gates: Use = must transit canal; Avoid = must not transit. */
  function canalGateError(passages, useSuez, usePanama) {
    if (useSuez && !passagesHas(passages, 'suez')) {
      return 'Route must transit Suez Canal (Use selected).';
    }
    if (!useSuez && passagesHas(passages, 'suez')) {
      return 'Route must not transit Suez Canal (Avoid selected).';
    }
    if (usePanama && !passagesHas(passages, 'panama')) {
      return 'Route must transit Panama Canal (Use selected).';
    }
    if (!usePanama && passagesHas(passages, 'panama')) {
      return 'Route must not transit Panama Canal (Avoid selected).';
    }
    return null;
  }

  function mergeRestrictions(...lists) {
    return [...new Set(lists.flat())];
  }

  function invokeSearoute(from, to, restrictions, network) {
    const allRestrictions = mergeRestrictions(ARCTIC_PASSAGE_RESTRICTIONS, restrictions);
    const options = {
      units: 'nauticalmiles',
      returnPassages: true,
      allowArctic: false,
      network,
      restrictions: allRestrictions,
    };
    return window.searoute(from, to, options);
  }

  function legFromSearouteResult(result, from, to) {
    let coords = result?.geometry?.coordinates;
    coords = constrainWaypoints(coords);
    const check = validateWaypoints(coords);
    if (!check.valid) return { error: check.message };
    const routeNM = waypointsLengthNM(coords);
    if (!Number.isFinite(routeNM) || routeNM < 1) {
      return { error: 'Route length invalid after waterway constraint — verify port coordinates.' };
    }
    const latErr = latitudeGateError(coords);
    if (latErr) return { error: latErr };

    const passages = passagesAlongWaypoints(coords);
    return {
      waypoints: coords,
      routeNM,
      greatCircleNM: greatCircleNMForDirectLine(from, to),
      passages,
    };
  }

  function collectRouteCandidates(from, to, network, useSuez, usePanama) {
    const candidates = [];
    const seen = new Set();

    function addCandidate(result) {
      const leg = legFromSearouteResult(result, from, to);
      if (leg.error) return;
      const key = leg.waypoints.map(c => `${c[0].toFixed(3)},${c[1].toFixed(3)}`).join('|');
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(leg);
    }

    const restrictionSets = new Set();
    restrictionSets.add(JSON.stringify([]));
    if (!useSuez) restrictionSets.add(JSON.stringify(['suez', 'babelmandeb']));
    if (!usePanama) restrictionSets.add(JSON.stringify(['panama']));
    if (!useSuez && !usePanama) restrictionSets.add(JSON.stringify(['suez', 'babelmandeb', 'panama']));
    for (const extra of ROUTE_RESTRICTION_VARIANTS) {
      restrictionSets.add(JSON.stringify(extra));
      if (!useSuez) restrictionSets.add(JSON.stringify(mergeRestrictions(extra, ['suez', 'babelmandeb'])));
      if (!usePanama) restrictionSets.add(JSON.stringify(mergeRestrictions(extra, ['panama'])));
    }

    for (const key of restrictionSets) {
      const restrictions = JSON.parse(key);
      try {
        addCandidate(invokeSearoute(from, to, restrictions, network));
      } catch (_) {}
    }

    const altFn = window.searouteAlternatives;
    if (typeof altFn === 'function') {
      try {
        const alts = altFn(from, to, {
          units: 'nauticalmiles',
          returnPassages: true,
          allowArctic: false,
          restrictions: ARCTIC_PASSAGE_RESTRICTIONS,
          network,
          k: 12,
          similarityThreshold: 0.005,
        });
        for (const alt of alts) addCandidate(alt);
      } catch (e) {
        console.warn('[route-engine] searouteAlternatives failed', e);
      }
    }

    return candidates;
  }

  function buildRoute(from, to, { suez = true, panama = true } = {}) {
    if (!routeEngineReady || typeof window.searoute !== 'function') {
      return { error: 'Routing engine not loaded.' };
    }
    if (!geoReady) {
      return { error: 'Maritime geo layers not loaded (2km waterways / landmass / ECA).' };
    }

    const rawNetwork = window.ArctiumGeo?.getWaterwaysNetwork?.();
    if (!rawNetwork?.features?.length) {
      return { error: '2 km waterway network not available.' };
    }

    const network = prepareRoutingNetwork(rawNetwork);
    const useSuez = !!suez;
    const usePanama = !!panama;

    try {
      const candidates = collectRouteCandidates(from, to, network, useSuez, usePanama);
      const valid = candidates.filter(leg => {
        if (latitudeGateError(leg.waypoints)) return false;
        return !canalGateError(leg.passages, useSuez, usePanama);
      });

      if (valid.length) {
        valid.sort((a, b) => a.routeNM - b.routeNM);
        return valid[0];
      }

      const errors = [];
      if (useSuez) errors.push('via Suez');
      if (!useSuez) errors.push('avoiding Suez');
      if (usePanama) errors.push('via Panama');
      if (!usePanama) errors.push('avoiding Panama');
      return {
        error: `No route found ${errors.join(' and ')} for this voyage.`,
      };
    } catch (e) {
      console.warn('searoute failed', from, to, e);
      return { error: e.message || 'Route calculation failed.' };
    }
  }

  function calculateECADistance(waypoints, routeNM) {
    const zones = window.ARCTIUM_ECA_ZONES || [];
    if (!ecaPolygons?.length) initECA();
    if (!ecaPolygons?.length) {
      return { ecaNM: 0, nonEcaNM: routeNM, totalNM: routeNM, zonesHit: [] };
    }

    let ecaNM = 0;
    let haversineTotal = 0;
    const zonesHit = new Set();
    for (let i = 0; i < waypoints.length - 1; i++) {
      const from = waypoints[i];
      const to = waypoints[i + 1];
      const segNM = haversineNM(from[1], from[0], to[1], to[0]);
      haversineTotal += segNM;
      const steps = Math.max(1, Math.ceil(segNM / ECA_SUBDIVIDE_NM));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        const lon0 = from[0] + t0 * (to[0] - from[0]);
        const lat0 = from[1] + t0 * (to[1] - from[1]);
        const lon1 = from[0] + t1 * (to[0] - from[0]);
        const lat1 = from[1] + t1 * (to[1] - from[1]);
        const subNM = haversineNM(lat0, lon0, lat1, lon1);
        const mid = turf.point([(lon0 + lon1) / 2, (lat0 + lat1) / 2]);
        ecaPolygons.forEach((poly, idx) => {
          if (turf.booleanPointInPolygon(mid, poly)) {
            ecaNM += subNM;
            const name = zones[idx]?.name || poly.properties?.name;
            if (name) zonesHit.add(name);
          }
        });
      }
    }
    const scale = haversineTotal > 0 ? routeNM / haversineTotal : 1;
    ecaNM *= scale;
    return { ecaNM, nonEcaNM: routeNM - ecaNM, totalNM: routeNM, zonesHit: [...zonesHit] };
  }

  async function calculateLegRoute(fromPort, toPort, canalOpts = { suez: true, panama: true }) {
    if (!isValidPort(fromPort) || !isValidPort(toPort)) {
      return { error: 'Invalid port coordinates.' };
    }
    await Promise.all([waitForRouteEngine(), waitForGeo()]);
    if (!routeEngineReady) {
      return { error: 'Routing engine not loaded. Check network and refresh.' };
    }
    if (!geoReady) {
      const err = window.ArctiumGeo?.error;
      return { error: err || 'Maritime geo layers failed to load.' };
    }
    initECA();

    const leg = buildRoute(portCoords(fromPort), portCoords(toPort), canalOpts);
    if (leg.error) return { error: leg.error };

    try {
      const eca = calculateECADistance(leg.waypoints, leg.routeNM);
      return {
        totalNM: eca.totalNM,
        ecaNM: eca.ecaNM,
        nonEcaNM: eca.nonEcaNM,
        zonesHit: eca.zonesHit,
        passages: leg.passages,
        greatCircleNM: leg.greatCircleNM ?? null,
        waypoints: leg.waypoints,
      };
    } catch (e) {
      return { error: 'ECA analysis failed: ' + (e.message || 'unknown error') };
    }
  }

  function computeSeaFuelMT({ nonEcaNM, ecaNM, speedKn, mtPerDay }) {
    return computeSeaFuelMTSplit({
      nonEcaNM,
      ecaNM,
      speedKn,
      vlsfoMtPerDay: mtPerDay,
      lsmgoMtPerDay: mtPerDay,
    });
  }

  function computeSeaFuelMTSplit({ nonEcaNM, ecaNM, speedKn, vlsfoMtPerDay, lsmgoMtPerDay }) {
    if (speedKn <= 0) return { vlsfoMT: 0, lsmgoMT: 0, lsmgoSeaMT: 0, seaDays: 0 };
    const totalNM = nonEcaNM + ecaNM;
    const seaDays = totalNM / (speedKn * 24);
    const dayFactor = 1 / (speedKn * 24);
    const vlsfoMT = vlsfoMtPerDay > 0 ? nonEcaNM * dayFactor * vlsfoMtPerDay : 0;
    const lsmgoSeaMT = lsmgoMtPerDay > 0 ? ecaNM * dayFactor * lsmgoMtPerDay : 0;
    return { vlsfoMT, lsmgoMT: lsmgoSeaMT, lsmgoSeaMT, seaDays };
  }

  function greatCircleNM(lat1, lon1, lat2, lon2) {
    return haversineNM(Number(lat1), Number(lon1), Number(lat2), Number(lon2));
  }

  function mergeRouteWaypoints(segments) {
    const merged = [];
    for (const coords of segments) {
      if (!coords?.length) continue;
      if (!merged.length) {
        merged.push(...coords);
        continue;
      }
      let start = 0;
      const last = merged[merged.length - 1];
      const first = coords[0];
      if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) start = 1;
      merged.push(...coords.slice(start));
    }
    return merged;
  }

  async function calculateMultiLegRoute(ports, canalOpts = { suez: true, panama: true }) {
    if (!Array.isArray(ports) || ports.length < 2) {
      return { error: 'At least two ports required.' };
    }
    for (const p of ports) {
      if (!isValidPort(p)) return { error: 'Invalid port coordinates.' };
    }
    await Promise.all([waitForRouteEngine(), waitForGeo()]);
    if (!routeEngineReady) {
      return { error: 'Routing engine not loaded. Check network and refresh.' };
    }
    if (!geoReady) {
      const err = window.ArctiumGeo?.error;
      return { error: err || 'Maritime geo layers failed to load.' };
    }
    initECA();

    const legResults = [];
    let totalNM = 0;
    let gcNM = null;
    let gcSum = 0;
    const passageSet = new Set();
    const segmentCoords = [];

    for (let i = 0; i < ports.length - 1; i++) {
      const fromPort = ports[i];
      const toPort = ports[i + 1];
      const leg = buildRoute(portCoords(fromPort), portCoords(toPort), canalOpts);
      if (leg.error) {
        const fromName = fromPort.name || fromPort.port_name_full || 'Port';
        const toName = toPort.name || toPort.port_name_full || 'Port';
        return { error: `${fromName} → ${toName}: ${leg.error}` };
      }
      const legGcNM = leg.greatCircleNM ?? null;
      legResults.push({
        fromPort,
        toPort,
        routeNM: leg.routeNM,
        gcNM: legGcNM,
        passages: leg.passages || [],
      });
      totalNM += leg.routeNM;
      if (legGcNM != null) {
        gcSum += legGcNM;
      }
      (leg.passages || []).forEach(p => passageSet.add(p));
      segmentCoords.push(leg.waypoints);
    }
    if (legResults.length > 0 && legResults.every(leg => leg.gcNM != null)) {
      gcNM = gcSum;
    }

    const waypoints = mergeRouteWaypoints(segmentCoords);
    try {
      const eca = calculateECADistance(waypoints, totalNM);
      return {
        legResults,
        waypoints,
        totalNM: eca.totalNM,
        gcNM,
        ecaNM: eca.ecaNM,
        nonEcaNM: eca.nonEcaNM,
        zonesHit: eca.zonesHit,
        passages: [...passageSet],
      };
    } catch (e) {
      return { error: 'ECA analysis failed: ' + (e.message || 'unknown error') };
    }
  }

  const ready = Promise.all([waitForRouteEngine(), waitForGeo()]).then(([routeOk, geoOk]) => {
    if (routeOk && geoOk) {
      if (typeof window.clearSearouteCache === 'function') {
        window.clearSearouteCache();
      }
      initECA();
    }
    return routeOk && geoOk;
  });

  window.ArctiumRouteEngine = {
    ready,
    isReady: () => typeof window.searoute === 'function' && !!window.ArctiumGeo?.isReady?.(),
    MAX_ROUTE_LAT_N,
    MIN_ROUTE_LAT_S,
    calculateLegRoute,
    calculateMultiLegRoute,
    computeSeaFuelMT,
    computeSeaFuelMTSplit,
    greatCircleNM,
    mergeRouteWaypoints,
    isValidPort,
  };
})();
