const API_BASE = '/api';

const form = document.getElementById('download-form');
const urlInput = document.getElementById('url-input');
const pasteBtn = document.getElementById('paste-btn');
const submitBtn = document.getElementById('submit-btn');
const submitText = document.getElementById('submit-text');
const spinner = document.getElementById('spinner');
const errorMessage = document.getElementById('error-message');
const resultSection = document.getElementById('result-section');
const resultThumbnail = document.getElementById('result-thumbnail');
const resultTitle = document.getElementById('result-title');
const resultAuthor = document.getElementById('result-author');
const resultStats = document.getElementById('result-stats');
const downloadButtons = document.getElementById('download-buttons');
const newDownloadBtn = document.getElementById('new-download-btn');
const imagesSection = document.getElementById('images-section');
const imagesGrid = document.getElementById('images-grid');
const downloadAllImagesBtn = document.getElementById('download-all-images-btn');

let currentPageUrl = null;

function showLoading() {
    submitText.textContent = 'Downloading...';
    spinner.classList.remove('hidden');
    submitBtn.disabled = true;
    errorMessage.classList.add('hidden');
}

function hideLoading() {
    submitText.textContent = 'Download';
    spinner.classList.add('hidden');
    submitBtn.disabled = false;
}

function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.remove('hidden');
}

function hideError() {
    errorMessage.classList.add('hidden');
}

