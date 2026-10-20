/**
 * TikTok Downloader Service
 * Menggunakan yt-dlp untuk mengekstrak video TikTok tanpa watermark
 * yt-dlp adalah tool open-source yang paling andal untuk ini
 *
 * CATATAN PENTING:
 * TikTok secara agresif memblokir IP datacenter (mis. VPS, cloud provider).
 * Jika Anda mengalami error "Your IP address is blocked" atau
 * "Unsupported URL", kemungkinan IP Anda diblokir TikTok.
 *
 * Solusi:
 * 1. Hosting di residential IP / server yang tidak diblokir
 * 2. Sediakan file cookies.txt dari akun TikTok Anda (untuk video private/premium)
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT_DIR = path.join(__dirname, '..');

// Path yt-dlp adaptif antar platform:
// - Windows: backend/bin/yt-dlp.exe
// - Linux (Render/VPS): pakai 'yt-dlp' dari PATH, atau YTDLP_PATH bila di-set
const YTDLP_PATH = process.env.YTDLP_PATH ||
    (process.platform === 'win32'
        ? path.join(ROOT_DIR, 'bin', 'yt-dlp.exe')
        : 'yt-dlp');
const COOKIES_PATH = process.env.COOKIES_PATH || path.join(ROOT_DIR, 'cookies.txt');

/** Mode ekstraksi: 'auto' (yt-dlp dulu, fallback TikWM) atau 'tikwm' (hanya TikWM) */
const EXTRACTOR_MODE = (process.env.EXTRACTOR || 'auto').toLowerCase();

/**
 * Memeriksa apakah yt-dlp tersedia
 */
function checkYtDlp() {
    if (!fs.existsSync(YTDLP_PATH)) {
        return false;
    }
    return true;
}

/**
 * Menjalankan perintah yt-dlp dan mengembalikan output JSON
 */
function runYtDlp(args) {
    return new Promise((resolve, reject) => {
        execFile(
            YTDLP_PATH,
            args,
            { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                    return;
                }
                resolve(stdout);
            }
        );
    });
}

/**
 * Mendapatkan info video dari URL TikTok
 * @param {string} url - URL video TikTok
 * @returns {Promise<object>} - Info video termasuk link download tanpa watermark
 */
async function getVideoInfo(url) {
    const args = [
        '--dump-single-json',
        '--no-warnings',
        '--no-playlist',
        '--skip-download',
        '--no-mtime',
    ];

    // Gunakan cookies jika tersedia (opsional, membantu kalau video private)
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }

    args.push(url);

    const output = await runYtDlp(args);
    return JSON.parse(output);
}

/**
 * Mendengarkan format download yang tersedia dan memilih yang terbaik
 * @param {object} info - Info video dari yt-dlp
 * @returns {object} - { hd, standard, audio } URL download
 */
