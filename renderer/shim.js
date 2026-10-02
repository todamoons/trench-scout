"use strict";
// Maps the chrome.* calls the panel uses onto the desktop app's bridge.
(function(){
  if(!window.trench) return;
  const t = window.trench;
  window.chrome = {
    storage: {
      local: { get: keys => t.get(keys), set: obj => t.set(obj) },
      onChanged: { addListener: cb => t.onChanged(ch => cb(ch, "local")) }
    },
    runtime: { sendMessage: msg => t.sendMessage(msg) }
  };
})();
