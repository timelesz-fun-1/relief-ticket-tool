(() => {
  'use strict';
  const defaultsSync = {
    enabled: false,
    desiredCounts: [2],
    notifier: { type: "ntfy", ntfyTopic: "relief-ticket", discordWebhookUrl: "" },
    reload: { enabled: true, minSec: 3, maxSec: 7 },
    scroll: { enabled: true, minPx: 100, maxPx: 5000, smooth: true },
    cooldownSec: 25            // ★追加: クールダウン秒
  };
  function getSync(){ return new Promise(r=>chrome.storage.sync.get(defaultsSync, r)); }
  function getLocal(keys){ return new Promise(r=>chrome.storage.local.get(keys, r)); }
  function setLocal(p){ return new Promise(r=>chrome.storage.local.set(p, r)); }

  // ===== クールダウン: チケット番号(tno)で制御 =====
  async function getHoldback(){ const l = await getLocal(["holdback"]); return l.holdback || {}; }
  async function setHoldback(map){ return setLocal({ holdback: map }); }
  // 期限を「現在+sec」と既存値のmaxにする＝延長にも短縮にもならない安全動作
  async function touchHold(tno, sec){
    if (!tno) return;
    const m = await getHoldback();
    const target = Date.now() + Math.max(1, sec)*1000;
    m[tno] = Math.max(m[tno] || 0, target);
    await setHoldback(m);
  }
  async function isOnHold(tno){
    if (!tno) return false;
    const m = await getHoldback();
    const until = m[tno] || 0;
    if (until > Date.now()) return true;
    if (until) { delete m[tno]; await setHoldback(m); }
    return false;
  }

  let purchaseStarted = false;
  let reloadTimer = null;
  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
  function jitter(msMin, msMax){
    const min = Math.max(500, Math.floor(msMin));
    const max = Math.max(min, Math.floor(msMax));
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  function normalizeCooldown(v){
    const n = parseInt(v ?? 25, 10);
    return Number.isFinite(n) ? Math.max(5, Math.min(600, n)) : 25;
  }

  function randomScroll(settings){
    try{
      const sc = settings.scroll || {};
      if (!sc.enabled) return;
      const min = Math.max(0, parseInt(sc.minPx ?? 100, 10));
      const max = Math.max(min, parseInt(sc.maxPx ?? 5000, 10));
      const pixels = Math.floor(Math.random() * (max - min + 1)) + min;
      const behavior = (sc.smooth === false) ? 'auto' : 'smooth';
      const delay = Math.floor(Math.random() * 300) + 100;
      setTimeout(() => { try { window.scrollTo({ top: pixels, behavior }); } catch {} }, delay);
    } catch {}
  }

  // 公演行→キー（参考表示用）
  function createKey(el){
    const datetime = el.querySelector('.lead')?.innerText?.trim() || "(日時不明)";
    const venue = el.querySelector('p')?.innerText?.trim() || "(会場不明)";
    return { key: `${datetime}_${venue}`, datetime, venue };
  }

  // アーティスト名
  function getArtistName(){
    try {
      const section = [...document.querySelectorAll('.card .card-body')].find(el => /出演者/.test(el.textContent || ''));
      const strong = section?.querySelector('b');
      const fromCard = strong?.textContent?.trim();
      if (fromCard) return fromCard;
      const bc = document.querySelector('nav.breadcrumb a[href*="/events/artist/"] span')?.textContent || '';
      if (bc) return bc.replace(/リセール対象公演.*$/, '').trim();
      const h1 = document.querySelector('h1')?.textContent || '';
      const m = h1.match(/「(.+?)」公演一覧/);
      if (m) return m[1];
    } catch {}
    return '';
  }

  // デスクトップ通知
  function desktopNotify(info){
    try{
      const title = `RELIEF: ${info.artist ? info.artist + " - " : ""}${info.datetime}`;
      const body =
        `${info.venue}\n` +
        (info.desiredLabel ? `選択枚数: ${info.desiredLabel}\n` : '') +
        (info.url ? info.url : '');
      chrome.runtime?.sendMessage({
        type: "desktopNotify",
        payload: { title, message: body.trim(), url: info.url || location.href }
      });
    } catch(e) { console.warn("[desktopNotify error]", e); }
  }

  // 通知（ntfy / Discord + デスクトップ）
  async function notify(info, settings){
    const lines = [];
    if (info.artist) lines.push(`アーティスト: ${info.artist}`);
    lines.push(`日時: ${info.datetime}`);
    lines.push(`会場: ${info.venue}`);
    if (info.desiredLabel) lines.push(`選択枚数: ${info.desiredLabel}`);
    if (info.availableOptionsText) lines.push(`枚数候補: ${info.availableOptionsText}`);
    if (info.url) lines.push(`URL: ${info.url}`);
    if (Array.isArray(info.altUrls) && info.altUrls.length){
      const brief = info.altUrls.slice(0, 2).map(u => `${u.label}: ${u.url}`).join('\n');
      lines.push(`他の枚数URL:\n${brief}${info.altUrls.length>2?' …他':''}`);
    }
    const msg = lines.join('\n');

    try {
      if (settings.notifier?.type === "ntfy") {
        const topic = (settings.notifier.ntfyTopic || "relief-ticket").trim();
        await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method:"POST", body: msg });
      } else if (settings.notifier?.type === "discord" && settings.notifier.discordWebhookUrl) {
        await fetch(settings.notifier.discordWebhookUrl, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ content: "```" + msg + "```" })
        });
      }
    } catch (e) { console.warn("[通知失敗]", e); }
    desktopNotify(info);
  }

  // option -> /checkout/attention/{tno}?h=...&commit=commit
  function optionToCheckoutUrl(opt){
    const tno = opt?.getAttribute('data-ticket-no');
    const h   = opt?.value || "";
    if (!tno) return null;
    try {
      const u = new URL(`/checkout/attention/${tno}`, location.origin);
      if (h) { u.searchParams.set('h', h); u.searchParams.set('commit','commit'); }
      return u.href;
    } catch {
      return `${location.origin}/checkout/attention/${tno}${h ? `?h=${encodeURIComponent(h)}&commit=commit` : ""}`;
    }
  }

  // DOMヘルパー
  function findSelect(wrap){
    return wrap.querySelector('form.ticket-form select.ticket-select') ||
           wrap.querySelector('form.ticket-form select') ||
           wrap.querySelector('select');
  }
  function getDesiredOption(wrap, settings){
    const sel = findSelect(wrap);
    const opts = Array.from(sel?.querySelectorAll('option[data-ticket-no]:not([data-ticket-no=""])') || []);
    if (!opts.length) return null;
    return opts.find(o => (settings.desiredCounts||[1,2]).some(c => (o.innerText||'').includes(`${c}枚`))) || null;
  }
  function getTicketNoFromOption(opt){
    return opt?.getAttribute('data-ticket-no') || null;
  }

  // 1行購入処理
  async function autoBuyForWrap(wrap, settings, selectedShows, desiredOpt, cooldownSec){
    const select = findSelect(wrap);
    if (!wrap || !select || !desiredOpt) return;

    const opts = Array.from(select.querySelectorAll('option[data-ticket-no]:not([data-ticket-no=""])'));
    const { key, datetime, venue } = createKey(wrap);
    if (!selectedShows?.includes(key)) return;

    const tno = getTicketNoFromOption(desiredOpt);
    if (!tno) return;

    // クールダウン中はスキップ
    if (await isOnHold(tno)) return;

    // ここで購入開始扱い＆クールダウン（tno）＋直近TNO保存
    purchaseStarted = true;
    clearTimeout(reloadTimer); reloadTimer = null;
    await touchHold(tno, cooldownSec);
    await setLocal({ lastAttemptTno: tno, lastAttemptAt: Date.now() });

    const artist = getArtistName();
    const desiredUrl = optionToCheckoutUrl(desiredOpt);
    const altUrls = opts.filter(o => o!==desiredOpt)
                        .map(o => ({ label: (o.innerText||'').trim(), url: optionToCheckoutUrl(o) }))
                        .filter(x => x.url);

    await notify({
      artist, datetime, venue,
      desiredLabel: (desiredOpt.innerText||'').trim(),
      availableOptionsText: opts.map(o=>o.innerText.trim()).join(', '),
      url: desiredUrl || location.href,
      altUrls
    }, settings);

    // 新DOM: form submit / 旧DOM: ボタン or 直リンク
    select.value = desiredOpt.value;
    select.dispatchEvent(new Event('change', { bubbles:true }));
    await sleep(350);

    const form = wrap.querySelector('form.ticket-form');
    if (form){
      const btn = form.querySelector('button[type="submit"],input[type="submit"]');
      if (btn) btn.click(); else form.submit();
    } else {
      const btn = wrap.querySelector('.btn-buy-ticket');
      if (btn) btn.click();
      else if (desiredUrl) location.href = desiredUrl;
    }
  }

  function scheduleReloadIfNeeded(settings, selectedShows, foundEligible){
    if (purchaseStarted) return;
    if (!settings.reload?.enabled) return;

    const items = Array.from(document.querySelectorAll('.perform-list'));
    const hasSelected = items.some(el => selectedShows.includes(createKey(el).key));
    if (!hasSelected) return;

    if (foundEligible) return;

    let min = (settings.reload?.minSec ?? 3) * 1000;
    let max = (settings.reload?.maxSec ?? 7) * 1000;
    const body = document.body?.innerText || "";
    if (/502 Bad Gateway|504 Gateway|アクセスが集中しております/.test(body)) { min = 800; max = 1500; }

    randomScroll(settings);
    clearTimeout(reloadTimer);
    const wait = jitter(min, max);
    reloadTimer = setTimeout(() => { if (!purchaseStarted) location.reload(); }, wait);
    console.log(`[reload] scheduled in ${Math.round(wait/100)/10}s (min=${min/1000}, max=${max/1000})`);
  }

  // スキャン: desiredOpt を取得→ tno が hold 中なら飛ばす
  async function scan(settings, selectedShows, cooldownSec){
    for (const wrap of document.querySelectorAll('.perform-list')){
      const { key } = createKey(wrap);
      if (!selectedShows?.includes(key)) continue;

      const desiredOpt = getDesiredOption(wrap, settings);
      if (!desiredOpt) continue;

      const tno = getTicketNoFromOption(desiredOpt);
      if (!tno) continue;
      if (await isOnHold(tno)) continue;

      if (wrap.querySelector('form.ticket-form') || wrap.querySelector('.btn-buy-ticket')){
        await autoBuyForWrap(wrap, settings, selectedShows, desiredOpt, cooldownSec);
        scheduleReloadIfNeeded(settings, selectedShows, true);
        return true;
      }
    }
    scheduleReloadIfNeeded(settings, selectedShows, false);
    return false;
  }

  // “手続き中”フラッシュ検出で直前TNOのクールダウンを「同じ秒数」で延長
  async function extendHoldOnFlash(cooldownSec){
    try {
      const msg = document.querySelector('#flashAlert .message')?.textContent?.trim() || '';
      if (!/購入手続き中/.test(msg)) return;
      const l = await getLocal(["lastAttemptTno"]);
      const tno = l.lastAttemptTno;
      if (!tno) return;
      await touchHold(tno, cooldownSec); // 同じ値で再セット＝延長
      console.log("[holdback] extended for tno:", tno);
    } catch {}
  }

  (async () => {
    const sync = await getSync();
    if (!sync.enabled) return;

    const cooldownSec = normalizeCooldown(sync.cooldownSec);
    await extendHoldOnFlash(cooldownSec); // 先に延長判定

    const local = await getLocal(["selectedShows"]);
    const selectedShows = local.selectedShows || [];
    randomScroll(sync);

    if (!await scan(sync, selectedShows, cooldownSec)){
      const mo = new MutationObserver(async () => { await scan(sync, selectedShows, cooldownSec); });
      mo.observe(document.body, { childList:true, subtree:true });
      scheduleReloadIfNeeded(sync, selectedShows, false);
    }
  })();
})();
