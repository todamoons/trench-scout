"use strict";
// Background worker: coin alerts + narrative watchlist feed. Runs even when the side panel is closed
// (as long as Chrome is open). Read-only: it only fetches public market data and shows notifications.
importScripts("shared.js");

chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(()=>{});

const TICK = "tick";
function ensureAlarm(){ chrome.alarms.get(TICK, a => { if(!a) chrome.alarms.create(TICK, {periodInMinutes:1}) }) }
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

const get = keys => chrome.storage.local.get(keys);
const set = obj => chrome.storage.local.set(obj);

async function notify(title, message, url){
  const id = "ts-"+Date.now()+"-"+Math.random().toString(36).slice(2,7);
  const {notifUrls={}, alertLog=[]} = await get(["notifUrls","alertLog"]);
  if(url) notifUrls[id] = url;
  const keys = Object.keys(notifUrls); if(keys.length>50) keys.slice(0,keys.length-50).forEach(k=>delete notifUrls[k]);
  alertLog.unshift({t:Date.now(), title, message, url:url||null});
  await set({notifUrls, alertLog:alertLog.slice(0,40)});
  chrome.notifications.create(id, {type:"basic", iconUrl:"icon128.png", title, message, priority:2});
}
chrome.notifications.onClicked.addListener(async id => {
  const {notifUrls={}} = await get("notifUrls");
  const u = safeHttps(notifUrls[id]);
  if(u) chrome.tabs.create({url:u});
  chrome.notifications.clear(id);
});

// ---------- watched coins ----------
// watched[mint] = {sym, url, addedAt, peak, lastPrice, startLiq, devPct, top:{addr:pct}, rcAt, fired:{}}
const pools = rc => new Set((rc.markets||[]).flatMap(m=>[m.pubkey,m.liquidityA,m.liquidityB,m.liquidityAAccount,m.liquidityBAccount].filter(Boolean)));
function holderMap(rc){
  const known = rc.knownAccounts||{}, pl = pools(rc), out = {};
  (rc.topHolders||[]).filter(h=>!known[h.address]&&!known[h.owner]&&!pl.has(h.address)&&!pl.has(h.owner)).slice(0,5)
    .forEach(h => { out[h.owner||h.address] = h.pct||0 });
  return out;
}
function devPct(rc){
  try{
    const supply = Number(rc.token&&rc.token.supply), bal = Number(rc.creatorBalance);
    if(!supply || isNaN(bal)) return null;
    return bal/supply*100;
  }catch(e){ return null }
}
async function initWatch(mint, info){
  const {watched={}} = await get("watched");
  const rc = await getJSON("https://api.rugcheck.xyz/v1/tokens/"+mint+"/report").catch(()=>null);
  watched[mint] = {sym:info.sym, url:info.url, addedAt:Date.now(), peak:info.price||0, lastPrice:info.price||0,
    startLiq:info.liq||0, devPct: rc?devPct(rc):null, top: rc?holderMap(rc):{}, rcAt:Date.now(), fired:{}};
  await set({watched});
}
async function checkWatched(){
  const {watched={}} = await get("watched");
  const mints = Object.keys(watched); if(!mints.length) return;
  const pairs = await batchTokens(mints);
  for(const m of mints){
    const w = watched[m], p = pairs[m];
    if(!p) continue;
    const price = Number(p.priceUsd)||0, liq = (p.liquidity&&p.liquidity.usd)||0;
    const tag = "$"+w.sym;
    if(w.lastPrice && price && price < w.lastPrice*0.8 && Date.now()-(w.fired.fastAt||0) > 600000){ w.fired.fastAt = Date.now(); await notify(tag+" dumping fast", "Down "+Math.round((1-price/w.lastPrice)*100)+"% in the last minute.", w.url) }
    if(price > w.peak) w.peak = price;
    if(w.peak && price < w.peak*0.5 && !w.fired.half){ w.fired.half = true; await notify(tag+" down 50% from peak", "Peak since you started watching was "+w.peak.toPrecision(3)+", now "+price.toPrecision(3)+".", w.url) }
    if(w.startLiq>2000 && liq < w.startLiq*0.6 && !w.fired.liq){ w.fired.liq = true; await notify(tag+": liquidity pulled", "Liquidity fell from "+usd(w.startLiq)+" to "+usd(liq)+". Possible rug.", w.url) }
    w.lastPrice = price;

    // holder checks every 3 minutes (RugCheck is heavier)
    if(Date.now()-(w.rcAt||0) >= 170000){
      w.rcAt = Date.now();
      const rc = await getJSON("https://api.rugcheck.xyz/v1/tokens/"+m+"/report").catch(()=>null);
      if(rc){
        const dp = devPct(rc);
        if(w.devPct!=null && dp!=null && w.devPct>0.5 && dp < w.devPct*0.5)
          await notify(tag+": dev is selling", "Dev wallet went from "+w.devPct.toFixed(1)+"% to "+dp.toFixed(1)+"% of supply.", w.url);
        if(dp!=null) w.devPct = dp;
        const now = holderMap(rc);
        for(const [addr,pct] of Object.entries(w.top||{})){
          const np = now[addr] ?? ((rc.topHolders||[]).find(h=>(h.owner||h.address)===addr)||{}).pct ?? 0;
          if(pct>=1.5 && np < pct*0.5)
            await notify(tag+": top holder dumped", "A top wallet ("+addr.slice(0,4)+"…"+addr.slice(-4)+") went from "+pct.toFixed(1)+"% to "+np.toFixed(1)+"%.", w.url);
        }
        w.top = now;
      }
    }
  }
  // re-read before writing so we don't undo a watch/unwatch made during this tick
  const fresh = (await get("watched")).watched || {};
  for(const m of Object.keys(fresh)) if(watched[m]) fresh[m] = {...watched[m]};
  await set({watched:fresh});
}

