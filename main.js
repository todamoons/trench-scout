"use strict";
// Trench Scout desktop app — main process.
// Security: the window only loads the app's own files, can't navigate anywhere else, has no Node access,
// and every network request goes through an allowlist firewall below. API keys are encrypted with
// Windows' own data protection (safeStorage). The app never touches a wallet.

const { app, BrowserWindow, Tray, Menu, Notification, clipboard, ipcMain, shell, session, protocol, net, safeStorage, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const { pathToFileURL } = require("url");

if(!app.requestSingleInstanceLock()){ app.quit(); return }
app.setAppUserModelId("com.trenchscout.app");

protocol.registerSchemesAsPrivileged([{ scheme:"app", privileges:{ standard:true, secure:true, supportFetchAPI:true } }]);

// ---------- network allowlist ----------
const API_HOSTS = ["api.dexscreener.com","api.rugcheck.xyz","api.anthropic.com","api.x.com","mainnet.helius-rpc.com",
  "ipfs.io","gateway.pinata.cloud","cf-ipfs.com","arweave.net","nftstorage.link","dweb.link"];
const API_SUFFIXES = [".mypinata.cloud",".arweave.net",".rapidlaunch.io"];
const ASSET_HOSTS = ["fonts.googleapis.com","fonts.gstatic.com"];
const UPDATE_HOSTS = ["github.com","api.github.com","objects.githubusercontent.com","release-assets.githubusercontent.com","github-releases.githubusercontent.com"];
const isApiHost = h => API_HOSTS.includes(h) || API_SUFFIXES.some(s => h.endsWith(s));
const httpsOnly = u => { try{ return new URL(u).protocol==="https:" }catch(e){ return false } };

// ---------- settings store (JSON file; secrets encrypted) ----------
const SECRET = new Set(["key","xToken","heliusKey"]);
let storePath, data = {};
function loadStore(){
  storePath = path.join(app.getPath("userData"), "store.json");
  try{ data = JSON.parse(fs.readFileSync(storePath, "utf8")) }catch(e){ data = {} }
}
let saveTimer = null;
function persist(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try{ fs.writeFileSync(storePath+".tmp", JSON.stringify(data)); fs.renameSync(storePath+".tmp", storePath) }catch(e){ console.error(e) }
  }, 200);
}
function readVal(k){
  const v = data[k];
  if(SECRET.has(k) && v && typeof v==="object" && v.enc){
    try{ return safeStorage.decryptString(Buffer.from(v.enc, "base64")) }catch(e){ return "" }
  }
  return v;
}
function storeGet(keys){
  const ks = keys==null ? Object.keys(data) : Array.isArray(keys) ? keys : typeof keys==="string" ? [keys] : Object.keys(keys);
  const out = {};
  for(const k of ks) if(k in data) out[k] = readVal(k);
  return out;
}
const changeListeners = [];
function storeSet(obj){
  const changes = {};
  for(const [k,v] of Object.entries(obj||{})){
    changes[k] = { oldValue: readVal(k), newValue: v };
    if(SECRET.has(k) && typeof v==="string" && v && safeStorage.isEncryptionAvailable())
      data[k] = { enc: safeStorage.encryptString(v).toString("base64") };
    else data[k] = v;
  }
  persist();
  if("clipScan" in (obj||{}) && tray && tray._rebuild) tray._rebuild();
  // never broadcast secrets back out
  const safe = {}; for(const [k,c] of Object.entries(changes)) if(!SECRET.has(k)) safe[k] = c;
  if(win && !win.isDestroyed() && Object.keys(safe).length) win.webContents.send("store-changed", safe);
  changeListeners.forEach(fn => { try{ fn(changes, "local") }catch(e){} });
}