function extractDownloadUrls(info) {
    const formats = info.formats || [];
    
    // Cari format video tanpa watermark (biasanya format dengan format_id mengandung 'watermark' yang harus dihindari)
    const cleanFormats = formats.filter(f => !(f.format_note || '').toLowerCase().includes('watermark'));

    // Pilih format video kualitas terbaik
    let hd = null;
    let standard = null;
    let audio = null;

    // Prioritaskan format resolusi tinggi
    const sortedByRes = [...cleanFormats]
        .filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
        .sort((a, b) => (b.height || 0) - (a.height || 0));

    if (sortedByRes.length > 0) {
        hd = {
            url: sortedByRes[0].url,
            format: `${sortedByRes[0].height}p`,
            ext: sortedByRes[0].ext || 'mp4',
            filesize: sortedByRes[0].filesize
        };

        if (sortedByRes.length > 1) {
            standard = {
                url: sortedByRes[sortedByRes.length - 1].url,
                format: `${sortedByRes[sortedByRes.length - 1].height}p`,
                ext: sortedByRes[sortedByRes.length - 1].ext || 'mp4',
                filesize: sortedByRes[sortedByRes.length - 1].filesize
            };
        }
    }

    // Cari audio track
    const audioFormat = cleanFormats.find(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
    if (audioFormat) {
        audio = {
            url: audioFormat.url,
            format: 'Audio',
            ext: audioFormat.ext || 'm4a'
        };
    }

    // Fallback ke URL utama
    if (!hd && info.url) {
        hd = {
            url: info.url,
            format: `${info.height || 'HD'}p`,
            ext: info.ext || 'mp4'
        };
    }

    return { hd, standard, audio };
}

/**
 * Normalisasi response untuk frontend
 * @param {object} info - Info dari getVideoInfo
 * @returns {object} - Response siap dikirim ke client
 */
function formatResponse(info) {
    const { hd, standard, audio } = extractDownloadUrls(info);

    return {
        id: info.id,
        title: info.title || 'TikTok Video',
        description: info.description,
        duration: info.duration,
        thumbnail: info.thumbnail,
        author: {
            id: info.uploader_id,
            username: info.uploader,
            avatar: info.thumbnails && info.thumbnails.length > 0 ? info.thumbnails[info.thumbnails.length - 1].url : null
        },
        stats: {
            like: info.like_count,
            comment: info.comment_count,
            share: info.repost_count,
            view: info.view_count
        },
        video: {
            url: hd ? hd.url : null,
            format: hd ? hd.format : null,
            ext: hd ? hd.ext : null,
            filesize: hd ? hd.filesize : null
        },
        videos: [
            { format: 'HD Quality', ...(hd || {}) },
            { format: 'Standard', ...(standard || {}) }
        ].filter(v => v.url),
        audio: audio
    };
}

/**
 * Fallback menggunakan TikWM API
 * https://tikwm.com - layanan publik untuk download video TikTok tanpa watermark
 * Stabil dan tidak memerlukan API key. Sering digunakan oleh banyak situs downloader TikTok.
 */
async function getVideoInfoFallback(url) {
    const TIKWM_API = process.env.TIKWM_API || 'https://www.tikwm.com/api/';

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);

        const formData = new URLSearchParams();
        formData.append('url', url);
        formData.append('hd', '1');

        const response = await fetch(TIKWM_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'User-Agent': 'MyTTDownloader/1.0'
            },
            body: formData.toString(),
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`TikWM API error: ${response.status}`);
        }

        const json = await response.json();

        if (!json || json.code !== 0 || !json.data) {
            throw new Error(json.msg || 'TikWM returned no data');
        }

        const d = json.data;

        // Kumpulkan semua gambar (slide photo / cover) ke dalam satu array
        const images = [];
        if (Array.isArray(d.images) && d.images.length > 0) {
            d.images.forEach(url => { if (url) images.push(url); });
        }
        if (!images.length && d.origin_cover) images.push(d.origin_cover);
        if (!images.length && d.cover) images.push(d.cover);

        return {
            id: d.id,
            title: d.title || 'TikTok Video',
            description: d.title || '',
            duration: d.duration,
            thumbnail: d.origin_cover || d.cover || null,
            images,
            author: {
                id: d.author_id,
                username: d.author || '@user',
                avatar: d.author_avatar || null,
                unique_id: d.unique_id || null
            },
            stats: {
                like: d.digg_count,
                comment: d.comment_count,
                share: d.share_count,
                view: d.play_count
            },
            video: {
                url: d.hdplay || d.play || d.video || null,
                format: d.hdplay ? 'HD' : 'Standard',
                ext: 'mp4',
                filesize: null
            },
            videos: [
                { url: d.hdplay || null, format: 'HD', ext: 'mp4' },
                { url: d.play || null, format: 'Standard', ext: 'mp4' },
                { url: d.music || null, format: 'Music', ext: 'mp3' }
            ].filter(v => v.url),
            audio: d.music ? { url: d.music, format: 'Music', ext: 'mp3' } : null
        };
    } catch (err) {
        console.error('TikWM fallback error:', err.message);
        throw err;
    }
}

/**
 * Mendownload video/musik TikTok ke file lokal menggunakan yt-dlp
 * Membypass blokir CDN (Akamai) yang menolak akses programatik.
 *
 * @param {string} url - URL halaman video TikTok
 * @param {string} outputPath - path lengkap tujuan file (tanpa ekstensi)
 * @param {string} media - 'video' atau 'audio'
 * @param {string} quality - 'hd' (resolusi tinggi) atau 'sd' (resolusi sedang)
 * @returns {Promise<{filePath: string, ext: string, title: string, filesize: number}>}
 */
