    // bg.js — desktop notification bridge

    async function setKV(id, url){
    const api = chrome.storage.session ?? chrome.storage.local;
    await api.set({ ['notif_' + id]: url });
    }
    async function getKV(id){
    const api = chrome.storage.session ?? chrome.storage.local;
    const o = await new Promise(res => api.get('notif_' + id, res));
    return o['notif_' + id];
    }
    async function delKV(id){
    const api = chrome.storage.session ?? chrome.storage.local;
    await api.remove('notif_' + id);
    }

    // content.js から {type:"desktopNotify", payload:{title, message, url}} を受けて通知を出す
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'desktopNotify') return;

    const payload = msg.payload || {};
    const id = 'rt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: payload.title || 'RELIEF Ticket',
        message: payload.message || '',
        priority: 2,
        requireInteraction: true // ユーザーが操作するまで残す
    }, async () => {
        if (payload.url) await setKV(id, payload.url);
        sendResponse(true);
    });

    // 非同期応答する
    return true;
    });

    // 通知クリックでURLを開く
    chrome.notifications.onClicked.addListener(async (id) => {
    try {
        const url = await getKV(id);
        if (url) await chrome.tabs.create({ url, active: true });
    } finally {
        await delKV(id);
        chrome.notifications.clear(id);
    }
    });

        // ===== 追加: attention完了でメタを使って通知 =====
    const defaultsSync = {
    enabled: false,
    desiredCounts: [2],
    notifier: { type: "ntfy", ntfyTopic: "relief-ticket", discordWebhookUrl: "" },
    reload: { enabled: true, minSec: 3, maxSec: 7 },
    scroll: { enabled: true, minPx: 100, maxPx: 5000, smooth: true },
    cooldownSec: 25
    };
    function getSync(){ return new Promise(r=>chrome.storage.sync.get(defaultsSync, r)); }
    function getLocal(keys){ return new Promise(r=>chrome.storage.local.get(keys, r)); }
    function setLocal(p){ return new Promise(r=>chrome.storage.local.set(p, r)); }

    async function sendExternalNotify(meta, settings){
    const lines = [];
    if (meta.artist) lines.push(`アーティスト: ${meta.artist}`);
    lines.push(`日時: ${meta.datetime}`);
    lines.push(`会場: ${meta.venue}`);
    if (meta.desiredLabel) lines.push(`選択枚数: ${meta.desiredLabel}`);
    if (meta.availableOptionsText) lines.push(`枚数候補: ${meta.availableOptionsText}`);
    if (meta.url) lines.push(`URL: ${meta.url}`);
    if (Array.isArray(meta.altUrls) && meta.altUrls.length){
        const brief = meta.altUrls.slice(0, 2).map(u => `${u.label}: ${u.url}`).join('\n');
        lines.push(`他の枚数URL:\n${brief}${meta.altUrls.length>2?' …他':''}`);
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
    } catch(e){ console.warn("[notify external failed]", e); }

    // デスクトップ通知（クリックでURLを開く）
    try{
        const title = `RELIEF: ${meta.artist ? meta.artist + " - " : ""}${meta.datetime}`;
        const message = `${meta.venue}\n${meta.desiredLabel ? `選択枚数: ${meta.desiredLabel}\n` : ""}${meta.url || ""}`.trim();
        const id = "relief-" + Date.now();
        chrome.notifications.create(id, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title, message,
        priority: 2,
        requireInteraction: true
        }, async () => {
        if (meta.url) await setKV(id, meta.url);
        });
    } catch(e){ console.warn("[desktop notify failed]", e); }
    }

    // attention完了のみトリガー（302で戻るケースは通知されない）
    chrome.webNavigation.onCompleted.addListener(async (details) => {
    try {
        const url = details.url || "";
        const m = url.match(/^https:\/\/relief-ticket\.jp\/checkout\/attention\/([^/?#]+)/);
        if (!m) return;
        const tno = m[1];

        const [sync, local] = await Promise.all([
        getSync(),
        getLocal(["attemptMeta"])
        ]);
        if (!sync.enabled) return;

        const meta = (local.attemptMeta || {})[tno];
        if (!meta) return; // content側の自動クリック起点でない遷移は通知しない

        await sendExternalNotify(meta, sync);

        // 1回通知したら破棄（重複抑止）
        delete local.attemptMeta[tno];
        await setLocal({ attemptMeta: local.attemptMeta });
    } catch(e){
        console.warn("[onCompleted error]", e);
    }
    }, {
    url: [{ hostEquals: "relief-ticket.jp", pathPrefix: "/checkout/attention/" }]
    });
