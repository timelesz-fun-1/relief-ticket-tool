
(() => {
  const $ = (q) => document.querySelector(q);
  const defaultsSync = { enabled:false };
  function getSync(){ return new Promise(r=>chrome.storage.sync.get(defaultsSync, r)); }
  function setSync(patch){ return new Promise(r=>chrome.storage.sync.set(patch, r)); }

  async function load(){ const s = await getSync(); $("#enabled").checked = !!s.enabled; }
  async function autoSave(){ await setSync({ enabled: $("#enabled").checked }); $("#status").textContent="保存しました。"; setTimeout(()=>$("#status").textContent="",1000); }

  document.addEventListener("DOMContentLoaded", () => { load(); $("#enabled").addEventListener("change", autoSave); });
})();
