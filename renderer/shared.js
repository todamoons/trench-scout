"use strict";
// Shared helpers for the side panel and the background alert worker.

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const usd = n => n==null||isNaN(n) ? "—" : "$"+(n>=1e9?(n/1e9).toFixed(2)+"B":n>=1e6?(n/1e6).toFixed(2)+"M":n>=1e3?(n/1e3).toFixed(1)+"K":Math.round(n));
const num = n => n>=1e6?(n/1e6).toFixed(1)+"M":n>=1e3?(n/1e3).toFixed(1)+"K":String(n);
function age(ms){
  if(!ms) return "—";
  const m = (Date.now()-ms)/60000;
  return m<60 ? Math.round(m)+"m" : m<1440 ? (m/60).toFixed(1)+"h" : Math.round(m/1440)+"d";
}
function extractAddr(text){
  const m = (text||"").trim().match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
  return m ? m[m.length-1] : null;
}
function safeHttps(u){
  try{ const x = new URL(u); return x.protocol==="https:" ? x.href : null }catch(e){ return null }
}
async function getJSON(url, opts={}){
  const {timeout, ...rest} = opts;
  const r = await fetch(url, {...rest, signal: AbortSignal.timeout(timeout||8000)});
  if(!r.ok) throw new Error(new URL(url).hostname+" returned "+r.status);
  return r.json();
}
const axiomUrl = pair => "https://axiom.trade/meme/"+pair.pairAddress;

// Most-traded Solana pool (liquidity can be faked on junk pools).
function pickPair(list){
  const pairs = (list||[]).filter(p => p && p.chainId==="solana" && p.baseToken);
  pairs.sort((a,b)=>((b.volume&&b.volume.h24)||0)-((a.volume&&a.volume.h24)||0));
  return pairs[0] || null;
}
async function findPair(addr){
  const urls = [
    "https://api.dexscreener.com/tokens/v1/solana/"+addr,
    "https://api.dexscreener.com/latest/dex/tokens/"+addr,
    "https://api.dexscreener.com/latest/dex/pairs/solana/"+addr
  ];
  let lastErr = null, reached = false;
  for(const u of urls){
    try{
      const d = await getJSON(u); reached = true;
      const p = pickPair(Array.isArray(d) ? d : (d.pairs || (d.pair?[d.pair]:[])));
      if(p) return p;
    }catch(e){ lastErr = e }
  }
  if(!reached) throw new Error("Couldn't reach DexScreener ("+(lastErr&&lastErr.message||"network error")+"). Check your connection.");
  return null;
}
// Up to 30 mints per call. Returns {mint: bestPair}
async function batchTokens(mints){
  const out = {};
  for(let i=0;i<mints.length;i+=30){
    const chunk = mints.slice(i,i+30);
    try{
      const d = await getJSON("https://api.dexscreener.com/tokens/v1/solana/"+chunk.join(","));
      const by = {};
      (Array.isArray(d)?d:[]).forEach(p => { const m=p.baseToken&&p.baseToken.address; if(m) (by[m]=by[m]||[]).push(p) });
      for(const m of chunk) out[m] = pickPair(by[m]);
    }catch(e){ for(const m of chunk) if(!(m in out)) out[m] = undefined }
  }
  return out;
}

// Narrative watchlist matching: a keyword matches if all its words appear in the text.
function norm(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9 ]+/g," ").replace(/\s+/g," ").trim() }
function matchKeywords(keywords, ...texts){
  const hay = " "+norm(texts.join(" "))+" ";
  const squashed = hay.replace(/ /g,"");
  return (keywords||[]).filter(k => {
    const words = norm(k).split(" ").filter(Boolean);
    if(!words.length) return false;
    // whole-word match, or the keyword squashed together inside a ticker/name ("kaicenat")
    const joined = words.join("");
    return words.every(w => hay.includes(" "+w+" ")) || (joined.length>=5 && squashed.includes(joined));
  });
}

// ---------- Dev wallet history (pump.fun launches via Helius) ----------
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
async function devLaunches(creator, heliusKey, maxPages=3){
  const url = "https://mainnet.helius-rpc.com/v1/parsed-events/transaction-history?api-key="+encodeURIComponent(heliusKey);
  const launches = []; let token, pages = 0, more = false;
  do{
    const body = {address:creator, limit:100, sortOrder:"desc", commitment:"confirmed"};
    if(token) body.paginationToken = token;
    const r = await fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body), signal:AbortSignal.timeout(10000)});
    if(r.status===401||r.status===403) throw new Error("Helius rejected the API key. Check it in Settings.");
    if(r.status===429) throw new Error("Helius rate limit hit. Try again in a minute.");
    if(!r.ok) throw new Error("Helius error "+r.status);
    const page = await r.json();
    for(const res of (page.data||[])){
      if(res.parserStatus!=="OK" || !res.parsed || res.parsed.transactionStatus!=="OK") continue;
      for(const ix of (res.parsed.instructions||[])){
        if(ix.programId!==PUMP_PROGRAM || !/^create(_v2)?$/.test(ix.instructionName||"")) continue;
        const dec = ix.decoded||{}, args = dec.args||{};
        const mint = ((dec.accounts||[]).find(a=>a.name==="mint")||{}).pubkey;
        if(mint) launches.push({mint, name:args.name||"?", symbol:args.symbol||"?", blockTime:res.parsed.blockTime||res.blockTime||null});
      }
    }
    token = page.paginationToken; pages++;
    more = !!token;
  } while(token && pages<maxPages);
  return {launches, more};
}
// Classify past launches by what they're worth today.
async function devHistory(creator, currentMint, heliusKey){
  const {launches, more} = await devLaunches(creator, heliusKey);
  const past = launches.filter(l => l.mint!==currentMint);
  const uniq = [...new Map(past.map(l=>[l.mint,l])).values()].slice(0,60);
  const pairs = await batchTokens(uniq.map(l=>l.mint));
  let dead=0, alive=0, ran=0, best=null;
  for(const l of uniq){
    const p = pairs[l.mint];
    const mc = p ? (p.marketCap||p.fdv||0) : 0;
    l.mc = mc; l.pair = p||null;
    if(mc>=250000) ran++; else if(mc>=10000) alive++; else dead++;
    if(!best || mc>best.mc) best = l;
  }
  const n = uniq.length;
  let lvl = "", note = "";
  if(n===0){ lvl="good"; note="First pump.fun launch from this wallet." }
  else if(ran>0 && dead/n<0.7){ lvl="good"; note="Has launched coins that held value." }
  else if(n>=10 || (n>=3 && dead/n>=0.8)){ lvl="bad"; note="Serial launcher: most past coins are dead." }
  else if(dead/n>=0.5){ lvl="warn"; note="Most past coins died." }
  else { lvl="good"; note="Past coins mostly still trading." }
  return {n, more, dead, alive, ran, best, list:uniq, lvl, note};
}
