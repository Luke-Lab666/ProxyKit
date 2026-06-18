/*
 * WeatherKit iOS27 Provider Adapter - response.js
 * 接入：ColorfulClouds / QWeather / WAQI
 * v5：完整 AQI 原位注入（数值/等级/标准/来源/污染物详情/URL）+ Provider 预取缓存兼容。
 * 未来一小时：完整接入 Provider/缓存；只有原生 WK2 field4 模板存在时才做原位/模板注入，避免硬造 FlatBuffer 炸包。
 */
(() => {
  const NAME = 'WK27.Provider.response';
  const LEVEL = { OFF:0, ERROR:1, WARN:2, INFO:3, DEBUG:4, ALL:5 };
  const DEFAULT = {
    'NextHour.Provider':'Auto',
    'AirQuality.Provider':'Auto',
    'AirQuality.Calculate.Algorithm':'EU_EAQI',
    'API.ColorfulClouds.Token':'',
    'API.QWeather.Host':'devapi.qweather.com',
    'API.QWeather.Token':'',
    'API.WAQI.Token':'',
    'Provider.CacheTTL':'300',
    'Provider.PatchMode':'InjectAQI',
    'LogLevel':'INFO',
    'DebugNotify':'0',
    'AirQuality.SourceName':'Auto',
    'AirQuality.StandardID':'Auto',
    'AirQuality.StandardName':'Auto',
    'Provider.Prefetch':'1'
  };
  function args(s){const o=Object.assign({},DEFAULT);(s||'').split('&').forEach(p=>{const i=p.indexOf('=');if(i>0){const k=decodeURIComponent(p.slice(0,i));let v=decodeURIComponent(p.slice(i+1));v=String(v).replace(/^"|"$/g,'');o[k]=v;}});return o;}
  const ARG = args(typeof $argument === 'string' ? $argument : '');
  const LOG = LEVEL[String(ARG.LogLevel||'INFO').toUpperCase()] ?? 3;
  function log(l,m){ if(LOG >= LEVEL[l]) console.log(`[${NAME}] ${m}`); }
  function notify(title, sub, body){ if(ARG.DebugNotify==='1' && typeof $notification!=='undefined') $notification.post(title, sub, body); }
  function hget(headers, key){ const low=key.toLowerCase(); for(const k in (headers||{})){ if(String(k).toLowerCase()===low) return String(headers[k]||''); } return ''; }
  function asU8(body){ if(!body) return new Uint8Array(0); if(body instanceof Uint8Array) return body; if(typeof ArrayBuffer!=='undefined' && body instanceof ArrayBuffer) return new Uint8Array(body); if(ArrayBuffer.isView && ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength); if(typeof body==='string'){const a=new Uint8Array(body.length); for(let i=0;i<body.length;i++) a[i]=body.charCodeAt(i)&255; return a;} return new Uint8Array(0); }
  function u16(b,o){ return (b[o] | (b[o+1]<<8)) >>> 0; }
  function u32(b,o){ return (b[o] | (b[o+1]<<8) | (b[o+2]<<16) | (b[o+3]<<24)) >>> 0; }
  function i32(b,o){ return (b[o] | (b[o+1]<<8) | (b[o+2]<<16) | (b[o+3]<<24)) | 0; }
  function inspectRoot(b){
    if(!b || b.length<12) return {ok:false,reason:'too small'};
    const root=u32(b,0); if(root<4 || root+4>b.length) return {ok:false,reason:`bad root ${root}`};
    const vt=root-i32(b,root); if(vt<0 || vt+4>b.length) return {ok:false,reason:`bad vtable ${vt}`};
    const vtLen=u16(b,vt), objSize=u16(b,vt+2); if(vtLen<4 || vtLen>512 || vt+vtLen>b.length) return {ok:false,reason:`bad vtLen ${vtLen}`};
    const n=(vtLen-4)>>1, present=[]; for(let i=0;i<n;i++){ if(u16(b,vt+4+i*2)) present.push(i); }
    return {ok:true,root,vt,vtLen,objSize,fieldCount:n,present};
  }
  function setU16(b,o,v){ v=Math.max(0,Math.min(65535,Math.round(Number(v)||0))); b[o]=v&255; b[o+1]=(v>>>8)&255; }
  function setU32(b,o,v){ v=(Number(v)||0)>>>0; b[o]=v&255; b[o+1]=(v>>>8)&255; b[o+2]=(v>>>16)&255; b[o+3]=(v>>>24)&255; }
  function f32(b,o){ if(o<0 || o+4>b.length) return NaN; const dv=new DataView(b.buffer,b.byteOffset+o,4); return dv.getFloat32(0,true); }
  function setF32(b,o,v){ if(o<0 || o+4>b.length) return; const dv=new DataView(b.buffer,b.byteOffset+o,4); dv.setFloat32(0,Number(v)||0,true); }
  function getFieldOffset(b, tablePos, fieldIndex){
    if(!b || tablePos<4 || tablePos+4>b.length) return 0;
    const vt = tablePos - i32(b, tablePos);
    if(vt<0 || vt+4>b.length) return 0;
    const vtLen = u16(b, vt);
    const indexOffset = 4 + fieldIndex * 2;
    if(indexOffset + 2 > vtLen) return 0;
    return u16(b, vt + indexOffset);
  }
  function getTableFieldTarget(b, tablePos, fieldIndex){
    const off = getFieldOffset(b, tablePos, fieldIndex);
    if(!off) return 0;
    const loc = tablePos + off;
    if(loc < 0 || loc + 4 > b.length) return 0;
    const rel = u32(b, loc);
    const target = loc + rel;
    if(target < 4 || target >= b.length) return 0;
    return target;
  }
  function aqiCategoryIndex(aqi){
    aqi = Number(aqi);
    if(!Number.isFinite(aqi)) return 0;
    if(aqi <= 50) return 1;
    if(aqi <= 100) return 2;
    if(aqi <= 150) return 3;
    if(aqi <= 200) return 4;
    if(aqi <= 300) return 5;
    return 6;
  }
  function euaqiCategoryCN(level){
    level = Number(level)||0;
    return ['','良好','一般','中等','差','很差','极差'][level] || '';
  }
  function euaqiFromPollutants(p){
    // EEA/CAMS 常用 EAQI bands，单位 ug/m3；返回 1-6。
    // PM2.5/PM10 用近似即时浓度或 24h 均值；NO2/O3/SO2 用小时浓度。第三方源给不到更细窗口时只能近似。
    const bands = {
      pm25:[10,20,25,50,75],
      pm10:[20,40,50,100,150],
      no2:[40,90,120,230,340],
      o3:[50,100,130,240,380],
      so2:[100,200,350,500,750]
    };
    const detail=[];
    let maxLevel=0, primary='';
    for(const k of Object.keys(bands)){
      const v = num(p && p[k]);
      if(v == null) continue;
      let lvl=6;
      for(let i=0;i<bands[k].length;i++){ if(v <= bands[k][i]){ lvl=i+1; break; } }
      detail.push(`${k}=${v}->${lvl}`);
      if(lvl > maxLevel){ maxLevel=lvl; primary=k; }
    }
    if(!maxLevel) return null;
    return { aqi:maxLevel, categoryIndex:maxLevel, category:euaqiCategoryCN(maxLevel), primary, detail };
  }
  function resolveAirQualityForPatch(bundle){
    const aq = bundle && bundle.airQuality;
    if(!aq || !Number.isFinite(Number(aq.aqi))) return null;
    const algorithm = String(ARG['AirQuality.Calculate.Algorithm'] || 'WAQI_InstantCast_CN');
    const provider = aq.provider || '';
    if(/^EU_EAQI$/i.test(algorithm)){
      // WAQI 的 iaqi 多数是各污染物 AQI 子指数，不是浓度；不能严谨反算 EAQI。
      // QWeather/彩云给的是污染物浓度，才适合算 EU_EAQI。
      if(provider !== 'WAQI'){
        const eu = euaqiFromPollutants(aq.pollutants || {});
        if(eu) return { aqi:eu.aqi, categoryIndex:eu.categoryIndex, category:eu.category, provider, algorithm:'EU_EAQI', sourceProvider:provider, primary:eu.primary, note:`EU_EAQI ${eu.detail.join(',')}` };
      }
      return { aqi:Number(aq.aqi), categoryIndex:aqiCategoryIndex(aq.aqi), category:aq.category || categoryCN(aq.aqi), provider, algorithm:'EU_EAQI_FALLBACK_RAW_AQI', sourceProvider:provider, primary:aq.primary||'', note:'EU_EAQI fallback: provider has no usable concentration pollutants' };
    }
    return { aqi:Number(aq.aqi), categoryIndex:aqiCategoryIndex(aq.aqi), category:aq.category || categoryCN(aq.aqi), provider, algorithm, sourceProvider:provider, primary:aq.primary||'', note:'raw AQI' };
  }
  function utf8Bytes(s){
    const enc = unescape(encodeURIComponent(String(s)));
    const a=[]; for(let i=0;i<enc.length;i++) a.push(enc.charCodeAt(i)&255); return a;
  }
  function patchFlatStringLiteral(body, oldText, newText, maxCount){
    const oldB=utf8Bytes(oldText), newB=utf8Bytes(newText);
    if(!oldB.length || newB.length > oldB.length) return {count:0, reason:`new string too long ${newText}`};
    let count=0;
    outer: for(let i=4;i<=body.length-oldB.length;i++){
      for(let j=0;j<oldB.length;j++){ if(body[i+j] !== oldB[j]) continue outer; }
      // FlatBuffer string/vector 前 4 字节一般是 length。只改能确认 length 的字符串，降低误伤。
      if(u32(body, i-4) !== oldB.length) continue;
      setU32(body, i-4, newB.length);
      for(let j=0;j<newB.length;j++) body[i+j]=newB[j];
      if(i+newB.length < body.length) body[i+newB.length]=0;
      for(let j=newB.length+1;j<oldB.length;j++) body[i+j]=0;
      count++;
      if(maxCount && count>=maxCount) break;
    }
    return {count};
  }
  function readFlatString(body, target){
    if(!target || target<4 || target+4>body.length) return '';
    const len=u32(body,target);
    if(!Number.isFinite(len) || len<0 || len>1024 || target+4+len>body.length) return '';
    try{return decodeURIComponent(escape(String.fromCharCode.apply(null, Array.from(body.slice(target+4,target+4+len)))));}catch(_){try{return new TextDecoder().decode(body.slice(target+4,target+4+len));}catch(__){return '';}}
  }
  function patchFlatStringTarget(body, target, newText){
    if(!target || target<4 || target+4>body.length) return {ok:false, reason:'bad string target'};
    const oldLen=u32(body,target);
    const newB=utf8Bytes(newText);
    if(!Number.isFinite(oldLen) || oldLen<0 || oldLen>1024 || target+4+oldLen>body.length) return {ok:false, reason:'bad old length'};
    if(newB.length > oldLen) return {ok:false, reason:`too long ${newText} ${newB.length}/${oldLen}`};
    const old=readFlatString(body,target);
    setU32(body,target,newB.length);
    for(let i=0;i<newB.length;i++) body[target+4+i]=newB[i];
    if(target+4+newB.length < body.length) body[target+4+newB.length]=0;
    for(let i=newB.length+1;i<oldLen;i++) body[target+4+i]=0;
    return {ok:true, old, new:String(newText)};
  }
  function patchFlatStringLiteral(body, oldText, newText, maxCount){
    const oldB=utf8Bytes(oldText), newB=utf8Bytes(newText);
    if(!oldB.length || newB.length > oldB.length) return {count:0, reason:`new string too long ${newText}`};
    let count=0;
    outer: for(let i=4;i<=body.length-oldB.length;i++){
      for(let j=0;j<oldB.length;j++){ if(body[i+j] !== oldB[j]) continue outer; }
      if(u32(body, i-4) !== oldB.length) continue;
      setU32(body, i-4, newB.length);
      for(let j=0;j<newB.length;j++) body[i+j]=newB[j];
      if(i+newB.length < body.length) body[i+newB.length]=0;
      for(let j=newB.length+1;j<oldB.length;j++) body[i+j]=0;
      count++;
      if(maxCount && count>=maxCount) break;
    }
    return {count};
  }
  function sourceNameFor(resolved){
    const explicit=String(ARG['AirQuality.SourceName']||'Auto');
    if(explicit && explicit !== 'Auto') return explicit;
    const provider = resolved && resolved.sourceProvider || resolved && resolved.provider || '';
    if(provider==='ColorfulClouds') return '彩云天气';
    if(provider==='QWeather') return 'QWeather';
    if(provider==='WAQI') return 'WAQI';
    return provider || '';
  }
  function standardFor(resolved){
    const alg=String(resolved && resolved.algorithm || ARG['AirQuality.Calculate.Algorithm'] || '');
    const explicitID=String(ARG['AirQuality.StandardID']||'Auto');
    const explicitName=String(ARG['AirQuality.StandardName']||'Auto');
    if(explicitID !== 'Auto' || explicitName !== 'Auto') return {id:explicitID==='Auto'?'':explicitID, name:explicitName==='Auto'?'':explicitName};
    if(/^EU_EAQI/i.test(alg)) return {id:'EU.EAQI', name:'欧洲(EAQI)'};
    if(/US|EPA/i.test(alg)) return {id:'EPA_NowCast', name:'美国(AQI)'};
    return {id:'HJ6332012.2604', name:'中国(AQI)'};
  }
  function patchAirQualityMetaStructured(body, airQ, resolved){
    const result=[];
    const sourceName=sourceNameFor(resolved);
    const standard=standardFor(resolved);
    if(standard.name || standard.id){
      const standardTarget=getTableFieldTarget(body, airQ, 7);
      const want=(standard.name || standard.id || '').slice(0,32);
      if(standardTarget && want){
        let r=patchFlatStringTarget(body, standardTarget, want);
        if(!r.ok && standard.id) r=patchFlatStringTarget(body, standardTarget, standard.id);
        result.push(`standard:${r.ok?`${r.old}->${r.new}`:`fail:${r.reason}`}`);
      }
    }
    const current=getTableFieldTarget(body, airQ, 0);
    if(current){
      if(sourceName){
        const srcTarget=getTableFieldTarget(body, current, 6);
        if(srcTarget){
          const r=patchFlatStringTarget(body, srcTarget, sourceName);
          result.push(`source:${r.ok?`${r.old}->${r.new}`:`fail:${r.reason}`}`);
        }
      }
      const urlTarget=getTableFieldTarget(body, current, 0);
      if(urlTarget){
        let url='';
        const p=resolved && (resolved.sourceProvider || resolved.provider);
        if(p==='WAQI') url='https://waqi.info/';
        else if(p==='ColorfulClouds') url='https://caiyunapp.com/';
        else if(p==='QWeather') url='https://www.qweather.com/';
        if(url){
          const r=patchFlatStringTarget(body, urlTarget, url);
          result.push(`url:${r.ok?'ok':`fail:${r.reason}`}`);
        }
      }
      const scaleOff=getFieldOffset(body,current,10);
      if(scaleOff && /^EU_EAQI/i.test(String(resolved && resolved.algorithm || ''))){ const old=body[current+scaleOff]; body[current+scaleOff]=13; result.push(`scaleEnum:${old}->13`); }
    }
    if(sourceName){
      for(const old of ['和风天气','The Weather Channel','Apple Weather']){
        const r=patchFlatStringLiteral(body, old, sourceName, 8); if(r.count) result.push(`literal:${old}->${sourceName} x${r.count}`);
      }
    }
    if(/^EU_EAQI/i.test(String(resolved && resolved.algorithm || ''))){
      for(const pair of [['中国 (AQI)','欧洲(EAQI)'],['中国(AQI)','欧洲(EAQI)'],['AQI (CN)','AQI (EU)'],['AQI(CN)','AQI(EU)'],['HJ6332012.2604','欧洲(EAQI)']]){
        const r=patchFlatStringLiteral(body, pair[0], pair[1], 8); if(r.count) result.push(`literal:${pair[0]}->${pair[1]} x${r.count}`);
      }
    }
    return result;
  }
  function pollutantCategory(levelAlgo, key, value){
    const v=num(value); if(v==null) return 0;
    const alg=String(levelAlgo||'').toUpperCase();
    if(alg.includes('EU_EAQI')){
      const bands={pm25:[10,20,25,50,75],pm10:[20,40,50,100,150],no2:[40,90,120,230,340],o3:[50,100,130,240,380],so2:[100,200,350,500,750],co:[4400,9400,12400,15400,30400]};
      const arr=bands[key]; if(!arr) return 1;
      for(let i=0;i<arr.length;i++) if(v<=arr[i]) return i+1;
      return 6;
    }
    const bands={pm25:[35,75,115,150,250],pm10:[50,150,250,350,420],no2:[100,200,700,1200,2340],so2:[150,500,650,800,1600],o3:[160,200,300,400,800],co:[5000,10000,35000,60000,90000]};
    const arr=bands[key]; if(!arr) return aqiCategoryIndex(v);
    for(let i=0;i<arr.length;i++) if(v<=arr[i]) return i+1;
    return 6;
  }
  function patchPollutantsInPlace(body, airQ, aqResolved, bundle){
    const aq=bundle && bundle.airQuality || {};
    const p=aq.pollutants || {};
    const vec=getTableFieldTarget(body, airQ, 4);
    if(!vec || vec+4>body.length) return {count:0, logs:['pollutants:no vector']};
    const len=u32(body,vec);
    if(!Number.isFinite(len) || len<1 || len>32) return {count:0, logs:[`pollutants:bad len ${len}`]};
    const enumToKey={5:'no2',7:'pm10',8:'so2',9:'co',10:'o3',11:'pm25'};
    let count=0; const logs=[];
    for(let i=0;i<len;i++){
      const elemLoc=vec+4+i*4; const rel=u32(body,elemLoc); if(!rel) continue;
      const t=elemLoc+rel; const ti=inspectRootAt(body,t); if(!ti.ok) continue;
      const enumOff=getFieldOffset(body,t,0), valueOff=getFieldOffset(body,t,1), catOff=getFieldOffset(body,t,2);
      if(!enumOff || !valueOff) continue;
      const code=body[t+enumOff]; const key=enumToKey[code]; if(!key || p[key] == null) continue;
      const old=f32(body,t+valueOff); const nv=Number(p[key]);
      if(!Number.isFinite(nv)) continue;
      setF32(body,t+valueOff,nv);
      const cat=pollutantCategory(aqResolved && aqResolved.algorithm, key, nv);
      if(catOff) body[t+catOff]=cat&255;
      count++; logs.push(`${key}:${Math.round(old*100)/100}->${nv},cat=${cat}`);
    }
    return {count, logs};
  }
  function patchNextHourInPlace(body, bundle){
    const mode=String(ARG['Provider.PatchMode']||'').toLowerCase();
    if(!/all|nexthour/.test(mode)) return {patched:false, reason:'mode not InjectAll/InjectNextHour'};
    const nh=bundle && bundle.nextHour;
    if(!nh || !(nh.minutes||[]).length) return {patched:false, reason:'no provider minutes'};
    const rootInfo=inspectRoot(body);
    if(!rootInfo.ok) return {patched:false, reason:`root ${rootInfo.reason}`};
    const nextHour=getTableFieldTarget(body, rootInfo.root, 4);
    if(!nextHour){
      return {patched:false, reason:'WK2 field4 forecastNextHour missing; need native template with field4 present'};
    }
    try{ storeSet('WeatherKit.iOS27.NextHourTemplate', {savedAt:Date.now(), note:'field4 present', len:body.length}); }catch(_){}
    return {patched:false, reason:'field4 present but minute-vector schema not enabled in this build'};
  }
  function patchAirQualityInPlace(body, bundle){
    const mode = String(ARG['Provider.PatchMode'] || 'Preserve').toLowerCase();
    if(!/inject|aqi|all/.test(mode)) return {patched:false, reason:`PatchMode=${ARG['Provider.PatchMode']}`};
    const resolved = resolveAirQualityForPatch(bundle);
    if(!resolved || !Number.isFinite(Number(resolved.aqi))) return {patched:false, reason:'no provider AQI'};
    const rootInfo = inspectRoot(body);
    if(!rootInfo.ok) return {patched:false, reason:`root ${rootInfo.reason}`};
    const airQ = getTableFieldTarget(body, rootInfo.root, 0);
    if(!airQ) return {patched:false, reason:'WK2 field0 airQuality missing'};
    const airInfo = inspectRootAt(body, airQ);
    if(!airInfo.ok) return {patched:false, reason:`airQuality ${airInfo.reason}`};
    const aqiOff = getFieldOffset(body, airQ, 2);
    const catOff = getFieldOffset(body, airQ, 1);
    if(!aqiOff) return {patched:false, reason:'AQI scalar field missing'};
    const oldAqi = u16(body, airQ + aqiOff);
    const oldCat = catOff ? body[airQ + catOff] : 0;
    setU16(body, airQ + aqiOff, resolved.aqi);
    const cat = Number(resolved.categoryIndex) || aqiCategoryIndex(resolved.aqi);
    if(catOff) body[airQ + catOff] = cat & 255;
    const metaPatches = patchAirQualityMetaStructured(body, airQ, resolved);
    const pol = patchPollutantsInPlace(body, airQ, resolved, bundle);
    return {patched:true, oldAqi, newAqi:Math.round(Number(resolved.aqi)), oldCat, newCat:cat, provider:resolved.sourceProvider || '', algorithm:resolved.algorithm || '', note:resolved.note || '', stringPatches:metaPatches, pollutantPatches:pol.logs, pollutantCount:pol.count};
  }
  function inspectRootAt(b, root){
    if(!b || root<4 || root+4>b.length) return {ok:false,reason:'bad table pos'};
    const vt=root-i32(b,root); if(vt<0 || vt+4>b.length) return {ok:false,reason:`bad vtable ${vt}`};
    const vtLen=u16(b,vt), objSize=u16(b,vt+2); if(vtLen<4 || vtLen>512 || vt+vtLen>b.length) return {ok:false,reason:`bad vtLen ${vtLen}`};
    const n=(vtLen-4)>>1, present=[]; for(let i=0;i<n;i++){ if(u16(b,vt+4+i*2)) present.push(i); }
    return {ok:true,root,vt,vtLen,objSize,fieldCount:n,present};
  }
  function locFromUrl(url){
    const u=new URL(url); const m=u.pathname.match(/\/api\/v2\/weather\/[^/]+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    if(!m) throw new Error('no lat/lon in WeatherKit URL');
    return {lat:Number(m[1]), lon:Number(m[2]), locale:(u.pathname.split('/')[4]||''), timezone:u.searchParams.get('timezone')||'', country:u.searchParams.get('country')||''};
  }
  function keyOf(loc){ return `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`; }
  function storeSet(k,v){ try{ if(typeof $persistentStore!=='undefined') $persistentStore.write(JSON.stringify(v), k); }catch(e){ log('WARN',`store write fail ${k}: ${e}`); } }
  function storeGet(k){ try{ if(typeof $persistentStore==='undefined') return null; const s=$persistentStore.read(k); return s?JSON.parse(s):null; }catch(_){ return null; } }
  function now(){ return Date.now(); }
  function isFresh(x,ttl){ return x && x.savedAt && (Date.now() - x.savedAt) < ttl*1000; }
  function getJSON(url, headers, timeout){
    return new Promise((resolve,reject)=>{
      const req = {url, headers: headers || {}};
      const timer = setTimeout(()=>reject(new Error('timeout')), timeout || 8000);
      $httpClient.get(req, (err, resp, data) => {
        clearTimeout(timer);
        if(err) return reject(err);
        const status = resp && resp.status;
        if(status && (status<200 || status>=300)) return reject(new Error(`HTTP ${status}`));
        try{ resolve(typeof data === 'string' ? JSON.parse(data) : data); }catch(e){ reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
  }
  function chooseProvider(kind){
    const wanted = String(ARG[kind==='nextHour'?'NextHour.Provider':'AirQuality.Provider']||'Auto');
    if(wanted !== 'Auto') return wanted;
    if(kind==='nextHour'){
      if(ARG['API.QWeather.Token']) return 'QWeather';
      if(ARG['API.ColorfulClouds.Token']) return 'ColorfulClouds';
      return 'WeatherKit';
    }
    if(ARG['API.WAQI.Token']) return 'WAQI';
    if(ARG['API.QWeather.Token']) return 'QWeather';
    if(ARG['API.ColorfulClouds.Token']) return 'ColorfulClouds';
    return 'WeatherKit';
  }
  function num(x){ const n=Number(x); return Number.isFinite(n)?n:null; }
  function cleanPollutants(p){
    const out={};
    [['pm25',['pm25','pm2p5','pm2_5']],['pm10',['pm10']],['o3',['o3']],['no2',['no2']],['so2',['so2']],['co',['co']]].forEach(([std,keys])=>{
      for(const k of keys){ if(p && p[k] != null){ const v = (typeof p[k] === 'object' && p[k].v != null) ? p[k].v : p[k]; const n=num(v); if(n!=null){out[std]=n; break;} } }
    });
    return out;
  }
  function categoryCN(aqi){
    aqi=num(aqi); if(aqi==null) return ''; if(aqi<=50)return '优'; if(aqi<=100)return '良'; if(aqi<=150)return '轻度污染'; if(aqi<=200)return '中度污染'; if(aqi<=300)return '重度污染'; return '严重污染';
  }
  function normalizeMinutes(list, provider){
    return (list||[]).slice(0,120).map((x,i)=>{
      const time = x.fxTime || x.datetime || x.time || x.date || null;
      let precip = x.precip ?? x.precipitation ?? x.value ?? x.intensity ?? x.rain;
      let prob = x.prob ?? x.probability ?? x.precipitationProbability ?? null;
      return { index:i, time: time ? String(time) : null, precipMmH: num(precip) ?? 0, probability: num(prob), type: String(x.type || x.precipType || x.weather || provider || '') };
    });
  }
  async function fetchCaiyun(loc, kinds){
    const token=ARG['API.ColorfulClouds.Token']; if(!token) throw new Error('missing ColorfulClouds token');
    const url=`https://api.caiyunapp.com/v2.6/${encodeURIComponent(token)}/${loc.lon},${loc.lat}/weather?lang=zh_CN&unit=metric:v2&alert=false&dailysteps=10&hourlysteps=72`;
    const j=await getJSON(url, {'Accept':'application/json'}, 10000);
    const r=j && j.result || {};
    const out={provider:'ColorfulClouds', rawStatus:j.status || j.error || ''};
    if(kinds.nextHour){
      const arr = (r.minutely && (r.minutely.precipitation_2h || r.minutely.precipitation)) || [];
      out.nextHour = { provider:'ColorfulClouds', summary:r.minutely && r.minutely.description || '', minutes:normalizeMinutes(arr.map((v,i)=>({value:v,index:i})), 'ColorfulClouds') };
    }
    if(kinds.airQuality){
      const aq = r.realtime && r.realtime.air_quality || {};
      const aqiObj = aq.aqi || {};
      const aqi = num(aqiObj.chn ?? aqiObj.usa ?? aqiObj.value ?? aq.aqi);
      out.airQuality = { provider:'ColorfulClouds', aqi, scale: aqiObj.chn!=null?'CN':(aqiObj.usa!=null?'US':''), category:categoryCN(aqi), primary:'', pollutants:cleanPollutants(aq), updatedAt:new Date().toISOString() };
    }
    return out;
  }
  async function fetchQWeatherMinutely(loc){
    const token=ARG['API.QWeather.Token']; if(!token) throw new Error('missing QWeather token');
    const host=(ARG['API.QWeather.Host']||'devapi.qweather.com').replace(/^https?:\/\//,'').replace(/\/+$/,'');
    const url=`https://${host}/v7/minutely/5m?location=${loc.lon},${loc.lat}&key=${encodeURIComponent(token)}`;
    const j=await getJSON(url, {'Accept':'application/json'}, 10000);
    if(j.code && !/^2/.test(String(j.code))) throw new Error(`QWeather minutely code=${j.code}`);
    return { provider:'QWeather', summary:j.summary || '', minutes:normalizeMinutes(j.minutely || [], 'QWeather'), updatedAt:j.updateTime || new Date().toISOString() };
  }
  async function fetchQWeatherAQI(loc){
    const token=ARG['API.QWeather.Token']; if(!token) throw new Error('missing QWeather token');
    const host=(ARG['API.QWeather.Host']||'devapi.qweather.com').replace(/^https?:\/\//,'').replace(/\/+$/,'');
    const url=`https://${host}/v7/air/now?location=${loc.lon},${loc.lat}&key=${encodeURIComponent(token)}`;
    const j=await getJSON(url, {'Accept':'application/json'}, 10000);
    if(j.code && !/^2/.test(String(j.code))) throw new Error(`QWeather air code=${j.code}`);
    const n=j.now || {};
    const aqi=num(n.aqi);
    return { provider:'QWeather', aqi, scale:'CN', category:n.category || categoryCN(aqi), primary:n.primary || '', pollutants:cleanPollutants(n), updatedAt:n.pubTime || j.updateTime || new Date().toISOString() };
  }
  async function fetchWAQI(loc){
    const token=ARG['API.WAQI.Token']; if(!token) throw new Error('missing WAQI token');
    const url=`https://api.waqi.info/feed/geo:${loc.lat};${loc.lon}/?token=${encodeURIComponent(token)}`;
    const j=await getJSON(url, {'Accept':'application/json'}, 10000);
    if(j.status !== 'ok') throw new Error(`WAQI status=${j.status || 'unknown'}`);
    const d=j.data || {}; const aqi=num(d.aqi);
    return { provider:'WAQI', aqi, scale:'WAQI', category:categoryCN(aqi), primary:d.dominentpol || '', pollutants:cleanPollutants(d.iaqi || {}), city:d.city && d.city.name || '', updatedAt:d.time && (d.time.iso || d.time.s) || new Date().toISOString() };
  }
  async function getProviderBundle(loc){
    const ttl=Math.max(30, Number(ARG['Provider.CacheTTL']||300));
    const cacheKey=`WeatherKit.iOS27.ProviderCache.${keyOf(loc)}`;
    const cached=storeGet(cacheKey); if(isFresh(cached, ttl)){ log('INFO',`provider cache hit ${keyOf(loc)} age=${Math.round((Date.now()-cached.savedAt)/1000)}s`); return cached; }
    const nextProvider = chooseProvider('nextHour');
    const aqProvider = chooseProvider('airQuality');
    const bundle={ savedAt:Date.now(), location:loc, selected:{nextHour:nextProvider, airQuality:aqProvider}, nextHour:null, airQuality:null, errors:[] };
    const jobs=[];
    if(nextProvider==='QWeather') jobs.push(fetchQWeatherMinutely(loc).then(v=>bundle.nextHour=v).catch(e=>bundle.errors.push(`QWeather nextHour: ${e.message||e}`)));
    if(nextProvider==='ColorfulClouds') jobs.push(fetchCaiyun(loc,{nextHour:true,airQuality:false}).then(v=>bundle.nextHour=v.nextHour).catch(e=>bundle.errors.push(`ColorfulClouds nextHour: ${e.message||e}`)));
    if(aqProvider==='QWeather') jobs.push(fetchQWeatherAQI(loc).then(v=>bundle.airQuality=v).catch(e=>bundle.errors.push(`QWeather AQI: ${e.message||e}`)));
    if(aqProvider==='WAQI') jobs.push(fetchWAQI(loc).then(v=>bundle.airQuality=v).catch(e=>bundle.errors.push(`WAQI AQI: ${e.message||e}`)));
    if(aqProvider==='ColorfulClouds') jobs.push(fetchCaiyun(loc,{nextHour:false,airQuality:true}).then(v=>bundle.airQuality=v.airQuality).catch(e=>bundle.errors.push(`ColorfulClouds AQI: ${e.message||e}`)));
    await Promise.all(jobs);
    storeSet(cacheKey, bundle);
    return bundle;
  }
  async function main(){
    const ct=hget($response.headers,'Content-Type');
    if(!/application\/vnd\.apple\.flatbuffer/i.test(ct) || !/WK2\.Weather/i.test(ct)){ log('DEBUG',`skip content-type=${ct}`); $done({}); return; }
    const loc=locFromUrl($request.url);
    const body=asU8($response.body);
    const info=inspectRoot(body);
    if(info.ok) log('INFO',`WK2.Weather ${keyOf(loc)} len=${body.length} fields=${info.fieldCount} present=[${info.present.join(',')}]`);
    else log('WARN',`WK2 inspect fail: ${info.reason}`);

    const bundle=await getProviderBundle(loc);
    const nh = bundle.nextHour ? `${bundle.nextHour.provider} minutes=${(bundle.nextHour.minutes||[]).length} summary=${bundle.nextHour.summary||''}` : 'none';
    const aq = bundle.airQuality ? `${bundle.airQuality.provider} aqi=${bundle.airQuality.aqi} ${bundle.airQuality.category||''} primary=${bundle.airQuality.primary||''}` : 'none';
    log('INFO',`provider: nextHour=${nh}; airQuality=${aq}`);
    if(bundle.errors.length){ log('WARN',`provider errors: ${bundle.errors.join(' | ')}`); if(ARG.DebugNotify==='1') notify('WeatherKit Provider', '第三方源异常', bundle.errors.join('\n')); }

    let outBody = null;
    const mode = String(ARG['Provider.PatchMode'] || 'Preserve').toLowerCase();
    if(mode !== 'preserve'){
      const patched = patchAirQualityInPlace(body, bundle);
      if(patched.patched){
        outBody = body;
        log('WARN',`injectAQI: ${patched.oldAqi}/${patched.oldCat} -> ${patched.newAqi}/${patched.newCat} provider=${patched.provider || 'unknown'} algorithm=${patched.algorithm || ''}; ${patched.note || ''}; meta=[${(patched.stringPatches||[]).join('|')||'none'}]; pollutants=${patched.pollutantCount||0}[${(patched.pollutantPatches||[]).join('|')||'none'}]`);
      } else {
        log('WARN',`injectAQI skipped: ${patched.reason}; nextHour still preserve`);
      }
    }
    if(mode !== 'preserve'){
      const nhPatch = patchNextHourInPlace(body, bundle);
      if(nhPatch.patched){ outBody = body; log('WARN',`injectNextHour: ok ${nhPatch.reason||''}`); }
      else if(/all|nexthour/.test(mode)) log('WARN',`injectNextHour skipped: ${nhPatch.reason}`);
    }
    if(outBody) $done({ body: outBody }); else $done({});
  }
  main().catch(e=>{ console.log(`[${NAME}] ERROR ${e && e.stack || e}`); $done({}); });
})();