function extractTikTokUrl(text) {
    const patterns = [
        /https?:\/\/(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+/,
        /https?:\/\/(?:vm|vt)\.tiktok\.com\/[\w.-]+/,
        /https?:\/\/(?:www\.)?tiktok\.com\/t\/[\w.-]+/,
        /https?:\/\/(?:m|www)\.tiktok\.com\/v\/\d+/,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[0];
    }
    return null;
}

async function fetchVideoData(url) {
    const response = await fetch(`${API_BASE}/info?url=${encodeURIComponent(url)}`, {
        headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to fetch video data');
    }

    return response.json();
}

function formatNumber(num) {
    if (!num && num !== 0) return '';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

function showResults(data) {
    resultThumbnail.src = data.thumbnail || '';
    resultThumbnail.alt = data.title;
    resultTitle.textContent = data.title || 'TikTok Video';

    if (data.author) {
        const username = data.author.username || data.author.nickname || '@user';
        resultAuthor.innerHTML = `${username} ${data.author.id ? '· @' + data.author.id : ''}`;
    }

    // Stats
    if (resultStats && data.stats) {
        const stats = [];
        if (data.stats.view) stats.push(`👁 ${formatNumber(data.stats.view)}`);
        if (data.stats.like) stats.push(`❤ ${formatNumber(data.stats.like)}`);
        if (data.stats.comment) stats.push(`💬 ${formatNumber(data.stats.comment)}`);
        if (data.stats.share) stats.push(`↗️ ${formatNumber(data.stats.share)}`);
        resultStats.innerHTML = stats.map(s => `<span>${s}</span>`).join('');
    }

    downloadButtons.innerHTML = '';

    const baseFilename = (data.title || 'tiktok_video')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/["']/g, '')
        .slice(0, 60);

    // Tombol utama - HD (resolusi tertinggi, tanpa watermark)
    if (currentPageUrl) {
        const hdLabel = data.video && data.video.format
            ? `Download Video HD (${data.video.format} - No Watermark)`
            : 'Download Video HD (No Watermark)';
        downloadButtons.appendChild(createDownloadButton(
            downloadFileUrl(currentPageUrl, 'video', 'hd'),
            hdLabel,
            'primary'
        ));

        // Tombol SD (resolusi rendah, file lebih kecil)
        downloadButtons.appendChild(createDownloadButton(
            downloadFileUrl(currentPageUrl, 'video', 'sd'),
            'Download Video Standard (SD - File Kecil)',
            'secondary'
        ));

        // Audio
        if (data.audio) {
            downloadButtons.appendChild(createDownloadButton(
                downloadFileUrl(currentPageUrl, 'audio'),
                `Download Audio Only (${data.audio.format || 'MP3'})`,
                'secondary'
            ));
        }
    } else if (data.video && data.video.url) {
        downloadButtons.appendChild(createDownloadButton(
            proxyUrl(data.video.url, `${baseFilename}.mp4`),
            `Download Video (${data.video.format || 'HD'})`,
            'primary'
        ));
    }

    resultSection.classList.remove('hidden');
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Ambil foto (cover / slide) secara paralel
    if (currentPageUrl) {
        loadImages(currentPageUrl);
    }
}

async function loadImages(pageUrl) {
    try {
        const response = await fetch(`/api/images?url=${encodeURIComponent(pageUrl)}`);
        if (!response.ok) {
            imagesSection.classList.add('hidden');
            return;
        }
        const data = await response.json();
        renderImages(data.images || [], data.title || 'tiktok');
    } catch (err) {
        console.warn('Gambar tidak tersedia:', err.message);
        imagesSection.classList.add('hidden');
    }
}

function renderImages(urls, title) {
    if (!urls || urls.length === 0) {
        imagesSection.classList.add('hidden');
        return;
    }

    const safeBase = (title || 'tiktok_image')
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/["']/g, '')
        .trim()
        .slice(0, 40) || 'tiktok_image';

    imagesGrid.innerHTML = '';
    urls.forEach((url, i) => {
        const item = document.createElement('div');
        item.className = 'image-item';

        const img = document.createElement('img');
        img.src = `/api/proxy-image?url=${encodeURIComponent(url)}`;
        img.alt = `Foto ${i + 1}`;
        img.loading = 'lazy';

        const a = document.createElement('a');
        a.className = 'image-item-btn';
        a.href = img.src;
        a.download = `${safeBase}_${i + 1}.jpg`;
        a.textContent = '💾 Simpan';

        item.appendChild(img);
        item.appendChild(a);
        imagesGrid.appendChild(item);
    });

    downloadAllImagesBtn.href = `/api/images-zip?url=${encodeURIComponent(currentPageUrl)}&title=${encodeURIComponent(safeBase)}`;
    downloadAllImagesBtn.hidden = urls.length > 1;
    if (urls.length > 1) {
        downloadAllImagesBtn.hidden = false;
        downloadAllImagesBtn.style.display = 'flex';
    }

    imagesSection.classList.remove('hidden');
}

function downloadFileUrl(pageUrl, media, quality) {
    return `/api/download-file?url=${encodeURIComponent(pageUrl)}&media=${media}&quality=${quality || 'hd'}`;
}

function proxyUrl(videoUrl, filename) {
    return `/api/proxy?url=${encodeURIComponent(videoUrl)}&filename=${encodeURIComponent(filename || 'tiktok_video.mp4')}`;
}

function createDownloadButton(href, label, type) {
    const btn = document.createElement('a');
    btn.href = href;
    btn.rel = 'noopener noreferrer';
    btn.className = `download-btn${type === 'secondary' ? ' secondary' : ''}`;

    const icon = type === 'primary'
        ? `<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>`
        : (label.includes('Audio')
            ? `<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z"/></svg>`
            : `<svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`);

    btn.innerHTML = `${icon}${label}`;
    return btn;
}

async function handleSubmit(e) {
    if (e) e.preventDefault();
    hideError();

    const url = urlInput.value.trim();
    if (!url) {
        showError('Please enter a TikTok video URL');
        return;
    }

    const extractedUrl = extractTikTokUrl(url) || url;
    currentPageUrl = extractedUrl;

    showLoading();

    try {
        const data = await fetchVideoData(extractedUrl);
        if (data && (data.video || data.videos)) {
            showResults(data);
        } else {
            showError('Could not find video. Please check the URL and try again.');
            resultSection.classList.add('hidden');
        }
    } catch (error) {
        showError(error.message || 'An error occurred. Please try again.');
        resultSection.classList.add('hidden');
    } finally {
        hideLoading();
    }
}

pasteBtn.addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        urlInput.value = text;
        urlInput.focus();
    } catch (err) {
        urlInput.focus();
    }
});

urlInput.addEventListener('input', () => {
    hideError();
});

newDownloadBtn.addEventListener('click', () => {
    resultSection.classList.add('hidden');
    urlInput.value = '';
    urlInput.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Tampilkan pesan saat download disiapkan oleh server (butuh waktu beberapa detik)
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.download-btn');
    if (!btn) return;
    const href = btn.getAttribute('href');
    if (href && href.startsWith('/api/download-file')) {
        btn.classList.add('preparing');
        const original = btn.innerHTML;
        btn.dataset.original = original;
        btn.innerHTML = `
            <svg id="dl-spinner" class="spinner" width="20" height="20" fill="none" viewBox="0 0 24 24">
                <circle class="spinner-circle" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="spinner-path" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            Menyiapkan download...
        `;
        setTimeout(() => {
            if (btn.dataset.original) {
                btn.innerHTML = btn.dataset.original;
                delete btn.dataset.original;
                btn.classList.remove('preparing');
            }
        }, 30000);
    }
});

form.addEventListener('submit', handleSubmit);

urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        handleSubmit(e);
    }
});

document.addEventListener('DOMContentLoaded', () => {
    urlInput.focus();
});
