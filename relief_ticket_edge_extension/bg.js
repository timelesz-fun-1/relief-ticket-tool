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
