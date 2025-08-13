    // help.js — ヘルプ用のクライアントスクリプト（MV3対応／インライン禁止回避）
    (function(){
    // 画像が無い時のプレースホルダーに差し替え
    function attachPlaceholders(){
        const imgs = document.querySelectorAll('img.ph-check, img[data-ph]');
        imgs.forEach(img => {
        const text = img.dataset.ph || '画像を help_images/ に置いてください';
        img.addEventListener('error', () => {
            const ph = document.createElement('div');
            ph.className = 'placeholder';
            ph.textContent = text;
            img.replaceWith(ph);
        }, { once: true });
        });
    }

    // 画像拡大（ライトボックス）
    function attachLightbox(){
        const dlg = document.getElementById('zoom');
        if (!dlg) return;
        const img = dlg.querySelector('img');
        const closeBtn = dlg.querySelector('.zoom-close');

        document.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[data-zoom]');
        if (!a) return;
        e.preventDefault();
        img.src = a.getAttribute('href');
        img.alt = a.querySelector('img')?.alt || '';
        dlg.showModal();
        });

        closeBtn.addEventListener('click', ()=> dlg.close());
        dlg.addEventListener('click', (e)=> { if (e.target === dlg) dlg.close(); });
    }

    // 初期化
    document.addEventListener('DOMContentLoaded', () => {
        attachPlaceholders();
        attachLightbox();
        console.log('[help] ready');
    });
    })();
