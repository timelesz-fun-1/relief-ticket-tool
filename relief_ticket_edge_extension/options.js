// options.js v1.4.6 — auto-save + reload settings + ntfy強化 + 親子チェック同期 + 安定バインド
(() => {
  const $ = (q) => document.querySelector(q);

  const defaultsSync = {
    enabled: false,
    desiredCounts: [2],
    notifier: { type: "ntfy", ntfyTopic: "relief-ticket", discordWebhookUrl: "" },
    reload: { enabled: true, minSec: 3, maxSec: 7 },
    scroll: { enabled: true, minPx: 100, maxPx: 5000, smooth: true },
    cooldownSec: 25
  };

  function getSync(){ return new Promise(r=>chrome.storage.sync.get(defaultsSync, r)); }
  function setSync(patch){ return new Promise(r=>chrome.storage.sync.set(patch, r)); }
  function getLocal(keys){ return new Promise(r=>chrome.storage.local.get(keys, r)); }
  function setLocal(patch){ return new Promise(r=>chrome.storage.local.set(patch, r)); }

  const showSaved = (() => {
    let t;
    return () => {
      const el = $("#saveIndicator"); if (!el) return;
      el.style.display = "inline"; clearTimeout(t);
      t = setTimeout(()=>{ el.style.display="none"; }, 1000);
    };
  })();

  function toggleNotifierConfigs(){
    const type = $("#notifyType").value;
    $("#ntfyConf").style.display = (type === "ntfy") ? "block" : "none";
    $("#discordConf").style.display = (type === "discord") ? "block" : "none";
  }
  function safeText(s){ return (s || "").replace(/\s+/g, " ").trim(); }

  // 子→親のチェック状態反映（checked / indeterminate）
  function updateParentStates(){
    // Event（公演）← Shows
    document.querySelectorAll('#catalogTree .event').forEach(evEl => {
      const eChk = evEl.querySelector('summary input[type=checkbox]');
      if (!eChk) return;
      const showChecks = evEl.querySelectorAll('.show input[type=checkbox]');
      if (showChecks.length === 0){ eChk.checked = false; eChk.indeterminate = false; return; }
      let total = 0, checked = 0;
      showChecks.forEach(ch => { total++; if (ch.checked) checked++; });
      eChk.checked = (checked === total);
      eChk.indeterminate = (checked > 0 && checked < total);
    });

    // Artist ← Events
    document.querySelectorAll('#catalogTree .artist').forEach(arEl => {
      const aChk = arEl.querySelector('summary input[type=checkbox]');
      if (!aChk) return;
      const eventChkNodes = arEl.querySelectorAll('.event > summary input[type=checkbox]');
      if (eventChkNodes.length === 0){ aChk.checked = false; aChk.indeterminate = false; return; }
      let totalE = 0, checkedE = 0, anyIndet = 0;
      eventChkNodes.forEach(ch => {
        totalE++;
        if (ch.checked) checkedE++;
        if (ch.indeterminate) anyIndet++;
      });
      aChk.checked = (checkedE === totalE);
      aChk.indeterminate = (!aChk.checked) && ((checkedE > 0) || (anyIndet > 0));
    });
  }
  // ==== 販売期間（JST）判定 ====
  // 公演日の yyyy/mm/dd(曜) HH:MM 形式から、開始/終了ウィンドウを UTC ms で返す
  function saleWindowUtc(datetimeStr){
    // 例: 2025/08/16(土) 17:00
    const m = (datetimeStr || "").match(/(\d{4})\/(\d{2})\/(\d{2}).*?(\d{2}):(\d{2})/);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    // JSTの 11:00 を UTC に直す（JST=UTC+9）
    const JST = 9 * 60; // min
    const msPerDay = 24 * 60 * 60 * 1000;

    // 開始＝公演日の5日前 11:00 JST
    const startUtc = Date.UTC(y, mo - 1, d, 11 - 9, 0, 0, 0) - 5 * msPerDay;
    // 終了＝公演日の2日前 11:59:59.999 JST
    const endUtc   = Date.UTC(y, mo - 1, d, 11 - 9, 59, 59, 999) - 2 * msPerDay;

    return [startUtc, endUtc];
  }

  function isOnSaleNow(datetimeStr, nowMs = Date.now()){
    const w = saleWindowUtc(datetimeStr);
    if (!w) return false;
    return nowMs >= w[0] && nowMs <= w[1];
  }

  function makeSaleBadge(){
    const b = document.createElement("span");
    b.className = "badge-sale";
    b.textContent = "販売期間中";
    return b;
  }
  // ツリー描画
  function renderTree(catalog, selectedShows){
    const cont = $("#catalogTree");
    cont.innerHTML = "";
    const artists = Array.isArray(catalog?.artists) ? catalog.artists : [];
    if (!artists.length){
      cont.innerHTML = '<div class="hint">まだデータがありません。「情報を最新化」を押してください。</div>';
      return;
    }

    artists.forEach((artist, ai) => {
      const events = Array.isArray(artist.events) ? artist.events : [];
      const dArtist = document.createElement("details"); dArtist.open = true; dArtist.className = "artist";
      const sumA = document.createElement("summary"); sumA.className = "row-flex";
      const caretA = document.createElement("span"); caretA.className = "caret";
      const aChk = document.createElement("input"); aChk.type = "checkbox"; aChk.id = `a_${ai}`;
      const aLbl = document.createElement("label"); aLbl.className = "label"; aLbl.htmlFor = aChk.id;
      aLbl.textContent = `${safeText(artist.name || artist.url)} (${events.length}公演)`;
      sumA.appendChild(caretA); sumA.appendChild(aChk); sumA.appendChild(aLbl);
      dArtist.appendChild(sumA);
      cont.appendChild(dArtist);

      let artistHasSale = false; // ← 追加

      aChk.addEventListener("change", () => {
        dArtist.querySelectorAll('.event input[type=checkbox], .show input[type=checkbox]').forEach(ch => ch.checked = aChk.checked);
        saveSelectedShows(); updateParentStates();
      });

      if (!events.length){
        const none = document.createElement("div"); none.className = "event"; none.innerHTML = '<span class="hint">イベント未検出</span>';
        dArtist.appendChild(none);
      }

      events.forEach((ev, ei) => {
        const dEvent = document.createElement("details"); dEvent.open = false; dEvent.className = "event";
        const sumE = document.createElement("summary"); sumE.className = "row-flex";
        const caretE = document.createElement("span"); caretE.className = "caret";
        const eChk = document.createElement("input"); eChk.type = "checkbox"; eChk.id = `e_${ai}_${ei}`;
        const eLbl = document.createElement("label"); eLbl.className = "label"; eLbl.htmlFor = eChk.id;
        const shows = Array.isArray(ev.shows) ? ev.shows : [];
        eLbl.textContent = `${safeText(ev.name || ev.url)} (${shows.length}件)`;
        sumE.appendChild(caretE); sumE.appendChild(eChk); sumE.appendChild(eLbl);
        dEvent.appendChild(sumE);
        dArtist.appendChild(dEvent);

        eChk.addEventListener("change", () => {
          dEvent.querySelectorAll('.show input[type=checkbox]').forEach(ch => ch.checked = eChk.checked);
          saveSelectedShows(); updateParentStates();
        });

        if (!shows.length){
          const noneS = document.createElement("div"); noneS.className = "show";
          noneS.innerHTML = '<span class="hint">日付・会場なし</span>';
          dEvent.appendChild(noneS);
        }

        let eventHasSale = false; // ← 追加

        shows.forEach((sh, si) => {
          const sRow = document.createElement("div"); sRow.className = "show row-flex";
          const sChk = document.createElement("input"); sChk.type = "checkbox"; sChk.id = `s_${ai}_${ei}_${si}`; sChk.value = sh.key;
          sChk.checked = (selectedShows || []).includes(sh.key);
          const sLbl = document.createElement("label"); sLbl.className = "label"; sLbl.htmlFor = sChk.id;
          sLbl.textContent = `${safeText(sh.datetime)} — ${safeText(sh.venue)}`;

          // ★ここで販売期間判定（JST基準）
          if (isOnSaleNow(sh.datetime)) {
            sLbl.appendChild(makeSaleBadge());
            eventHasSale = true;
            artistHasSale = true;
          }

          sRow.appendChild(sChk); sRow.appendChild(sLbl);
          dEvent.appendChild(sRow);
        });

        // 公演にバッジを付与（配下に一つでも販売期間中があれば）
        if (eventHasSale) eLbl.appendChild(makeSaleBadge());
      });

      // アーティストにバッジを付与（配下のどこかに販売期間中があれば）
      if (artistHasSale) aLbl.appendChild(makeSaleBadge());
    });

    updateParentStates();

    // delegate: showの変更で保存＋親再計算
    cont.addEventListener("change", (e) => {
      if (e.target && e.target.matches('.show input[type=checkbox]')){
        saveSelectedShows(); updateParentStates();
      }
    });
  }
  // ==== カレンダー用ヘルパー（JST基準） ====
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // JST日付キー（YYYY-MM-DD）へ
  function jstKeyFromUtcMs(utcMs){
    const d = new Date(utcMs + JST_OFFSET_MS);
    const y = d.getUTCFullYear(), m = d.getUTCMonth()+1, dd = d.getUTCDate();
    return `${y}-${String(m).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
  }

  // 月のカレンダーHTMLをつくる（year, month0: 0-11）
  function buildMonthCalendar(year, month0, windows){
    // windows: [{start,end, label, tip}]
    // 当月1日JSTの曜日
    const firstJstUtc = Date.UTC(year, month0, 1, 0-9, 0, 0, 0);
    const firstDow = new Date(firstJstUtc + JST_OFFSET_MS).getUTCDay(); // 0:日
    const daysInMonth = new Date(Date.UTC(year, month0+1, 0)).getUTCDate();

    // 6週=42マス分を出す（前月末～翌月頭の灰色含む）
    const startGridUtc = firstJstUtc - firstDow * DAY_MS; // JSTで前の日曜に合わせる
    const cells = [];
    for (let i=0;i<42;i++){
      const dayStartUtc = startGridUtc + i*DAY_MS;
      const dayEndUtc   = dayStartUtc + DAY_MS - 1;
      const inThisMonth = (new Date(dayStartUtc + JST_OFFSET_MS).getUTCMonth() === month0);
      // その日にかかっている販売ウィンドウを抽出
      const matched = windows.filter(w => !(w.end < dayStartUtc || w.start > dayEndUtc));
      const count = matched.length;
      const tip = matched.map(w => `・${w.tip}`).join('\n');

      cells.push({
        utc: dayStartUtc,
        inThisMonth,
        count,
        tip
      });
    }

    // HTML
    const title = `${year}/${String(month0+1).padStart(2,'0')}`;
    const wrap = document.createElement('div'); wrap.className = 'cal';
    wrap.innerHTML = `
      <div class="cal-head"><span class="cal-title">${title}</span></div>
      <div class="cal-grid">
        ${['日','月','火','水','木','金','土'].map(d=>`<div class="cal-dow">${d}</div>`).join('')}
      ${cells.map(cell=>{
        const dNum = new Date(cell.utc + JST_OFFSET_MS).getUTCDate();
        const classes = ['cal-day'];
        if (!cell.inThisMonth) classes.push('muted');
        if (cell.count>0) classes.push('sale');

        const tipAttr = cell.count>0 ? ` title="${String(cell.tip).replace(/"/g,'&quot;')}"` : '';
        const countHtml = cell.count>0 ? `<span class="cal-count">${cell.count}</span>` : '';

        return `
          <div class="${classes.join(' ')}"${tipAttr}>
            <span class="cal-num">${dNum}</span>
            ${countHtml}
          </div>
        `;
      }).join('')}
      </div>
    `;
    return wrap;
  }

  // カタログ→販売ウィンドウ配列に展開
  function collectSaleWindows(catalog){
    const out = [];
    (catalog.artists||[]).forEach(a => (a.events||[]).forEach(e => (e.shows||[]).forEach(s => {
      const w = saleWindowUtc(s.datetime);
      if (!w) return;
      // tip用ラベル
      const tip = `${s.datetime} ${s.venue}（${(a.name||'')}${e.name? ' / '+e.name:''}）`;
      out.push({ start: w[0], end: w[1], tip });
    })));
    return out;
  }

  // カレンダー描画本体（今月＋来月）
  function renderSaleCalendar(catalog){
    const cont = document.getElementById('saleCalendar');
    if (!cont) return;
    cont.innerHTML = '';

    const wins = collectSaleWindows(catalog);
    if (wins.length === 0){
      cont.innerHTML = '<div class="hint">販売期間に該当する公演がありません。</div>';
      return;
    }

    const now = new Date(Date.now() + JST_OFFSET_MS);
    const y = now.getUTCFullYear(), m0 = now.getUTCMonth();

    cont.appendChild(buildMonthCalendar(y, m0, wins));          // 今月
    const y2 = (m0===11)? y+1 : y, m02 = (m0+1) % 12;
    cont.appendChild(buildMonthCalendar(y2, m02, wins));        // 来月
  }
  async function saveSelectedShows(){
    const selected = [...document.querySelectorAll(".show input[type=checkbox]:checked")].map(ch => ch.value);
    await setLocal({ selectedShows: selected });
    showSaved();
  }

  // ====== 裏タブでの収集 ======
  async function waitComplete(tabId, timeoutMs=20000){
    const start = Date.now();
    while (Date.now() - start < timeoutMs){
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete") return true;
      await new Promise(r=>setTimeout(r,150));
    }
    return false;
  }
  async function scrape(tabId, func){
    const [{ result }] = await chrome.scripting.executeScript({ target:{ tabId }, func });
    return result;
  }

  // トップのアーティスト抽出
  function fnExtractArtists(){
    const anchors = [...document.querySelectorAll('a[href^="/events/artist/"], a[href*="://relief-ticket.jp/events/artist/"]')];
    const seen = new Set(); const out = [];
    anchors.forEach(a => {
      const href = new URL(a.getAttribute('href'), location.origin).href;
      if (!/^https:\/\/relief-ticket\.jp\/events\/artist\/\d+/.test(href)) return;
      if (seen.has(href)) return; seen.add(href);
      const name = (a.textContent || "").trim() || href;
      out.push({ name, url: href });
    });
    return out;
  }

  // アーティストページ → イベント一覧
  function fnExtractEventsOnArtist(){
    const anchors = [
      ...document.querySelectorAll('.card-top-ticketlist a[href*="/events/artist/"]'),
      ...document.querySelectorAll('a[href*="/events/artist/"]')
    ];
    const seen = new Set(); const out = [];
    anchors.forEach(a => {
      const href = new URL(a.getAttribute('href'), location.origin).href;
      if (!/^https:\/\/relief-ticket\.jp\/events\/artist\/\d+\/\d+/.test(href)) return;
      if (seen.has(href)) return; seen.add(href);
      const name = (a.textContent || "").trim() || href;
      out.push({ name, url: href });
    });
    return out;
  }

  // イベントページ → 日付・会場
  function fnExtractShowsOnEvent(){
    const items = [...document.querySelectorAll('.perform-list')];
    const shows = items.map(el => {
      const datetime = el.querySelector('.lead')?.textContent?.trim() || "";
      const venue = el.querySelector('p')?.textContent?.trim() || "";
      return { datetime, venue, key: `${datetime}_${venue}` };
    }).filter(s => s.datetime && s.venue);
    return shows;
  }

  async function refreshCatalog(){
    $("#refreshStatus").textContent = "収集中...";
    try {
      const home = await chrome.tabs.create({ url: "https://relief-ticket.jp/", active: false });
      await waitComplete(home.id);
      const artists = await scrape(home.id, fnExtractArtists);
      try { await chrome.tabs.remove(home.id); } catch {}
      const catalog = { artists: [] };

      for (const ar of artists){
        const tArtist = await chrome.tabs.create({ url: ar.url, active: false });
        await waitComplete(tArtist.id);
        const events = await scrape(tArtist.id, fnExtractEventsOnArtist);
        try { await chrome.tabs.remove(tArtist.id); } catch {}

        const eventsOut = [];
        for (const ev of events){
          const tEvent = await chrome.tabs.create({ url: ev.url, active: false });
          await waitComplete(tEvent.id);
          const shows = await scrape(tEvent.id, fnExtractShowsOnEvent);
          try { await chrome.tabs.remove(tEvent.id); } catch {}
          eventsOut.push({ name: ev.name, url: ev.url, shows });
        }
        catalog.artists.push({ name: ar.name, url: ar.url, events: eventsOut });
      }

      await chrome.storage.local.set({ catalog });

      // 既存選択のサニタイズ（消えた公演は落とす）
      const allKeys = new Set();
      catalog.artists.forEach(a => (a.events||[]).forEach(e => (e.shows||[]).forEach(s => allKeys.add(s.key))));
      const local = await getLocal(["selectedShows"]);
      const currentSel = Array.isArray(local.selectedShows) ? local.selectedShows : [];
      const pruned = currentSel.filter(k => allKeys.has(k));
      await chrome.storage.local.set({ selectedShows: pruned });

      $("#debugJson").textContent = JSON.stringify(catalog, null, 2);
      renderTree(catalog, pruned);
      renderSaleCalendar(catalog);
      $("#refreshStatus").textContent = `更新完了: アーティスト ${catalog.artists.length}件`;
    } catch (e) {
      $("#refreshStatus").textContent = `エラー: ${e.message}`;
    }
  }

  // ====== 選択タブを開く / 削除 ======
  async function openSelectedTabs(){
    const local = await getLocal(["catalog","selectedShows"]);
    const catalog = local.catalog || { artists: [] };
    const selected = new Set(local.selectedShows || []);
    const urls = [];
    const seen = new Set();
    (catalog.artists || []).forEach(a => (a.events || []).forEach(e => {
      const has = (e.shows || []).some(s => selected.has(s.key));
      if (has && e.url && !seen.has(e.url)) { seen.add(e.url); urls.push(e.url); }
    }));
    if (!urls.length){ $("#openStatus").textContent = "選択された公演がありません。"; return; }

    const newWindow = !!$("#openInNewWindow")?.checked;
    const pinned = !!$("#openPinned")?.checked;
    const maxTabs = Math.max(1, Math.min(40, parseInt($("#maxTabs")?.value || "15", 10)));
    const limited = urls.slice(0, maxTabs);
    $("#openStatus").textContent = `タブを開いています… (${limited.length} / ${urls.length})`;

    try {
      if (newWindow){
        const first = limited[0];
        const win = await chrome.windows.create({ url: first, focused: false });
        for (const url of limited.slice(1)){
          await chrome.tabs.create({ windowId: win.id, url, active: false, pinned });
          await new Promise(r=>setTimeout(r, 120));
        }
      } else {
        for (const url of limited){
          await chrome.tabs.create({ url, active: false, pinned });
          await new Promise(r=>setTimeout(r, 120));
        }
      }
      $("#openStatus").textContent = `完了：${limited.length}件のタブを開きました。`;
    } catch (e){
      $("#openStatus").textContent = `エラー：${e.message}`;
    }
  }

  async function purgeData(){
    try {
      await chrome.storage.local.remove(["catalog","selectedShows"]);
      $("#purgeStatus").textContent = "削除しました。";
      $("#debugJson").textContent = "{}";
      const cont = $("#catalogTree");
      if (cont) cont.innerHTML = '<div class="hint">データを削除しました。「情報を最新化」を押して再取得してください。</div>';
    } catch (e){
      $("#purgeStatus").textContent = `エラー：${e.message}`;
    }
  }

  // ====== 初期ロード & バインド ======
  async function load(){
    const sync = await getSync();
    const local = await getLocal(["catalog","selectedShows"]);
    $("#enabled").checked = !!sync.enabled;
    $("#desiredCounts").value =
      (sync.desiredCounts||[]).join(",")==="1" ? "1" :
      (sync.desiredCounts||[]).join(",")==="2" ? "2" : "1,2";
    $("#notifyType").value = sync.notifier?.type || "ntfy";
    $("#ntfyTopic").value = sync.notifier?.ntfyTopic || "relief-ticket";
    $("#discordWebhookUrl").value = sync.notifier?.discordWebhookUrl || "";
    $("#reloadEnabled").checked = !!sync.reload?.enabled;
    $("#reloadMin").value = sync.reload?.minSec ?? 3;
    $("#reloadMax").value = sync.reload?.maxSec ?? 7;
    $("#scrollEnabled").checked = !!sync.scroll?.enabled;
    $("#scrollMin").value = sync.scroll?.minPx ?? 100;
    $("#scrollMax").value = sync.scroll?.maxPx ?? 5000;
    $("#scrollSmooth").checked = (sync.scroll?.smooth !== false);
    $("#cooldownSec").value = sync.cooldownSec ?? 25; // ★追加
    toggleNotifierConfigs();
    $("#debugJson").textContent = JSON.stringify(local.catalog || {}, null, 2);
    renderTree(local.catalog || {artists:[]}, local.selectedShows || []);
    renderSaleCalendar(local.catalog || {artists:[]});
    updateParentStates();
  }

  // Auto-save
  const debounce = (fn, ms=300) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
  const savePrefs = async () => {
    const desired = $("#desiredCounts").value.split(",").map(n=>parseInt(n,10)).filter(n=>!isNaN(n));
    const type = $("#notifyType").value;
    const ntfyTopic = $("#ntfyTopic").value.trim();
    const discordWebhookUrl = $("#discordWebhookUrl").value.trim();
    const enabled = $("#enabled").checked;
    const reload = { enabled: $("#reloadEnabled").checked, minSec: Math.max(1, parseInt($("#reloadMin").value||"3",10)), maxSec: Math.max(1, parseInt($("#reloadMax").value||"7",10)) };
    const scroll = { enabled: $("#scrollEnabled").checked, minPx: Math.max(0, parseInt($("#scrollMin").value||"100",10)), maxPx: Math.max(0, parseInt($("#scrollMax").value||"5000",10)), smooth: $("#scrollSmooth").checked };
    const cooldownSec = Math.max(5, Math.min(600, parseInt($("#cooldownSec").value||"25",10)));
    //await setSync({ enabled, desiredCounts: desired, notifier: {type, ntfyTopic, discordWebhookUrl}, reload, scroll });
    await setSync({ enabled, desiredCounts: desired, notifier: {type, ntfyTopic, discordWebhookUrl}, reload, scroll, cooldownSec });
    showSaved();
  };

  // ---- ntfy: グローバル公開版（委譲呼び出しでも確実に届く）----
  window.testNtfy = async function testNtfy(){
    const topicEl = document.getElementById("ntfyTopic");
    const statusEl = document.getElementById("testNtfyStatus");
    const logEl = document.getElementById("testNtfyLog");
    if (!topicEl || !statusEl) return;
    const log = (m)=>{ if (logEl){ logEl.textContent += m + "\n"; } console.log("[ntfy-test]", m); };

    const topic = (topicEl.value || "").trim();
    if (!topic){ statusEl.textContent = "トピック名を入力してください"; return; }
    const url = "https://ntfy.sh/" + encodeURIComponent(topic);

    try {
      if (chrome.permissions && chrome.permissions.request){
        const granted = await chrome.permissions.request({ origins: ["https://ntfy.sh/*"] });
        log("permissions.request => " + granted);
      }
    } catch (e){ log("permissions.request error: " + e.message); }

    statusEl.textContent = "送信中...";
    const body = "RELIEF Ticket: テスト通知 " + new Date().toLocaleString();

    try {
      log("fetch POST " + url);
      const res = await fetch(url, { method: "POST", body });
      log("fetch status: " + res.status + " type=" + res.type);
      if (res.ok){ statusEl.textContent = "送信しました（アプリの購読を確認してください）"; return; }
      log("non-OK => try no-cors");
    } catch (e) {
      log("fetch error: " + e.message);
    }

    try {
      await fetch(url, { method:"POST", mode:"no-cors", body: body + " (no-cors)" });
      statusEl.textContent = "送信しました（no-cors）／アプリの購読を確認してください";
      return;
    } catch (e) {
      log("no-cors error: " + e.message);
    }

    try {
      const ok = navigator.sendBeacon(url, body + " (beacon)");
      log("sendBeacon => " + ok);
      statusEl.textContent = ok ? "送信しました（beacon）" : "送信に失敗しました";
    } catch (e) {
      statusEl.textContent = "エラー: " + e.message;
      log("beacon error: " + e.message);
    }
  };

  // DOMContentLoaded 後の通常バインド
  document.addEventListener("DOMContentLoaded", async () => {
    await load();

    $("#refresh").addEventListener("click", refreshCatalog);
    $("#reloadTree").addEventListener("click", load);
    $("#toggleDebug").addEventListener("click", () => {
      const box = document.getElementById("debugBox");
      box.style.display = (box.style.display === "none" || !box.style.display) ? "block" : "none";
    });
    $("#openSelectedTabs").addEventListener("click", openSelectedTabs);
    $("#purgeData").addEventListener("click", purgeData);

    // auto-save bindings
    $("#enabled").addEventListener("change", savePrefs);
    $("#desiredCounts").addEventListener("change", savePrefs);
    $("#notifyType").addEventListener("change", () => { toggleNotifierConfigs(); savePrefs(); });
    $("#ntfyTopic").addEventListener("input", debounce(savePrefs, 400));
    $("#discordWebhookUrl").addEventListener("input", debounce(savePrefs, 400));
    $("#reloadEnabled").addEventListener("change", savePrefs);
    $("#reloadMin").addEventListener("input", debounce(savePrefs, 300));
    $("#reloadMax").addEventListener("input", debounce(savePrefs, 300));
    $("#scrollEnabled").addEventListener("change", savePrefs);
    $("#scrollMin").addEventListener("input", debounce(savePrefs, 300));
    $("#scrollMax").addEventListener("input", debounce(savePrefs, 300));
    $("#scrollSmooth").addEventListener("change", savePrefs);
    $("#cooldownSec").addEventListener("input", debounce(savePrefs, 300)); // ★追加

    const tbtn = document.getElementById("testNtfy");
    if (tbtn && !tbtn.dataset.bound){
      tbtn.addEventListener("click", () => { window.testNtfy && window.testNtfy(); });
      tbtn.dataset.bound = "1";
    }
  });

})(); // ← IIFE ここまで

// ---- boot shim: DOM読み込み前後どちらでも確実にバインド（＆ログ）----
(() => {
  const boot = () => {
    const logEl = document.getElementById("testNtfyLog");
    const log = (m)=>{ if (logEl){ logEl.textContent += m + "\n"; } console.log("[ntfy-test]", m); };

    if (logEl && !logEl.dataset.readyLogged){
      logEl.textContent += "[ready] options.js loaded\n";
      logEl.dataset.readyLogged = "1";
    }

    const btn = document.getElementById("testNtfy");
    const callTest = () => {
      const fn = (window.testNtfy && typeof window.testNtfy === "function") ? window.testNtfy : null;
      if (!fn){ log("missing testNtfy"); return; }
      try { fn(); } catch (err) { log("handler error: " + err.message); }
    };

    if (btn && !btn.dataset.bound2){
      btn.addEventListener("click", () => { log("click (direct)"); callTest(); });
      btn.dataset.bound2 = "1";
      log("bound=direct");
    }

    if (!document.body.dataset.delegatedNtfy){
      document.addEventListener("click", (e) => {
        const t = e.target && (e.target.id === "testNtfy" ? e.target : (e.target.closest && e.target.closest("#testNtfy")));
        if (t){ log("click (delegated)"); e.preventDefault(); callTest(); }
      }, true);
      document.body.dataset.delegatedNtfy = "1";
      log("bound=delegated");
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