async function downloadVideo(url, outputPath, media = 'video', quality = 'hd') {
    // Ambil info format dulu untuk memilih format tanpa watermark terbaik
    const args = [
        '--dump-single-json',
        '--no-warnings',
        '--no-playlist',
        '--skip-download',
        '--no-mtime',
    ];

    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    args.push(url);

    const info = JSON.parse(await runYtDlp(args));
    const formats = info.formats || [];

    // Daftar format yang akan dicoba (urutan prioritas)
    let tryList = [];

    if (media === 'audio') {
        const audioFmt = formats.find(f => f.format_id === 'audio') ||
                         formats.find(f => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');
        if (!audioFmt) throw new Error('Tidak ada format audio yang cocok');
        tryList = [audioFmt];
    } else {
        // Pilih format: hindari "download" (watermarked) dan audio-only
        const candidates = formats.filter(f =>
            f.vcodec && f.vcodec !== 'none' &&
            f.acodec && f.acodec !== 'none' &&
            !(f.format_note || '').toLowerCase().includes('watermark') &&
            f.format_id !== 'download'
        );

        if (candidates.length === 0) {
            throw new Error('Tidak ada format video yang cocok');
        }

        // Skor kualitas: resolusi 70% + bitrate 30%
        const bitrate = (f) => (f.tbr || f.vbr || (f.filesize && info.duration ? Math.round(f.filesize * 8 / info.duration) : 0) || 0);
        const maxH = Math.max(...candidates.map(f => f.height || 0));
        const maxB = Math.max(...candidates.map(f => bitrate(f)));
        const score = (f) => ((f.height || 0) / (maxH || 1)) * 0.7 + (bitrate(f) / (maxB || 1)) * 0.3;

        const ranked = [...candidates].sort((a, b) => score(b) - score(a));

        if (quality === 'hd') {
            // HD: utamakan h264 (kompatibel + andal), lalu sisanya
            const h264Pool = ranked.filter(f => (f.vcodec || '').toLowerCase().includes('h264'));
            const others = ranked.filter(f => !(f.vcodec || '').toLowerCase().includes('h264'));
            tryList = [...h264Pool, ...others];
        } else {
            // SD: pilih resolusi paling rendah dulu (file kecil), lalu naik
            const ascending = [...ranked].sort((a, b) => (a.height || 0) - (b.height || 0) || bitrate(a) - bitrate(b));
            const least = ascending.filter(f => (f.height || 0) >= 360);
            tryList = [...least, ...ascending];
        }
    }

    // Coba setiap format sampai satu berhasil
    let lastError = null;
    let filePath = null;
    let finalExt = null;

    for (const fmt of tryList) {
        const outPath = `${outputPath}.%(ext)s`;
        const dlArgs = [
            '-f', fmt.format_id,
            '-o', outPath,
            '--no-playlist',
            '--no-warnings',
            '--no-mtime',
        ];
        if (fs.existsSync(COOKIES_PATH)) {
            dlArgs.push('--cookies', COOKIES_PATH);
        }
        dlArgs.push(url);

        try {
            await runYtDlp(dlArgs);

            // Cari file hasil download (yt-dlp menulis ke outputPath.<ext>)
            const dir = path.dirname(outputPath);
            const base = path.basename(outputPath);
            const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
            if (files.length === 0) {
                lastError = new Error('File hasil download tidak ditemukan');
                continue;
            }
            filePath = path.join(dir, files[0]);
            finalExt = path.extname(files[0]).replace('.', '');
            break;
        } catch (err) {
            lastError = err;
            console.warn(`Format ${fmt.format_id} gagal, coba berikutnya:`, err.message);
            // Bersihkan file parsial
            const dir = path.dirname(outputPath);
            const base = path.basename(outputPath);
            fs.readdirSync(dir).filter(f => f.startsWith(base)).forEach(f => {
                try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
            });
        }
    }

    if (!filePath) {
        throw lastError || new Error('Gagal mengunduh video');
    }

    return {
        filePath,
        ext: finalExt || 'mp4',
        title: info.title || 'TikTok Video',
        filesize: fs.statSync(filePath).size
    };
}

/**
 * Mengambil daftar gambar (slide post / cover) dari URL TikTok.
 * Menggunakan yt-dlp JSON (thumbnail) sebagai sumber utama.
 * @param {string} url
 * @returns {Promise<{title: string, images: string[]}>}
 */
async function getImages(url) {
    const args = [
        '--dump-single-json',
        '--no-warnings',
        '--no-playlist',
        '--skip-download',
        '--no-mtime',
    ];
    if (fs.existsSync(COOKIES_PATH)) {
        args.push('--cookies', COOKIES_PATH);
    }
    args.push(url);

    const info = JSON.parse(await runYtDlp(args));

    const images = [];
    if (Array.isArray(info.thumbnails)) {
        // Ambil thumbnail resolusi terbaik yang berbeda-beda
        const seen = new Set();
        [...info.thumbnails]
            .sort((a, b) => ((b.width || 0) + (b.height || 0)) - ((a.width || 0) + (a.height || 0)))
            .forEach(t => {
                if (t.url && !seen.has(t.url)) {
                    seen.add(t.url);
                    images.push(t.url);
                }
            });
    }
    if (info.thumbnail && !images.includes(info.thumbnail)) {
        images.push(info.thumbnail);
    }
    if (images.length === 0 && info.thumbnails && info.thumbnails.length) {
        images.push(info.thumbnails[0].url);
    }

    return { title: info.title || 'TikTok Video', images };
}

/**
 * Memilih URL media langsung dari data TikWM untuk didownload server-side.
 * Cocok untuk lingkungan tanpa yt-dlp (mis. Render / VPS Linux).
 *
 * @param {object} data - hasil getVideoInfoFallback
 * @param {string} media - 'video' | 'audio'
 * @param {string} quality - 'hd' | 'sd'
 * @returns {{url: string, ext: string} | null}
 */
function resolveDirectUrl(data, media = 'video', quality = 'hd') {
    if (!data) return null;

    if (media === 'audio') {
        if (data.audio && data.audio.url) return { url: data.audio.url, ext: 'mp3' };
        return null;
    }

    const candidate = quality === 'hd'
        ? (data.videos || []).find(v => v.format === 'HD') || data.video
        : (data.videos || []).find(v => v.format === 'Standard') || data.video;

    if (candidate && candidate.url) {
        return { url: candidate.url, ext: candidate.ext || 'mp4' };
    }
    if (data.video && data.video.url) {
        return { url: data.video.url, ext: data.video.ext || 'mp4' };
    }
    return null;
}

module.exports = {
    getVideoInfo,
    formatResponse,
    checkYtDlp,
    getVideoInfoFallback,
    downloadVideo,
    getImages,
    resolveDirectUrl,
    YTDLP_PATH,
    ROOT_DIR,
    EXTRACTOR_MODE
};