// ---------- narrative watchlist feed ----------
async function checkWatchlist(){
  const {watchlist=[], seenHits=[], hits=[]} = await get(["watchlist","seenHits","hits"]);
  if(!watchlist.length) return;
  const seen = new Set(seenHits), newHits = [];
  for(const kw of watchlist.slice(0,10)){
    let d; try{ d = await getJSON("https://api.dexscreener.com/latest/dex/search?q="+encodeURIComponent(kw)) }catch(e){ continue }
    for(const p of (d.pairs||[])){
      if(p.chainId!=="solana" || !p.baseToken) continue;
      if(!p.pairCreatedAt || Date.now()-p.pairCreatedAt > 6*3600e3) continue;
      const mint = p.baseToken.address;
      if(seen.has(mint)) continue;
      if(!matchKeywords([kw], p.baseToken.name, p.baseToken.symbol).length) continue;
      seen.add(mint);
      newHits.push({mint, kw, name:p.baseToken.name, sym:p.baseToken.symbol, mc:p.marketCap||p.fdv||0, url:axiomUrl(p), t:Date.now()});
    }
  }
  // also check fresh DexScreener token profiles (have descriptions)
  try{
    const prof = await getJSON("https://api.dexscreener.com/token-profiles/latest/v1");
    for(const t of (Array.isArray(prof)?prof:[])){
      if(t.chainId!=="solana" || seen.has(t.tokenAddress)) continue;
      const ks = matchKeywords(watchlist, t.description);
      if(!ks.length) continue;
      seen.add(t.tokenAddress);
      newHits.push({mint:t.tokenAddress, kw:ks[0], name:(t.description||"").slice(0,40), sym:"?", mc:0, url:safeHttps(t.url)||null, t:Date.now()});
    }
  }catch(e){}
  if(!newHits.length){ await set({seenHits:[...seen].slice(-500)}); return }
  for(const h of newHits.slice(0,3)) await notify("Watchlist: "+h.kw, (h.sym!=="?"?"$"+h.sym+" · ":"")+h.name+(h.mc?" · MC "+usd(h.mc):""), h.url);
  if(newHits.length>3) await notify("Watchlist", (newHits.length-3)+" more new coins match your topics. Open Trench Scout.", null);
  await set({seenHits:[...seen].slice(-500), hits:[...newHits, ...hits].slice(0,30)});
}