// ---------- background alerts: runs the same worker code as the extension ----------
let bgMessageListener = null;
const notifClick = [];
function startBackground(){
  const alarmListeners = [];
  const chromeShim = {
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    alarms: {
      _timers: {},
      get: (name, cb) => cb(chromeShim.alarms._timers[name] ? {name} : null),
      create: (name, o) => {
        chromeShim.alarms._timers[name] = setInterval(() => alarmListeners.forEach(fn => fn({name})), (o.periodInMinutes||1)*60000);
        setTimeout(() => alarmListeners.forEach(fn => fn({name})), 15000);
      },
      onAlarm: { addListener: fn => alarmListeners.push(fn) }
    },
    runtime: { onInstalled:{addListener(){}}, onStartup:{addListener(){}}, onMessage:{ addListener: fn => { bgMessageListener = fn } } },
    notifications: {
      create: (id, o) => {
        if(!Notification.isSupported()) return;
        const n = new Notification({ title:o.title, body:o.message, icon:path.join(__dirname,"build","icon.png") });
        n.on("click", () => notifClick.forEach(fn => fn(id)));
        n.show();
      },
      onClicked: { addListener: fn => notifClick.push(fn) },
      clear: () => {}
    },
    tabs: { create: ({url}) => { if(httpsOnly(url)) shell.openExternal(url) } },
    storage: { local: { get: async k => storeGet(k), set: async o => storeSet(o) } }
  };
  const ctx = vm.createContext({ chrome:chromeShim, fetch, AbortSignal, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, console,
    Date, Math, JSON, Promise, encodeURIComponent, Number, String, Object, Array, Set, Map, isNaN, Error, importScripts:()=>{} });
  for(const f of ["shared.js","background.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname,"bg",f),"utf8"), ctx, {filename:f});
}

// ---------- window + tray ----------
let win = null, tray = null, quitting = false;
function createWindow(){
  const st = data.win || {};
  win = new BrowserWindow({
    width: st.w||440, height: st.h||900, x: st.x, y: st.y, minWidth:360, minHeight:500,
    title: "Trench Scout", backgroundColor: "#0d1117", alwaysOnTop: !!data.onTop,
    icon: path.join(__dirname,"build","icon.png"), autoHideMenuBar: true, show:false,
    webPreferences: { preload: path.join(__dirname,"preload.js"), contextIsolation:true, sandbox:true, nodeIntegration:false,
      webviewTag:false, spellcheck:false, devTools: !app.isPackaged }
  });
  win.loadURL("app://trench/panel.html");
  win.once("ready-to-show", () => win.show());
  // links open in the real browser; the app window itself can never navigate away
  win.webContents.setWindowOpenHandler(({url}) => { if(httpsOnly(url)) shell.openExternal(url); return {action:"deny"} });
  win.webContents.on("will-navigate", e => e.preventDefault());
  const saveBounds = () => { if(!win.isMinimized()){ const b = win.getBounds(); data.win = {x:b.x,y:b.y,w:b.width,h:b.height}; persist() } };
  win.on("resized", saveBounds); win.on("moved", saveBounds);
  win.on("close", e => {
    if(quitting) return;
    e.preventDefault(); win.hide();
    if(!data.trayHintShown && Notification.isSupported()){
      new Notification({title:"Trench Scout is still running", body:"Alerts keep working from the tray. Right-click the tray icon to quit."}).show();
      data.trayHintShown = true; persist();
    }
  });
}
function buildTray(){
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname,"build","icon.png")).resize({width:16,height:16}));
  tray.setToolTip("Trench Scout");
  const menu = () => Menu.buildFromTemplate([
    { label:"Show Trench Scout", click: () => { win.show(); win.focus() } },
    { label:"Keep on top", type:"checkbox", checked:!!data.onTop, click: i => setOnTop(i.checked) },
    { label:"Auto-scan copied addresses", type:"checkbox", checked:data.clipScan!==false, click: i => { data.clipScan = i.checked; persist() } },
    { type:"separator" },
    { label:"Quit", click: () => { quitting = true; app.quit() } }
  ]);
  tray.setContextMenu(menu());
  tray.on("click", () => { win.isVisible() ? win.focus() : win.show() });
  tray._rebuild = () => tray.setContextMenu(menu());
}
function setOnTop(on){
  data.onTop = !!on; persist();
  if(win) win.setAlwaysOnTop(!!on, "floating");
  if(tray) tray._rebuild();
  return !!on;
}

// ---------- clipboard watcher ----------
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TRADING_URL = /^https:\/\/([a-z0-9-]+\.)*(axiom\.trade|dexscreener\.com|pump\.fun|gmgn\.ai|bullx\.io|photon-sol\.tinyastro\.io)\//i;
let lastClip = "";
function watchClipboard(){
  let reading = false;
  setInterval(async () => {
    if(reading || data.clipScan===false || !win || win.isDestroyed()) return;
    reading = true;
    let t = ""; try{ t = String(await clipboard.readText() || "").trim() }catch(e){ reading = false; return }
    reading = false;
    if(!t || t===lastClip || t.length>300) return;
    lastClip = t;
    if(ADDR.test(t) || TRADING_URL.test(t)) win.webContents.send("clip-scan", t);
  }, 700);
}


