/*
 * WeatherKit27.response.js
 * WeatherKit27 QWeather-only adapter for Surge / iOS 27 Weather.app.
 *
 * Scope:
 * - Provider is QWeather only: /v7/air/now + /v7/minutely/5m.
 * - Keeps iOS27 WK2.Weather 16-field root. No full FlatBuffer rebuild.
 * - AQI: in-place scalar patch for existing WK2.AirQuality.
 * - Precipitation: in-place patch for existing forecastHourly precipitation scalar fields.
 * - v1.4 can experimentally add missing root field4 forecastNextHour from AU iOS27 template when NextHourCard=1 and QWeather says it is raining now.
 */
(() => {
  const NAME = 'WeatherKit27.response';
  const LEVEL = { OFF:0, ERROR:1, WARN:2, INFO:3, DEBUG:4, ALL:5 };
  const DEFAULT = {
    'API.QWeather.Host': 'devapi.qweather.com',
    'API.QWeather.Token': '',
    'AirQuality.Calculate.Algorithm': 'QWeather_CN_AQI',
    'AQIStandard': 'QWeather_CN_AQI',
    'AQITextPatch': '1',
    'NextHourCard': '0',
    'NextHourCardMode': 'TemplateAU',
    'Provider.CacheTTL': '1800',
    'Provider.LiveFetch': '1',
    'Provider.LiveTimeout': '1600',
    'Provider.PatchMode': 'InjectAll',
    'Precipitation.Hours': '12',
    'AQILabelPatch': '1',
    'AQILabelMode': 'QWeather',
    'LogLevel': 'INFO',
    'DebugNotify': '0'
  };

  function parseArgs(s) {
    const o = Object.assign({}, DEFAULT);
    String(s || '').split('&').forEach(p => {
      const i = p.indexOf('=');
      if (i > 0) o[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1)).replace(/^"|"$/g, '');
    });
    return o;
  }
  const ARG = parseArgs(typeof $argument === 'string' ? $argument : '');
  const LOG = LEVEL[String(ARG.LogLevel || 'INFO').toUpperCase()] ?? 3;
  function log(l, m) { if (LOG >= LEVEL[l]) console.log(`[${NAME}] ${m}`); }
  function notify(t, s, b) { if (ARG.DebugNotify === '1' && typeof $notification !== 'undefined') $notification.post(t, s, b); }

  function hget(headers, key) {
    const low = key.toLowerCase();
    for (const k in (headers || {})) if (String(k).toLowerCase() === low) return String(headers[k] || '');
    return '';
  }
  function asU8(body) {
    if (!body) return new Uint8Array(0);
    if (body instanceof Uint8Array) return body;
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView && ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (typeof body === 'string') { const a = new Uint8Array(body.length); for (let i = 0; i < body.length; i++) a[i] = body.charCodeAt(i) & 255; return a; }
    return new Uint8Array(0);
  }
  function u16(b, o) { return (b[o] | (b[o + 1] << 8)) >>> 0; }
  function setU16(b, o, v) { v = Math.max(0, Math.min(65535, Math.round(Number(v) || 0))); b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function i32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) | 0; }
  function setF32(b, o, v) { new DataView(b.buffer, b.byteOffset + o, 4).setFloat32(0, Number(v) || 0, true); }
  function setI32(b, o, v) { v = Math.round(Number(v) || 0); b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; }
  function setU32(b, o, v) { v = Math.max(0, Math.round(Number(v) || 0)); b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; }
  function validPos(b, p, n = 1) { return p >= 0 && p + n <= b.length; }

  function inspectTable(b, tablePos) {
    if (!validPos(b, tablePos, 4)) return { ok:false, reason:'bad table pos' };
    const vt = tablePos - i32(b, tablePos);
    if (!validPos(b, vt, 4)) return { ok:false, reason:`bad vtable ${vt}` };
    const vtLen = u16(b, vt), objSize = u16(b, vt + 2);
    if (vtLen < 4 || vtLen > 512 || !validPos(b, vt, vtLen)) return { ok:false, reason:`bad vtLen ${vtLen}` };
    const fieldCount = (vtLen - 4) >> 1;
    const present = [];
    for (let i = 0; i < fieldCount; i++) if (u16(b, vt + 4 + i * 2)) present.push(i);
    return { ok:true, tablePos, vt, vtLen, objSize, fieldCount, present };
  }
  function inspectRoot(b) {
    if (!b || b.length < 12) return { ok:false, reason:'too small' };
    const root = u32(b, 0);
    if (!validPos(b, root, 4)) return { ok:false, reason:`bad root ${root}` };
    const r = inspectTable(b, root); r.root = root; return r;
  }
  function fieldOffset(b, tablePos, fieldIndex) {
    const ti = inspectTable(b, tablePos); if (!ti.ok) return 0;
    const idx = 4 + fieldIndex * 2;
    if (idx + 2 > ti.vtLen) return 0;
    return u16(b, ti.vt + idx);
  }
  function tableFieldTarget(b, tablePos, fieldIndex) {
    const off = fieldOffset(b, tablePos, fieldIndex); if (!off) return 0;
    const loc = tablePos + off; if (!validPos(b, loc, 4)) return 0;
    const t = loc + u32(b, loc);
    return validPos(b, t, 4) ? t : 0;
  }
  function vectorTableEntries(b, vecPos, limit) {
    if (!validPos(b, vecPos, 4)) return [];
    const n = u32(b, vecPos); if (n <= 0 || n > 2048) return [];
    const out = [];
    const m = Math.min(n, limit || n);
    for (let i = 0; i < m; i++) {
      const loc = vecPos + 4 + i * 4;
      if (!validPos(b, loc, 4)) break;
      const t = loc + u32(b, loc);
      if (validPos(b, t, 4)) out.push({ index:i, pos:t });
    }
    return out;
  }

  function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
  function clamp(x, a, b) { x = Number(x) || 0; return Math.max(a, Math.min(b, x)); }
  function categoryCN(aqi) { aqi = num(aqi); if (aqi == null) return ''; if (aqi <= 50) return '优'; if (aqi <= 100) return '良'; if (aqi <= 150) return '轻度污染'; if (aqi <= 200) return '中度污染'; if (aqi <= 300) return '重度污染'; return '严重污染'; }
  function aqiCategoryIndex(aqi) { aqi = Number(aqi); if (!Number.isFinite(aqi)) return 0; if (aqi <= 50) return 1; if (aqi <= 100) return 2; if (aqi <= 150) return 3; if (aqi <= 200) return 4; if (aqi <= 300) return 5; return 6; }
  function cleanPollutants(p) {
    const out = {};
    [['pm25',['pm2p5','pm25','pm2_5']],['pm10',['pm10']],['o3',['o3']],['no2',['no2']],['so2',['so2']],['co',['co']]].forEach(([std, keys]) => {
      for (const k of keys) {
        if (p && p[k] != null) { const v = (typeof p[k] === 'object' && p[k].v != null) ? p[k].v : p[k]; const n = num(v); if (n != null) { out[std] = n; break; } }
      }
    });
    return out;
  }
  function euaqiFromPollutants(p) {
    const bands = { pm25:[10,20,25,50,75], pm10:[20,40,50,100,150], no2:[40,90,120,230,340], o3:[50,100,130,240,380], so2:[100,200,350,500,750] };
    let max = 0, primary = '', detail = [];
    for (const k of Object.keys(bands)) {
      const v = num(p && p[k]); if (v == null) continue;
      let lvl = 6; for (let i = 0; i < bands[k].length; i++) if (v <= bands[k][i]) { lvl = i + 1; break; }
      detail.push(`${k}=${v}->${lvl}`); if (lvl > max) { max = lvl; primary = k; }
    }
    return max ? { aqi:max, categoryIndex:max, primary, detail:detail.join(',') } : null;
  }
  function pickMaxIndex(items) {
    let best = null;
    for (const it of items) if (it && num(it.aqi) != null && (!best || it.aqi > best.aqi)) best = it;
    return best;
  }
  function interpAQI(c, bp) {
    c = num(c); if (c == null) return null;
    for (const [cl, ch, il, ih] of bp) {
      if (c >= cl && c <= ch) return Math.round(((ih - il) / (ch - cl)) * (c - cl) + il);
    }
    const last = bp[bp.length - 1];
    if (c > last[1]) return last[3];
    return null;
  }
  function usAqiFromPollutants(p) {
    // QWeather pollutant concentrations are expected in µg/m³ except CO, which may be mg/m³ depending on account/API tier.
    const pm25 = interpAQI(p.pm25, [[0,9,0,50],[9.1,35.4,51,100],[35.5,55.4,101,150],[55.5,125.4,151,200],[125.5,225.4,201,300],[225.5,325.4,301,500]]);
    const pm10 = interpAQI(p.pm10, [[0,54,0,50],[55,154,51,100],[155,254,101,150],[255,354,151,200],[355,424,201,300],[425,604,301,500]]);
    // For ozone, use µg/m³ -> ppm-ish conversion at standard conditions. This is only for display mapping.
    const o3ppm = num(p.o3) == null ? null : p.o3 / 1960;
    const o3 = interpAQI(o3ppm, [[0,0.054,0,50],[0.055,0.070,51,100],[0.071,0.085,101,150],[0.086,0.105,151,200],[0.106,0.200,201,300]]);
    const best = pickMaxIndex([{k:'pm25',aqi:pm25},{k:'pm10',aqi:pm10},{k:'o3',aqi:o3}]);
    return best ? { aqi:best.aqi, categoryIndex:aqiCategoryIndex(best.aqi), primary:best.k, detail:`pm25=${pm25},pm10=${pm10},o3=${o3}` } : null;
  }
  function euaqiFromPollutants(p) {
    const bands = { pm25:[10,20,25,50,75], pm10:[20,40,50,100,150], no2:[40,90,120,230,340], o3:[50,100,130,240,380], so2:[100,200,350,500,750] };
    let max = 0, primary = '', detail = [];
    for (const k of Object.keys(bands)) {
      const v = num(p && p[k]); if (v == null) continue;
      let lvl = 6; for (let i = 0; i < bands[k].length; i++) if (v <= bands[k][i]) { lvl = i + 1; break; }
      detail.push(`${k}=${v}->${lvl}`); if (lvl > max) { max = lvl; primary = k; }
    }
    return max ? { aqi:max, categoryIndex:max, primary, detail:detail.join(',') } : null;
  }
  function deAqiFromPollutants(p) {
    // UBA-style 5 class index. Conservative, display-oriented thresholds.
    const bands = { pm25:[10,20,25,50,75], pm10:[20,35,50,100,150], no2:[40,90,120,230,340], o3:[60,120,180,240,360], so2:[100,200,350,500,750] };
    let max = 0, primary = '', detail = [];
    for (const k of Object.keys(bands)) {
      const v = num(p && p[k]); if (v == null) continue;
      let lvl = 6; for (let i = 0; i < bands[k].length; i++) if (v <= bands[k][i]) { lvl = i + 1; break; }
      detail.push(`${k}=${v}->${lvl}`); if (lvl > max) { max = lvl; primary = k; }
    }
    return max ? { aqi:max, categoryIndex:max, primary, detail:detail.join(',') } : null;
  }
  function standardLabel(std) {
    std = String(std || '').toUpperCase();
    if (/US/.test(std)) return { standard:'美国 (AQI)', short:'AQI (US)', name:'US_AQI' };
    if (/EU/.test(std)) return { standard:'欧洲(EAQI)', short:'AQI (EU)', name:'EU_EAQI' };
    if (/DE|GERMAN/.test(std)) return { standard:'德国 (AQI)', short:'AQI (DE)', name:'DE_UBA_AQI' };
    return { standard:'和风 (AQI)', short:'AQI(QW) ', name:'QWeather_CN_AQI' };
  }
  function resolveAQI(aq) {
    if (!aq || num(aq.aqi) == null) return null;
    const requested = String(ARG.AQIStandard || ARG['AirQuality.Calculate.Algorithm'] || 'QWeather_CN_AQI');
    const p = aq.pollutants || {};
    let r = null;
    if (/^US_AQI$/i.test(requested)) {
      const us = usAqiFromPollutants(p);
      if (us) r = { aqi:us.aqi, categoryIndex:us.categoryIndex, provider:'QWeather', algorithm:'US_AQI', primary:us.primary, note:us.detail };
    } else if (/^EU_EAQI$/i.test(requested)) {
      const eu = euaqiFromPollutants(p);
      if (eu) r = { aqi:eu.aqi, categoryIndex:eu.categoryIndex, provider:'QWeather', algorithm:'EU_EAQI', primary:eu.primary, note:eu.detail };
    } else if (/^(DE_UBA_AQI|GERMAN_AQI)$/i.test(requested)) {
      const de = deAqiFromPollutants(p);
      if (de) r = { aqi:de.aqi, categoryIndex:de.categoryIndex, provider:'QWeather', algorithm:'DE_UBA_AQI', primary:de.primary, note:de.detail };
    }
    if (!r) r = { aqi:aq.aqi, categoryIndex:aqiCategoryIndex(aq.aqi), provider:'QWeather', algorithm:'QWeather_CN_AQI', category:aq.category || categoryCN(aq.aqi), note:`raw${requested ? `; requested=${requested}` : ''}` };
    const lab = standardLabel(r.algorithm);
    r.standardLabel = lab.standard; r.shortLabel = lab.short;
    return r;
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const enc = unescape(encodeURIComponent(str)); const a = new Uint8Array(enc.length);
    for (let i = 0; i < enc.length; i++) a[i] = enc.charCodeAt(i) & 255;
    return a;
  }
  function replaceBytesSameLen(body, from, to, limit) {
    const f = utf8Bytes(from), t = utf8Bytes(to);
    if (!f.length || f.length !== t.length) return { count:0, reason:`length mismatch ${from}(${f.length}) -> ${to}(${t.length})` };
    let count = 0; const max = limit || 16;
    outer: for (let i = 0; i <= body.length - f.length; i++) {
      for (let j = 0; j < f.length; j++) if (body[i + j] !== f[j]) continue outer;
      for (let j = 0; j < t.length; j++) body[i + j] = t[j];
      count++; i += f.length - 1;
      if (count >= max) break;
    }
    return { count };
  }
  function patchAQILabelsInPlace(body, resolved) {
    if (String(ARG.AQILabelPatch || '1') !== '1') return { changed:false, text:'disabled' };
    const standard = (resolved && resolved.standardLabel) || standardLabel('QWeather_CN_AQI').standard;
    const short = (resolved && resolved.shortLabel) || standardLabel('QWeather_CN_AQI').short;
    const ops = [];
    let changed = false;
    for (const f of ['中国 (AQI)', '和风 (AQI)', '美国 (AQI)', '欧洲(EAQI)', '德国 (AQI)']) {
      const r = replaceBytesSameLen(body, f, standard, 8);
      if (r.count) { changed = true; ops.push(`${f}->${standard} x${r.count}`); }
    }
    for (const f of ['AQI (CN)', 'AQI(QW) ', 'AQI (US)', 'AQI (EU)', 'AQI (DE)']) {
      const r = replaceBytesSameLen(body, f, short, 12);
      if (r.count) { changed = true; ops.push(`${f}->${short} x${r.count}`); }
    }
    if (String(ARG.AQITextPatch || '1') === '1' && resolved && /^(EU_EAQI|DE_UBA_AQI)$/i.test(resolved.algorithm || '')) {
      const lvl = Math.max(1, Math.min(6, Number(resolved.categoryIndex || resolved.aqi || 1)));
      const rep = lvl >= 5 ? '空气极差' : lvl === 4 ? '空气较差' : lvl === 3 ? '空气一般' : '';
      if (rep) {
        for (const f of ['重度污染', '中度污染', '轻度污染']) {
          const r = replaceBytesSameLen(body, f, rep, 8);
          if (r.count) { changed = true; ops.push(`${f}->${rep} x${r.count}`); }
        }
      }
    }
    return { changed, text:ops.length ? ops.join('|') : `not found standard=${standard} short=${short}` };
  }

  function locFromUrl(url) {
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/v2\/weather\/[^/]+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    if (!m) throw new Error('no lat/lon');
    return { lat:Number(m[1]), lon:Number(m[2]), country:u.searchParams.get('country') || '', timezone:u.searchParams.get('timezone') || '' };
  }
  function keyOf(loc) { return `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`; }
  function cacheKey(loc) { return `WeatherKit27.QWeather.cache.${keyOf(loc)}`; }
  function storeSet(k, v) { try { if (typeof $persistentStore !== 'undefined') $persistentStore.write(JSON.stringify(v), k); } catch (e) { log('WARN', `cache write fail ${e}`); } }
  function storeGet(k) { try { if (typeof $persistentStore === 'undefined') return null; const s = $persistentStore.read(k); return s ? JSON.parse(s) : null; } catch (_) { return null; } }
  function fresh(c, ttl, type) { return c && c.savedAt && (Date.now() - c.savedAt) < ttl * 1000 && c[type]; }

  function getJSON(url, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeout || 1600);
      $httpClient.get({ url, headers:{ Accept:'application/json' } }, (err, resp, data) => {
        clearTimeout(timer);
        if (err) return reject(err);
        const st = resp && resp.status;
        if (st && (st < 200 || st >= 300)) return reject(new Error(`HTTP ${st}`));
        try { resolve(typeof data === 'string' ? JSON.parse(data) : data); } catch (e) { reject(new Error(`JSON parse ${e.message}`)); }
      });
    });
  }
  function qHost() { return (ARG['API.QWeather.Host'] || 'devapi.qweather.com').replace(/^https?:\/\//, '').replace(/\/+$/, ''); }
  function qToken() { const t = ARG['API.QWeather.Token'] || ''; if (!t) throw new Error('missing QWeather token'); return t; }

  async function fetchQWeatherAQI(loc, timeout) {
    const j = await getJSON(`https://${qHost()}/v7/air/now?location=${loc.lon},${loc.lat}&key=${encodeURIComponent(qToken())}`, timeout);
    if (j.code && !/^2/.test(String(j.code))) throw new Error(`QWeather air code=${j.code}`);
    const n = j.now || {}; const aqi = num(n.aqi);
    return { provider:'QWeather', aqi, scale:'CN', category:n.category || categoryCN(aqi), primary:n.primary || '', pollutants:cleanPollutants(n), updatedAt:n.pubTime || j.updateTime || new Date().toISOString() };
  }
  function parseTimeMs(s) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  async function fetchQWeatherMinutely(loc, timeout) {
    const j = await getJSON(`https://${qHost()}/v7/minutely/5m?location=${loc.lon},${loc.lat}&key=${encodeURIComponent(qToken())}`, timeout);
    if (j.code && !/^2/.test(String(j.code))) throw new Error(`QWeather minutely code=${j.code}`);
    const rows = (j.minutely || []).map((x, i) => ({
      t: parseTimeMs(x.fxTime) || (Date.now() + i * 5 * 60000),
      precip: Math.max(0, Number(x.precip || 0)),
      type: x.type || '',
      probability: x.prob != null ? clamp(Number(x.prob) / 100, 0, 1) : null
    }));
    return { provider:'QWeather', summary:j.summary || '', rows, updatedAt:j.updateTime || new Date().toISOString() };
  }

  async function getAQI(loc) {
    const ttl = Math.max(30, Number(ARG['Provider.CacheTTL'] || 1800));
    const k = cacheKey(loc); const c = storeGet(k);
    if (fresh(c, ttl, 'airQuality') && num(c.airQuality.aqi) != null) { log('INFO', `AQI cache hit ${keyOf(loc)} QWeather=${c.airQuality.aqi}`); return c.airQuality; }
    if (ARG['Provider.LiveFetch'] === '0') return null;
    const timeout = Math.max(700, Number(ARG['Provider.LiveTimeout'] || 1600));
    const aq = await fetchQWeatherAQI(loc, timeout);
    if (aq && num(aq.aqi) != null) {
      const latest = storeGet(k) || c || {};
      storeSet(k, Object.assign({}, latest, { savedAt:Date.now(), location:loc, airQuality:aq }));
    }
    return aq;
  }
  async function getPrecip(loc) {
    const ttl = Math.max(30, Number(ARG['Provider.CacheTTL'] || 1800));
    const k = cacheKey(loc); const c = storeGet(k);
    if (fresh(c, ttl, 'precipitation')) { log('INFO', `Precip cache hit ${keyOf(loc)} QWeather rows=${(c.precipitation.rows || []).length}`); return c.precipitation; }
    if (ARG['Provider.LiveFetch'] === '0') return null;
    const timeout = Math.max(700, Number(ARG['Provider.LiveTimeout'] || 1600));
    const pr = await fetchQWeatherMinutely(loc, timeout);
    if (pr && Array.isArray(pr.rows)) {
      const latest = storeGet(k) || c || {};
      storeSet(k, Object.assign({}, latest, { savedAt:Date.now(), location:loc, precipitation:pr }));
    }
    return pr;
  }
  function aggregateHourly(precip) {
    const hours = Math.max(1, Math.min(24, Number(ARG['Precipitation.Hours'] || 12)));
    const now = Date.now(); const buckets = [];
    for (let h = 0; h < hours; h++) buckets.push({ hour:h, amount:0, max:0, points:0, probability:0, type:'' });
    for (const r of ((precip && precip.rows) || [])) {
      const diff = r.t - now; const h = Math.floor(diff / 3600000);
      if (h < 0 || h >= hours) continue;
      const mm = Math.max(0, Number(r.precip || 0));
      buckets[h].amount += mm; buckets[h].max = Math.max(buckets[h].max, mm); buckets[h].points++;
      if (r.type) buckets[h].type = r.type;
      if (r.probability != null) buckets[h].probability = Math.max(buckets[h].probability, clamp(r.probability, 0, 1));
    }
    for (const b of buckets) {
      if (!b.probability) b.probability = b.amount <= 0 ? 0 : clamp(0.55 + Math.min(0.4, b.amount * 0.12), 0.55, 1);
      b.intensity = b.points ? b.amount / Math.max(1, b.points) : 0;
    }
    return buckets;
  }

  function patchAirQualityInPlace(body, resolved) {
    const mode = String(ARG['Provider.PatchMode'] || 'InjectAll').toLowerCase();
    if (!/(inject|aqi|all)/.test(mode)) return { patched:false, reason:`PatchMode=${ARG['Provider.PatchMode']}` };
    if (!resolved || num(resolved.aqi) == null) return { patched:false, reason:'no QWeather AQI' };
    const info = inspectRoot(body); if (!info.ok) return { patched:false, reason:`root ${info.reason}` };
    const airQ = tableFieldTarget(body, info.root, 0); if (!airQ) return { patched:false, reason:'WK2 field0 airQuality missing' };
    const aqiOff = fieldOffset(body, airQ, 2); const catOff = fieldOffset(body, airQ, 1);
    if (!aqiOff) return { patched:false, reason:'AQI scalar field missing' };
    const oldAqi = u16(body, airQ + aqiOff), oldCat = catOff ? body[airQ + catOff] : 0;
    setU16(body, airQ + aqiOff, resolved.aqi);
    if (catOff) body[airQ + catOff] = (resolved.categoryIndex || aqiCategoryIndex(resolved.aqi)) & 255;
    return { patched:true, oldAqi, newAqi:Math.round(resolved.aqi), oldCat, newCat:resolved.categoryIndex || aqiCategoryIndex(resolved.aqi), provider:'QWeather', algorithm:resolved.algorithm || '' };
  }

  function entryUnix(body, pos) {
    const off = fieldOffset(body, pos, 0); if (!off) return 0;
    const loc = pos + off; if (!validPos(body, loc, 4)) return 0;
    const t = u32(body, loc);
    return (t > 1500000000 && t < 2200000000) ? t : 0;
  }
  function findCurrentEntry(entries) {
    const now = Math.floor(Date.now() / 1000); let idx = 0;
    for (let i = 0; i < entries.length; i++) {
      const t = entryUnix(entries[i].body, entries[i].pos);
      if (t && t <= now + 1800) idx = i;
      if (t && t > now + 1800) break;
    }
    return idx;
  }
  function patchHourlyPrecip(body, precip) {
    const mode = String(ARG['Provider.PatchMode'] || 'InjectAll').toLowerCase();
    if (!/(injectall|precip|hourly|all)/.test(mode)) return { patched:0, reason:`PatchMode=${ARG['Provider.PatchMode']}` };
    if (!precip || !Array.isArray(precip.rows) || !precip.rows.length) return { patched:0, reason:'no QWeather precipitation' };
    const rootInfo = inspectRoot(body); if (!rootInfo.ok) return { patched:0, reason:`root ${rootInfo.reason}` };
    const hourlyWrapper = tableFieldTarget(body, rootInfo.root, 3);
    if (!hourlyWrapper) return { patched:0, reason:'WK2 field3 forecastHourly missing' };
    const vec = tableFieldTarget(body, hourlyWrapper, 1);
    if (!vec) return { patched:0, reason:'forecastHourly vector missing' };
    const entries = vectorTableEntries(body, vec, 400).map(e => Object.assign({ body }, e));
    if (!entries.length) return { patched:0, reason:'forecastHourly entries missing' };
    const buckets = aggregateHourly(precip);
    const start = findCurrentEntry(entries);
    const maxHours = Math.min(buckets.length, Math.max(1, Math.min(24, Number(ARG['Precipitation.Hours'] || 12))));
    let patched = 0, skipped = 0, sample = [];
    for (let h = 0; h < maxHours; h++) {
      const e = entries[start + h]; if (!e) break;
      const b = buckets[h];
      const off8 = fieldOffset(body, e.pos, 8);
      const off9 = fieldOffset(body, e.pos, 9);
      const off10 = fieldOffset(body, e.pos, 10);
      if (!off8 && !off9 && !off10) { skipped++; continue; }
      const chance = clamp(b.probability, 0, 1);
      const amount = Math.max(0, Number(b.amount || 0));
      try {
        if (off8 && validPos(body, e.pos + off8, 4)) setF32(body, e.pos + off8, chance);
        if (off9 && validPos(body, e.pos + off9, 4)) setF32(body, e.pos + off9, amount);
        if (off10 && validPos(body, e.pos + off10, 4)) setF32(body, e.pos + off10, amount);
        patched++;
        if (sample.length < 4) sample.push(`h${h}:p=${chance.toFixed(2)},mm=${amount.toFixed(2)}`);
      } catch (_) { skipped++; }
    }
    return { patched, skipped, provider:'QWeather', summary:precip.summary || '', sample:sample.join('|') };
  }

  const AU_NEXT_HOUR_TEMPLATE_B64 = 'EAAcABgAFAAQAAwACAAEABAAAAAYAAAA2D00arApNGrUBwAAEAgAAJAIAABWAAAAsAcAAIwHAAB0BwAAXAcAAEQHAAAsBwAAFAcAAPwGAADkBgAAzAYAALQGAACcBgAAhAYAAGwGAABUBgAAPAYAACQGAAAMBgAA9AUAANwFAADEBQAArAUAAJQFAAB8BQAAZAUAAEwFAAA0BQAAHAUAAAQFAADsBAAA1AQAALwEAACkBAAAjAQAAHQEAABcBAAARAQAACwEAAAUBAAA/AMAAOQDAADMAwAAtAMAAJwDAACEAwAAbAMAAFQDAAA8AwAAJAMAAAwDAAD0AgAA3AIAAMQCAACsAgAAlAIAAHwCAABkAgAATAIAADgCAAAYAgAA+AEAAOQBAADQAQAAvAEAAKgBAACUAQAAgAEAAGwBAABYAQAARAEAADABAAAcAQAACAEAAPQAAADgAAAAzAAAALgAAACkAAAAkAAAAHwAAABoAAAAVAAAAEAAAAAsAAAAGAAAAAQAAABC/v//g6XJPgAAAAacPTRqUv7//4OlyT4AAAAGYD00amL+//+Dpck+AAAAByQ9NGpy/v//YWbSPgAAAAfoPDRqgv7//2Fm0j4AAAAIrDw0apL+//9hZtI+AAAACHA8NGqi/v//YWbSPgAAAAk0PDRqsv7//2Fm0j4AAAAJ+Ds0asL+//+AiNs+AAAACrw7NGrS/v//gIjbPgAAAAuAOzRq4v7//4CI2z4AAAAMRDs0avL+//+AiNs+AAAADQg7NGoC////HxDlPgAAAA3MOjRqEv///x8Q5T4AAAAOkDo0aiL///8fEOU+AAAAD1Q6NGoy////qQHvPgAAABAYOjRqQv///6kB7z4AAAAQ3Dk0alL///+pAe8+AAAAEqA5NGpi////r2H5PgAAABJkOTRqcv///69h+T4AAAAUKDk0aoL///+vYfk+AAAAFOw4NGqS////ghoCPwAAABawODRqov///4IaAj8AAAAXdDg0arL///9SwAc/AAAAGDg4NGrC////UsAHPwAAABn8NzRq7v///+akDT8AAAAawDc0agAACgASAAwACwAEAAoAAADmpA0/AAAAG4Q3NGoAAAoAEAAMAAsABAAKAAAA9coTPwAAAB1INzRqjPv//1g59D71yhM/AAAAHgw3NGqg+///ke38Pls1Gj8AAAAf0DY0arT7///TTQI/WzUaPwAAACGUNjRqyPv///CnBj8J5yA/AAAAIlg2NGrc+///lkMLPx7jJz8AAAAjHDY0avD7//+gGg8/HuMnPwAAACXgNTRqBPz//0a2Ez/PLC8/AAAAJqQ1NGoY/P//rBwaP33HNj8AAAAoaDU0aiz8//8tsh0/fcc2PwAAACosNTRqQPz//1yPIj+vtj4/AAAAK/A0NGpU/P//i2wnPwn+Rj8AAAAstDQ0amj8//8MAis/Cf5GPwAAAC54NDRqfPz///ypMT9ooU8/AAAAMDw0NGqQ/P//tMg2P8GkWD8AAAAxADQ0aqT8//8tsj0/RwxiPwAAADPEMzRquPz//6abRD9L3Gs/AAAANYgzNGrM/P//3SRGP0vcaz8AAAA2TDM0auD8///fT00/YBl2PwAAADgQMzRq9Pz//1g5VD8bZIA/AAAAOtQyNGoI/f//I9tZP+P2hT8AAAA7mDI0ahz9//+uR2E/nMeLPwAAAD1cMjRqMP3//+XQYj+cx4s/AAAAPiAyNGpE/f//cT1qP/PYkT8AAABA5DE0alj9///8qXE/ui2YPwAAAEKoMTRqbP3//1CNdz/ayJ4/AAAAQ2wxNGqA/f//vp96P9rInj8AAABFMDE0apT9//9OYoA/Zq2lPwAAAEb0MDRqqP3//1g5hD+I3qw/AAAASLgwNGq8/f//9P2EP4jerD8AAABJfDA0atD9///+1Ig/mV+0PwAAAEtAMDRq5P3//zEIjD8MNLw/AAAATAQwNGr4/f//CKyMPww0vD8AAABNyC80agz+//87348/gV/EPwAAAE6MLzRqIP7//9ejkD+BX8Q/AAAAT1AvNGo0/v//c2iRP4FfxD8AAABQFC80akj+//+mm5Q/xOXMPwAAAFHYLjRqXP7//6ablD/E5cw/AAAAUZwuNGpw/v//QmCVP8TlzD8AAABSYC40aoT+//9CYJU/xOXMPwAAAFIkLjRqmP7//90klj/E5cw/AAAAU+gtNGqs/v//3SSWP8TlzD8AAABTrC00asD+///dJJY/xOXMPwAAAFNwLTRq1P7//90klj/E5cw/AAAAUzQtNGro/v//gZWTP4FfxD8AAABT+Cw0avz+//+BlZM/gV/EPwAAAFO8LDRqEP///05ikD8MNLw/AAAAUoAsNGok////tvONP5lftD8AAABSRCw0ajj///8fhYs/iN6sPwAAAFIILDRqTP///xkEhj/ayJ4/AAAAUcwrNGpg////qvGCP7otmD8AAABQkCs0anT///9aZHs/nMeLPwAAAE9UKzRqiP///4/CdT/j9oU/AAAAThgrNGqc////qMZrP2AZdj8AAABN3Co0arD////dJGY/S9xrPwAAAEygKjRqxP///2Q7Xz9HDGI/AAAASmQqNGrY////dZNYP8GkWD8AAABIKCo0auz///9qvFQ/waRYPwAAAEXsKTRqDAAUABAADwAIAAQADAAAABkEVj9HDGI/AAAAQ7ApNGoCAAAAKAAAAAwAAAAAAAYACgAEAAYAAABINzRqAAAOABQAEAAMAAsACgAEAA4AAADE5cw/AABTAUg3NGqwKTRqAgAAADgAAAAUAAAAEAAMAAgAAAAAAAAAAAAEABAAAAAIAAAASDc0agAAAAAQABQAEAAMAAsACgAJAAQAEAAAABAAAAAABgYCSDc0arApNGoBAAAADAAAAAgACgAAAAQACAAAAEg3NGoAABoAJAAgABwAAAAYABQAAAAQAAwACAAAAAcAGgAAAAAAAAHAKDRq6yk0ahQAAACBVRRD9igNwhcrNGooAAAAHwAAAEF1c3RyYWxpYSBCdXJlYXUgb2YgTWV0ZW9yb2xvZ3kASAAAAGh0dHBzOi8vZGV2ZWxvcGVyLmFwcGxlLmNvbS93ZWF0aGVya2l0L2RhdGEtc291cmNlLWF0dHJpYnV0aW9uLWludGVybmFsLwAAAAA=';
  function b64ToU8(s) {
    const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
    const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i) & 255; return a;
  }
  const AU_TEMPLATE = b64ToU8(AU_NEXT_HOUR_TEMPLATE_B64);
  function copyU8(dst, off, src) { dst.set(src, off); }
  function setF32Any(b, o, v) { new DataView(b.buffer, b.byteOffset + o, 4).setFloat32(0, Number(v) || 0, true); }
  function hasRainNow(precip) {
    const rows = (precip && precip.rows) || [];
    if (!rows.length) return false;
    const now = Date.now();
    return rows.some(r => r.t >= now - 2 * 60000 && r.t <= now + 12 * 60000 && Number(r.precip || 0) > 0);
  }
  function rainWindow(precip) {
    const rows = (precip && precip.rows || []).filter(r => Number(r.precip || 0) > 0);
    const now = Date.now();
    const future = rows.filter(r => r.t >= now - 5 * 60000 && r.t <= now + 2 * 3600000);
    if (!future.length) return null;
    const start = Math.min(...future.map(r => r.t));
    const end = Math.max(...future.map(r => r.t + 5 * 60000));
    const amount = future.reduce((s, r) => s + Math.max(0, Number(r.precip || 0)), 0);
    return { start:Math.floor(Math.min(now, start) / 1000), end:Math.floor(end / 1000), amount };
  }
  function patchTemplateNextHour(tpl, loc, precip) {
    const out = new Uint8Array(tpl);
    const win = rainWindow(precip); if (!win) return null;
    const start = win.start, end = Math.max(start + 600, win.end);
    // Slice local offsets derived from AU iOS27 WK2.Weather field4 template.
    setU32(out, 28, start); setU32(out, 24, end); setU32(out, 20, 24);
    // field1 event vector entries
    setU32(out, 2176, start); setU32(out, 2172, end); setU32(out, 2136, end);
    // field2 intensity vector entries
    setU32(out, 2096, start); setU32(out, 2092, end); setF32Any(out, 2084, Math.max(0.01, Math.min(8, win.amount || 0.2)));
    setU32(out, 2060, end);
    // source/location metadata table
    setU32(out, 2260, start); setF32Any(out, 2256, loc.lat); setF32Any(out, 2252, loc.lon); setU32(out, 2244, start); setU32(out, 2240, start);
    return out;
  }
  function rebuildRootAddField4(body, field4Template) {
    const info = inspectRoot(body); if (!info.ok) return { body, changed:false, reason:`root ${info.reason}` };
    if (tableFieldTarget(body, info.root, 4)) return { body, changed:false, reason:'field4 already present' };
    if (info.root !== 40 || info.vt !== 4 || info.vtLen !== 36) return { body, changed:false, reason:`unsupported root layout root=${info.root} vt=${info.vt} vtLen=${info.vtLen}` };
    const oldTailStart = info.root + info.objSize;
    const newObjSize = 48, newTailStart = info.root + newObjSize;
    const delta = newTailStart - oldTailStart;
    const tailLen = body.length - oldTailStart;
    const templateStart = newTailStart + tailLen;
    const next = new Uint8Array(body.length + delta + field4Template.length);
    setU32(next, 0, 40);
    setU16(next, 4, 36); setU16(next, 6, newObjSize);
    const fieldOffMap = { 15:4, 12:8, 8:12, 7:16, 6:20, 5:24, 4:28, 3:32, 2:36, 1:40, 0:44 };
    for (let i = 0; i < 16; i++) setU16(next, 8 + i * 2, fieldOffMap[i] || 0);
    setI32(next, 40, 36);
    copyU8(next, newTailStart, body.slice(oldTailStart));
    copyU8(next, templateStart, field4Template);
    // Preserve existing root field targets.
    for (const i of info.present) {
      const newOff = fieldOffMap[i]; if (!newOff) continue;
      const oldTarget = tableFieldTarget(body, info.root, i); if (!oldTarget) continue;
      const newTarget = oldTarget + delta;
      const loc = 40 + newOff;
      setU32(next, loc, newTarget - loc);
    }
    // Add field4 target. In template slice, field4 table starts 16 bytes after slice beginning.
    setU32(next, 40 + fieldOffMap[4], (templateStart + 16) - (40 + fieldOffMap[4]));
    return { body:next, changed:true, reason:`added field4 template bytes=${field4Template.length}` };
  }
  function injectNextHourCard(body, loc, precip) {
    if (String(ARG.NextHourCard || '0') !== '1') return { body, changed:false, reason:'NextHourCard=0' };
    if (!precip || !Array.isArray(precip.rows) || !precip.rows.length) return { body, changed:false, reason:'no QWeather precipitation' };
    if (!hasRainNow(precip)) return { body, changed:false, reason:'not raining now; keep hourly precipitation only' };
    const tpl = patchTemplateNextHour(AU_TEMPLATE, loc, precip);
    if (!tpl) return { body, changed:false, reason:'no rain window' };
    return rebuildRootAddField4(body, tpl);
  }

  async function main() {
    const ct = hget($response.headers, 'Content-Type');
    if (!/application\/vnd\.apple\.flatbuffer/i.test(ct) || !/WK2\.Weather/i.test(ct)) { log('DEBUG', `skip content-type=${ct}`); return $done({}); }
    const loc = locFromUrl($request.url);
    let body = asU8($response.body);
    const info = inspectRoot(body);
    if (info.ok) log('INFO', `WK2.Weather ${keyOf(loc)} len=${body.length} fields=${info.fieldCount} present=[${info.present.join(',')}]`);
    else log('WARN', `WK2 inspect fail ${info.reason}`);

    let changed = false;
    const mode = String(ARG['Provider.PatchMode'] || 'InjectAll').toLowerCase();
    const needAQI = /(injectall|inject|aqi|all)/.test(mode);
    const needPrecip = /(injectall|precip|hourly|all)/.test(mode);

    const aqJob = needAQI ? getAQI(loc).then(v => ({ ok:true, value:v })).catch(e => ({ ok:false, error:e })) : Promise.resolve({ ok:true, value:null });
    const prJob = needPrecip ? getPrecip(loc).then(v => ({ ok:true, value:v })).catch(e => ({ ok:false, error:e })) : Promise.resolve({ ok:true, value:null });
    const [aqRes, prRes] = await Promise.all([aqJob, prJob]);

    let aq = null;
    if (aqRes.ok) aq = aqRes.value;
    else { log('WARN', `AQI provider failed: ${aqRes.error && aqRes.error.message || aqRes.error}`); notify('WeatherKit27', 'QWeather AQI failed', String(aqRes.error && aqRes.error.message || aqRes.error)); }

    const resolved = resolveAQI(aq);
    if (resolved) log('INFO', `AQI provider=QWeather raw=${aq.aqi} patch=${resolved.aqi}/${resolved.categoryIndex} algorithm=${resolved.algorithm} ${resolved.note || ''}`);
    const ap = patchAirQualityInPlace(body, resolved);
    if (ap.patched) {
      changed = true;
      log('WARN', `injectAQI: ${ap.oldAqi}/${ap.oldCat} -> ${ap.newAqi}/${ap.newCat} provider=QWeather algorithm=${ap.algorithm}`);
      const lp = patchAQILabelsInPlace(body, resolved);
      if (lp.changed) { changed = true; log('WARN', `injectAQILabel: ${lp.text}`); }
      else log('INFO', `injectAQILabel skipped: ${lp.text}`);
    } else log('INFO', `injectAQI skipped: ${ap.reason}`);

    let pr = null;
    if (prRes.ok) pr = prRes.value;
    else { log('WARN', `Precip provider failed: ${prRes.error && prRes.error.message || prRes.error}`); notify('WeatherKit27', 'QWeather precip failed', String(prRes.error && prRes.error.message || prRes.error)); }

    if (pr) log('INFO', `Precip provider=QWeather rows=${(pr.rows || []).length} summary=${pr.summary || ''}`);
    const pp = patchHourlyPrecip(body, pr);
    if (pp.patched > 0) { changed = true; log('WARN', `injectPrecipHourly: patched=${pp.patched} skipped=${pp.skipped} provider=QWeather ${pp.sample || ''}`); }
    else log('INFO', `injectPrecipHourly skipped: ${pp.reason}${pp.skipped ? ` skipped=${pp.skipped}` : ''}`);

    const nc = injectNextHourCard(body, loc, pr);
    if (nc.changed) { body = nc.body; changed = true; log('WARN', `injectNextHourCard: ${nc.reason}`); }
    else log('INFO', `injectNextHourCard skipped: ${nc.reason}`);

    return changed ? $done({ body }) : $done({});
  }

  main().catch(e => { console.log(`[${NAME}] ERROR ${e && e.stack || e}`); $done({}); });
})();