// ---------- narrative radar: one web-searched trend briefing every 15 minutes ----------
const RADAR_EVERY = 15*60000;
let radarBusy = false;
async function refreshRadar(force){
  const {key, radarOn=true, radar} = await get(["key","radarOn","radar"]);
  if(!key || radarBusy) return {ok:false, error: key ? "busy" : "no key"};
  if(!force && (!radarOn || (radar && Date.now()-radar.t < RADAR_EVERY))) return {ok:true, skipped:true};
  radarBusy = true;
  await set({radarState:{running:true, t:Date.now()}});
  try{
    const today = new Date().toISOString().slice(0,10);
    const prompt = `Today is ${today}. You brief a Solana memecoin trader on what is trending RIGHT NOW (last ~48 hours) that new memecoins are likely being launched about.
Search the web (up to 5 searches) across: viral streamer/creator moments (Kai Cenat, IShowSpeed, Adin Ross, xQc etc.), celebrity and sports news, viral internet memes and animals, major political/world news, AI and tech news, crypto Twitter metas and narratives, big events happening today.
Return ONLY a JSON array (no prose, no markdown) of up to 25 items, hottest first:
[{"topic":"short name","keywords":["names, nicknames, catchphrases and likely ticker words a coin would use"],"why":"one short sentence: what happened and when","heat":1-5,"people":["key names"]}]
Heat 5 = everywhere right now, 1 = minor. Prefer specific moments over generic themes. Do not include URLs.`;
    const r = await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
      body:JSON.stringify({model:"claude-sonnet-5-5", max_tokens:3000, tools:[{type:"web_search_20250305",name:"web_search",max_uses:5}], messages:[{role:"user",content:prompt}]}),
      signal:AbortSignal.timeout(120000)
    });
    if(!r.ok) throw new Error("Claude "+r.status);
    const d = await r.json();
    const text = (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
    const m = text.match(/\[[\s\S]*\]/);
    if(!m) throw new Error("no trend list returned");
    const items = JSON.parse(m[0]).filter(x=>x && x.topic).slice(0,25).map(x=>({
      topic:String(x.topic).slice(0,60), why:String(x.why||"").slice(0,200),
      keywords:(Array.isArray(x.keywords)?x.keywords:[]).map(String).slice(0,10),
      people:(Array.isArray(x.people)?x.people:[]).map(String).slice(0,6),
      heat:Math.max(1,Math.min(5,Number(x.heat)||1))
    }));
    await set({radar:{t:Date.now(), items}, radarState:{running:false, t:Date.now()}});
    return {ok:true, n:items.length};
  }catch(e){
    await set({radarState:{running:false, t:Date.now(), error:String(e.message||e)}});
    return {ok:false, error:String(e.message||e)};
  }finally{ radarBusy = false }
}

let tickN = 0, busy = false;
chrome.alarms.onAlarm.addListener(async a => {
  if(a.name!==TICK) return;
  refreshRadar(false).catch(()=>{});
  if(busy) return;
  busy = true;
  try{
    await checkWatched().catch(()=>{});
    if(tickN++ % 2 === 0) await checkWatchlist().catch(()=>{});
  } finally { busy = false }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if(msg && msg.type==="watch"){ initWatch(msg.mint, msg.info).then(()=>reply({ok:true})).catch(e=>reply({ok:false,error:String(e)})); return true }
  if(msg && msg.type==="unwatch"){ get("watched").then(({watched={}})=>{ delete watched[msg.mint]; return set({watched}) }).then(()=>reply({ok:true})); return true }
  if(msg && msg.type==="radarNow"){ refreshRadar(true).then(reply); return true }
  if(msg && msg.type==="scanWatchlistNow"){ checkWatchlist().then(()=>reply({ok:true})).catch(()=>reply({ok:false})); return true }
});
