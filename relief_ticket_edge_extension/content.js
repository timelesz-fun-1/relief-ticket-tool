(() => {
  'use strict';
  const defaultsSync = {
    enabled: false,
    desiredCounts: [2],
    notifier: { type: "ntfy", ntfyTopic: "relief-ticket", discordWebhookUrl: "" },
    reload: { enabled: true, minSec: 3, maxSec: 7 },
    scroll: { enabled: true, minPx: 100, maxPx: 5000, smooth: true }
  };
  function getSync(){ return new Promise(r=>chrome.storage.sync.get(defaultsSync, r)); }
  function getLocal(keys){ return new Promise(r=>chrome.storage.local.get(keys, r)); }

  let purchaseStarted = false;
  let reloadTimer = null;
  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
  function jitter(msMin, msMax){
    const min = Math.max(500, Math.floor(msMin));
    const max = Math.max(min, Math.floor(msMax));
    return Math.floor(Math.random() * (max - min + 1)) + min;
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
      setTimeout(() => {
        try { window.scrollTo({ top: pixels, behavior }); } catch {}
      }, delay);
    } catch {}
  }
  // 希望枚数 option が存在するかの事前判定
  function hasDesiredOption(wrap, settings){
    const select = wrap?.querySelector('select');
    const opts = Array.from(select?.querySelectorAll('option[data-ticket-no]:not([data-ticket-no=""])') || []);
    if (!opts.length) return false;
    const desired = opts.find(o => (settings.desiredCounts||[1,2]).some(c => (o.innerText||'').includes(`${c}枚`)));
    return !!desired;
  }
  // 公演行からキー生成
  function createKey(el){
    const datetime = el.querySelector('.lead')?.innerText?.trim() || "(日時不明)";
    const venue = el.querySelector('p')?.innerText?.trim() || "(会場不明)";
    return { key: `${datetime}_${venue}`, datetime, venue };
  }

  // アーティスト名をページから抽出（出演者カード優先 → パンくずの一個前の項目 → 最後のフォールバック）
  function getArtistName(){
    try {
      // 「出演者: <b>名前</b>」のカードがあるページ
      const section = [...document.querySelectorAll('.card .card-body')]
        .find(el => /出演者/.test(el.textContent || ''));
      const strong = section?.querySelector('b');
      const fromCard = strong?.textContent?.trim();
      if (fromCard) return fromCard;
      // パンくずのアーティスト項目から
      const bc = document.querySelector('nav.breadcrumb a[href*="/events/artist/"] span')?.textContent || '';
      if (bc) return bc.replace(/リセール対象公演.*$/, '').trim();
      // 予備
      const h1 = document.querySelector('h1')?.textContent || '';
      const m = h1.match(/「(.+?)」公演一覧/);
      if (m) return m[1]; // 作品名が入るが無いよりマシ
    } catch {}
    return '';
  }

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

  // 通知
  async function notify(info, settings){
    const lines = [];
    if (info.artist) lines.push(`アーティスト: ${info.artist}`);
    lines.push(`日時: ${info.datetime}`);
    lines.push(`会場: ${info.venue}`);
    if (info.desiredLabel) lines.push(`選択枚数: ${info.desiredLabel}`);
    if (info.availableOptionsText) lines.push(`枚数候補: ${info.availableOptionsText}`);
    if (info.url) lines.push(`URL: ${info.url}`);
    // 可能なら他枚数のURLもダイジェスト（長すぎないように2件まで）
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
          method:"POST",
          headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ content: "```" + msg + "```" })
        });
      }
    } catch (e) { console.warn("[通知失敗]", e); }
    desktopNotify(info); // ★常にデスクトップ通知も実行
  }

  // オプション → チケットURLに変換
  function optionToCheckoutUrl(opt){
    const tno = opt?.getAttribute('data-ticket-no');
    if (!tno) return null;
    try { return new URL(`/checkout/attention/${tno}`, location.origin).href; }
    catch { return `${location.origin}/checkout/attention/${tno}`; }
  }

  // async function autoBuy(btn, settings, selectedShows){
  //   purchaseStarted = true;
  //   clearTimeout(reloadTimer);
  //   reloadTimer = null;
  async function autoBuy(btn, settings, selectedShows){
    const wrap = btn.closest('.perform-list');
    const select = wrap?.querySelector('select');
    const opts = Array.from(select?.querySelectorAll('option[data-ticket-no]:not([data-ticket-no=""])') || []);
    //if (!wrap || !select || !opts.length) { purchaseStarted = false; return; }
    if (!wrap || !select || !opts.length) { return; }

    const desired = opts.find(o => (settings.desiredCounts||[1,2]).some(c => (o.innerText||'').includes(`${c}枚`)));
    //if (!desired) { purchaseStarted = false; return; }
    if (!desired) { return; }

    const { key, datetime, venue } = createKey(wrap);
    //if (!selectedShows?.includes(key)) { purchaseStarted = false; return; }
    if (!selectedShows?.includes(key)) { return; }
    // ←ここで初めて「購入開始」扱いにする
    purchaseStarted = true;
    clearTimeout(reloadTimer);
    reloadTimer = null;

    // アーティスト名
    const artist = getArtistName();

    // 「選択枚数」のURL（checkout直リンク）
    const desiredUrl = optionToCheckoutUrl(desired);

    // 参考：他枚数のURL（あれば）
    const altUrls = opts
      .filter(o => o !== desired)
      .map(o => ({ label: (o.innerText||'').trim(), url: optionToCheckoutUrl(o) }))
      .filter(x => x.url);

    await notify({
      artist,
      datetime,
      venue,
      desiredLabel: (desired.innerText||'').trim(),
      availableOptionsText: opts.map(o=>o.innerText.trim()).join(', '),
      url: desiredUrl || btn.getAttribute('href') || location.href,
      altUrls
    }, settings);

    // 選択→変更イベント→クリック
    select.value = desired.value;
    select.dispatchEvent(new Event('change', { bubbles:true }));
    await sleep(400);
    btn.click();
  }

  function scheduleReloadIfNeeded(settings, selectedShows, foundEligible){
    if (purchaseStarted) return;
    if (!settings.reload?.enabled) return;

    // Only reload on event pages where at least one selected show exists
    const items = Array.from(document.querySelectorAll('.perform-list'));
    const hasSelected = items.some(el => selectedShows.includes(createKey(el).key));
    if (!hasSelected) return;
    if (foundEligible) return; // autoBuy will take over

    let min = (settings.reload?.minSec ?? 3) * 1000;
    let max = (settings.reload?.maxSec ?? 7) * 1000;
    // Fast lane for server error pages
    const body = document.body?.innerText || "";
    if (/502 Bad Gateway|504 Gateway|アクセスが集中しております/.test(body)) {
      min = 800; max = 1500;
    }

    randomScroll(settings);
    clearTimeout(reloadTimer);
    const wait = jitter(min, max);
    reloadTimer = setTimeout(() => {
      if (!purchaseStarted) location.reload();
    }, wait);
    console.log(`[reload] scheduled in ${Math.round(wait/100)/10}s (min=${min/1000}, max=${max/1000})`);
  }

  function scan(settings, selectedShows){
    let willBuy = false;
    for (const btn of document.querySelectorAll('.btn-buy-ticket')){
      const wrap = btn.closest('.perform-list'); if (!wrap) continue;
      const { key } = createKey(wrap);
      // 選択済みの公演 かつ 希望枚数 option がある時だけ購入処理へ
      if (selectedShows?.includes(key) && hasDesiredOption(wrap, settings)) {
        willBuy = true;
        autoBuy(btn, settings, selectedShows);
        break;
      }
    }
    // willBuy=false のときだけリロードをスケジュール（希望外在庫でもリロード継続）
    scheduleReloadIfNeeded(settings, selectedShows, willBuy);
    return willBuy;
  }


  (async () => {
    const sync = await getSync();
    if (!sync.enabled) return;
    const local = await getLocal(["selectedShows"]);
    const selectedShows = local.selectedShows || [];
    randomScroll(sync);
    if (!scan(sync, selectedShows)){
      const mo = new MutationObserver(() => scan(sync, selectedShows));
      mo.observe(document.body, { childList:true, subtree:true });
      // Also schedule reload even if DOM never changes
      scheduleReloadIfNeeded(sync, selectedShows, false);
    }
  })();
})();