// ---------- auto-update from GitHub releases ----------
let updateInfo = null;
function startUpdater(){
  if(!app.isPackaged) return;
  let autoUpdater;
  try{ ({ autoUpdater } = require("electron-updater")) }catch(e){ return }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const tell = () => { if(win && !win.isDestroyed() && updateInfo) win.webContents.send("update", updateInfo) };
  autoUpdater.on("update-available", i => { updateInfo = {version:i.version, ready:false}; tell() });
  autoUpdater.on("update-downloaded", i => {
    updateInfo = {version:i.version, ready:true}; tell();
    if(Notification.isSupported()) new Notification({title:"Trench Scout update ready", body:"Version "+i.version+" installs next time you restart the app."}).show();
  });
  autoUpdater.on("error", () => {});
  const check = () => autoUpdater.checkForUpdates().catch(()=>{});
  setTimeout(check, 10000);
  setInterval(check, 2*3600000);
  ipcMain.handle("install-update", () => { quitting = true; autoUpdater.quitAndInstall() });
  win.webContents.on("did-finish-load", tell);
}

// ---------- startup ----------
app.whenReady().then(() => {
  loadStore();
  Promise.resolve().then(() => clipboard.readText()).then(t => { lastClip = String(t||"").trim() }).catch(()=>{});

  // serve the panel from app://trench/ (only files inside renderer/)
  const root = path.join(__dirname, "renderer");
  protocol.handle("app", req => {
    const p = path.normalize(path.join(root, decodeURIComponent(new URL(req.url).pathname)));
    if(!p.startsWith(root)) return new Response("not found", {status:404});
    return net.fetch(pathToFileURL(p).toString());
  });

  // firewall: block every request that isn't the app itself, an allowlisted API, fonts, or an image
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.webRequest.onBeforeRequest((d, cb) => {
    let u; try{ u = new URL(d.url) }catch(e){ return cb({cancel:true}) }
    if(u.protocol==="app:" || u.protocol==="devtools:" || u.protocol==="data:" || u.protocol==="blob:") return cb({});
    if(u.protocol==="file:"){ let fp=""; try{ fp = path.normalize(require("url").fileURLToPath(u)) }catch(e){} return cb(fp.startsWith(root) ? {} : {cancel:true}) }
    if(u.protocol!=="https:") return cb({cancel:true});
    if(isApiHost(u.hostname) || ASSET_HOSTS.includes(u.hostname)) return cb({});
    if(UPDATE_HOSTS.includes(u.hostname) && d.webContentsId==null) return cb({});
    if(d.resourceType==="image" && d.method==="GET") return cb({});
    cb({cancel:true});
  });
  // the APIs are meant to be called from servers; let our own window read their answers
  ses.webRequest.onHeadersReceived((d, cb) => {
    let host = ""; try{ host = new URL(d.url).hostname }catch(e){}
    if(!isApiHost(host)) return cb({});
    const h = {};
    for(const [k,v] of Object.entries(d.responseHeaders||{})) if(!/^access-control-/i.test(k)) h[k] = v;
    h["Access-Control-Allow-Origin"] = ["app://trench"];
    h["Access-Control-Allow-Headers"] = ["*, authorization, x-api-key, content-type, anthropic-version, anthropic-dangerous-direct-browser-access"];
    h["Access-Control-Allow-Methods"] = ["GET, POST, OPTIONS"];
    if(d.method==="OPTIONS") return cb({responseHeaders:h, statusLine:"HTTP/1.1 204 No Content"});
    cb({responseHeaders:h});
  });

  ipcMain.handle("store-get", (_e, keys) => storeGet(keys));
  ipcMain.handle("store-set", (_e, obj) => { storeSet(obj); return true });
  ipcMain.handle("bg-message", (_e, msg) => new Promise(res => { if(!bgMessageListener) return res({ok:false}); const keep = bgMessageListener(msg, {}, res); if(keep!==true) res(undefined) }));
  ipcMain.handle("get-on-top", () => !!data.onTop);
  ipcMain.handle("toggle-on-top", () => setOnTop(!data.onTop));
  ipcMain.handle("app-version", () => app.getVersion());

  createWindow();
  buildTray();
  startBackground();
  watchClipboard();
  startUpdater();
});
app.on("second-instance", () => { if(win){ win.show(); win.focus() } });
app.on("before-quit", () => { quitting = true });
app.on("window-all-closed", e => e.preventDefault());
app.on("web-contents-created", (_e, wc) => {
  wc.on("will-attach-webview", e => e.preventDefault());
});
