/**
 * TikTok Downloader Backend Server
 * Menyediakan REST API untuk mengekstrak dan mendownload video TikTok tanpa watermark
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

// Load .env jika ada (Node 20.12+)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    try { process.loadEnvFile(envPath); } catch (e) { console.warn('Gagal load .env:', e.message); }
}

const tiktokService = require('./services/tiktokService');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Serve frontend statis (folder parent: D:\mini snaptik)
const FRONTEND_DIR = path.join(__dirname, '..'); // backend/.. = root proyek
app.use(express.static(FRONTEND_DIR));

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        name: 'MyTTDownloader API',
        version: '1.0.0',
        endpoints: ['/api/info', '/api/download']
    });
});

/**
 * Validasi URL TikTok
 */
function isValidTikTokUrl(url) {
    if (!url) return false;
    return /https?:\/\/(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/.*/i.test(url) ||
           /https?:\/\/(?:www\.)?douyin\.com\/.*/i.test(url);
}

/**
 * Extracting video ID dari URL untuk penamaan file
 */
function extractVideoId(url) {
    const patterns = [
        /\/video\/(\d+)/,
        /\/v\/(\d+)/,
        /\/@[\w.-]+\/video\/(\d+)/,
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    return Date.now();
}

/**
 * GET /api/info?url=...
 * Mengembalikan info video + link download tanpa watermark
 */
app.get('/api/info', async (req, res) => {
    const url = req.query.url;

    if (!isValidTikTokUrl(url)) {
        return res.status(400).json({ error: 'URL TikTok tidak valid' });
    }

try {
    let info;
    try {
        // Coba ekstraksi lokal via yt-dlp
        info = await tiktokService.getVideoInfo(url);
    } catch (ytdlpErr) {
        console.warn('yt-dlp gagal, mencoba fallback TikWM:', ytdlpErr.message);
        // Fallback: jika IP diblokir atau yt-dlp gagal, gunakan TikWM
        const fallbackResult = await tiktokService.getVideoInfoFallback(url);
        return res.json(fallbackResult);
    }
    const response = tiktokService.formatResponse(info);
    res.json(response);
} catch (err) {
    console.error('Info error:', err.message);
    res.status(500).json({ error: 'Gagal mengambil info video. Pastikan URL valid dan video publik.' });
}
});

/**
 * GET /api/download?url=...
 * Redirect ke video langsung untuk download
 */
app.get('/api/download', async (req, res) => {
    const url = req.query.url;

    if (!isValidTikTokUrl(url)) {
        return res.status(400).json({ error: 'URL TikTok tidak valid' });
    }

    try {
        const info = await tiktokService.getVideoInfo(url);
        const { hd } = tiktokService.extractDownloadUrls(info);

        if (!hd || !hd.url) {
            return res.status(404).json({ error: 'Video tidak ditemukan' });
        }

        const videoId = extractVideoId(url);
        const filename = `tiktok_${info.uploader || 'user'}_${videoId}_${hd.format}.${hd.ext || 'mp4'}`;

        res.redirect(hd.url);
    } catch (err) {
        console.error('Download error:', err.message);
        res.status(500).json({ error: 'Gagal mengunduh video' });
    }
});

/**
 * GET /api/video?url=...
 * Mengembalikan JSON dengan URL langsung untuk dipakai frontend
 */
app.get('/api/video', async (req, res) => {
    const url = req.query.url;

    if (!isValidTikTokUrl(url)) {
        return res.status(400).json({ error: 'URL TikTok tidak valid' });
    }

    try {
        let response;
        try {
            const info = await tiktokService.getVideoInfo(url);
            response = tiktokService.formatResponse(info);
        } catch (ytdlpErr) {
            console.warn('yt-dlp gagal untuk /api/video, mencoba fallback:', ytdlpErr.message);
            response = await tiktokService.getVideoInfoFallback(url);
        }
        res.json(response);
    } catch (err) {
        console.error('Video error:', err.message);
        res.status(500).json({ error: 'Gagal memproses video' });
    }
});

/**
 * Helper: mengalirkan file remote (CDN) ke response browser
 * dengan header yang benar agar tidak kena 403/block.
 * Dipakai oleh /api/proxy dan fallback TikWM di /api/download-file.
 *
 * @param {object} res - Express response
 * @param {string} remoteUrl - URL file sumber
 * @param {string} filename - nama file untuk Content-Disposition
 * @param {string} type - 'video' | 'audio'
 * @param {object} options - { redirects: number }
 */
function streamRemote(res, remoteUrl, filename, type = 'video', options = {}) {
    const maxRedirects = options.redirects ?? 5;

    let parsedUrl;
    try {
        parsedUrl = new URL(remoteUrl);
    } catch (e) {
        if (!res.headersSent) res.status(400).json({ error: 'URL tidak valid' });
        return;
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const accept = type === 'audio' ? 'audio/*,*/*' : 'video/mp4, video/webm, video/*, */*';

    const proxyReq = lib.get({
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Referer': 'https://www.tiktok.com/',
            'Accept': accept,
            'Accept-Language': 'en-US,en;q=0.9'
        }
    }, (proxyRes) => {
        // Ikuti redirect
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            proxyRes.resume();
            if (maxRedirects <= 0) {
                if (!res.headersSent) res.status(502).json({ error: 'Terlalu banyak redirect' });
                return;
            }
            streamRemote(res, proxyRes.headers.location, filename, type, { redirects: maxRedirects - 1 });
            return;
        }

        if (proxyRes.statusCode !== 200) {
            if (!res.headersSent) {
                res.status(proxyRes.statusCode).json({ error: 'Gagal mengambil file (HTTP ' + proxyRes.statusCode + ')' });
            }
            proxyRes.resume();
            return;
        }

        const contentType = proxyRes.headers['content-type'] ||
            (type === 'audio' ? 'audio/mpeg' : 'video/mp4');
        const safeFilename = String(filename || 'tiktok_video.mp4')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/["']/g, '');

        res.setHeader('Content-Type', contentType);
        if (proxyRes.headers['content-length']) {
            res.setHeader('Content-Length', proxyRes.headers['content-length']);
        }
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
        res.setHeader('Cache-Control', 'no-store');

        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error('streamRemote error:', err.message);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Gagal terhubung ke server file: ' + err.message });
        } else {
            res.end();
        }
    });

    proxyReq.setTimeout(60000, () => {
        proxyReq.destroy();
        if (!res.headersSent) {
            res.status(504).json({ error: 'Timeout saat mengambil file' });
        }
    });
}

/**
 * GET /api/proxy?url=...&filename=...
 * Mengambil file video dari CDN TikTok dengan header yang benar,
 * lalu mengalirkan (stream) ke browser sebagai file download.
 * Ini solusi untuk 403 Forbidden saat membuka link CDN langsung.
 */
app.get('/api/proxy', (req, res) => {
    const videoUrl = req.query.url;
    const filename = req.query.filename || 'tiktok_video.mp4';

    if (!videoUrl) {
        return res.status(400).json({ error: 'Parameter url wajib diisi' });
    }

    streamRemote(res, videoUrl, filename, 'video');
});

/**
 * GET /api/download-file?url=...&quality=hd
 * Mendownload video lalu mengalirkan ke browser sebagai file download.
 *
 * Strategi:
 * 1. Jika yt-dlp TERSEDIA (mode auto) & bukan EXTRACTOR=tikwm:
 *    unduh via yt-dlp ke temp (mengatasi 403 Akamai), lalu stream.
 * 2. Jika yt-dlp TIDAK tersedia (Render/VPS Linux) atau mode tikwm:
 *    ambil URL langsung dari TikWM lalu stream via server (bypass 403 CDN).
 */
app.get('/api/download-file', async (req, res) => {
    const url = req.query.url;
    const media = req.query.media === 'audio' ? 'audio' : 'video';
    const quality = req.query.quality === 'sd' ? 'sd' : 'hd';

    if (!isValidTikTokUrl(url)) {
        return res.status(400).json({ error: 'URL TikTok tidak valid' });
    }

    const tempDir = process.env.TEMP_DIR || path.join(require('os').tmpdir(), 'mytik-downloads');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const fileToken = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const outputPath = path.join(tempDir, `tt_${fileToken}`);

    const safeTitle = (t) => String(t || 'tiktok_video')
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/["']/g, '')
        .trim()
        .slice(0, 40) || 'tiktok_video';

    // Mode hanya-TikWM (tanpa yt-dlp) → stream langsung dari URL CDN
    const forceTikwm = tiktokService.EXTRACTOR_MODE === 'tikwm';

    if (forceTikwm) {
        try {
            const data = await tiktokService.getVideoInfoFallback(url);
            const picked = tiktokService.resolveDirectUrl(data, media, quality);
            if (!picked || !picked.url) {
                return res.status(404).json({ error: 'Tidak ada URL media yang cocok dari TikWM.' });
            }
            const base = safeTitle(data.title);
            const qualityTag = media === 'audio' ? '_audio' : (quality === 'hd' ? '_HD' : '_SD');
            const filename = `${base}${qualityTag}.${picked.ext}`;
            return streamRemote(res, picked.url, filename, media === 'audio' ? 'audio' : 'video');
        } catch (err) {
            console.error('Download-file (tikwm) error:', err.message);
            if (!res.headersSent) {
                return res.status(500).json({ error: 'Gagal mengunduh video: ' + err.message });
            }
            return;
        }
    }

    try {
        const result = await tiktokService.downloadVideo(url, outputPath, media, quality);

        const filename = `${safeTitle(result.title)}${media === 'audio' ? '_audio' : (quality === 'hd' ? '_HD' : '_SD')}.${result.ext}`;

        res.setHeader('Content-Type', `video/${result.ext === 'mp4' ? 'mp4' : result.ext}`);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', result.filesize);
        res.setHeader('Cache-Control', 'no-store');

        const stream = fs.createReadStream(result.filePath);
        stream.on('error', (err) => {
            console.error('Stream error:', err.message);
            res.status(500).end();
        });
        res.on('finish', () => {
            fs.unlink(result.filePath, () => {});
        });
        stream.pipe(res);
    } catch (err) {
        console.error('Download-file (yt-dlp) error:', err.message);
        // Fallback: kalau yt-dlp gagal (IP diblokir dll), coba stream TikWM
        try {
            const data = await tiktokService.getVideoInfoFallback(url);
            const picked = tiktokService.resolveDirectUrl(data, media, quality);
            if (!picked || !picked.url) {
                throw new Error('Fallback TikWM juga gagal: tidak ada URL cocok');
            }
            if (!res.headersSent) {
                return streamRemote(res, picked.url,
                    `${safeTitle(data.title)}${media === 'audio' ? '_audio' : (quality === 'hd' ? '_HD' : '_SD')}.${picked.ext}`,
                    media === 'audio' ? 'audio' : 'video');
            }
        } catch (fbErr) {
            console.error('Download-file fallback error:', fbErr.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Gagal mengunduh video: ' + fbErr.message });
            }
        }
        // Bersihkan file parsial jika ada
        fs.readdirSync(tempDir).forEach(f => {
            if (f.startsWith(`tt_${fileToken}`)) {
                fs.unlink(path.join(tempDir, f), () => {});
            }
        });
    }
});

/**
 * GET /api/images?url=...
 * Mengembalikan daftar URL gambar (cover / slide foto) dari video TikTok.
 * Dipakai frontend untuk fitur "Download Gambar".
 */
app.get('/api/images', async (req, res) => {
    const url = req.query.url;

    if (!isValidTikTokUrl(url)) {
        return res.status(400).json({ error: 'URL TikTok tidak valid' });
    }

    try {
        // Coba TikWM dulu (mendukung slide foto images[])
        let data;
        try {
            data = await tiktokService.getVideoInfoFallback(url);
        } catch (fallbackErr) {
            console.warn('TikWM gagal untuk /api/images, coba yt-dlp:', fallbackErr.message);
            data = await tiktokService.getImages(url);
        }

        const images = Array.isArray(data.images) ? data.images : [];
        if (images.length === 0 && data.thumbnail) images.push(data.thumbnail);

        if (images.length === 0) {
            return res.status(404).json({ error: 'Tidak ada gambar yang ditemukan untuk video ini.' });
        }

        res.json({
            title: data.title || 'TikTok Video',
            images
        });
    } catch (err) {
        console.error('Images error:', err.message);
        res.status(500).json({ error: 'Gagal mengambil gambar video: ' + err.message });
    }
});

/**
 * GET /api/proxy-image?url=...
 * Proksi gambar agar bisa tampil/diunduh dari browser tanpa 403.
 */
app.get('/api/proxy-image', (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).json({ error: 'Parameter url wajib diisi' });

    let parsedUrl;
    try {
        parsedUrl = new URL(imageUrl);
    } catch (e) {
        return res.status(400).json({ error: 'URL tidak valid' });
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const options = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Referer': 'https://www.tiktok.com/',
            'Accept': 'image/*,*/*'
        }
    };

    const proxyReq = lib.get(options, (proxyRes) => {
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            res.redirect(proxyRes.headers.location);
            proxyRes.resume();
            return;
        }
        if (proxyRes.statusCode !== 200) {
            res.status(proxyRes.statusCode).json({ error: 'Gagal mengambil gambar' });
            proxyRes.resume();
            return;
        }
        res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error('Proxy-image error:', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Gagal mengambil gambar' });
        else res.end();
    });
});

/**
 * GET /api/images-zip?url=...&title=...
 * Membuat file ZIP berisi semua gambar (cover / slide) video TikTok.
 */
app.get('/api/images-zip', async (req, res) => {
    const url = req.query.url;
    const reqTitle = req.query.title || 'tiktok_image';

    if (!isValidTikTokUrl(url)) {
        return res.status(400).json({ error: 'URL TikTok tidak valid' });
    }

    try {
        let data;
        try {
            data = await tiktokService.getVideoInfoFallback(url);
        } catch (fallbackErr) {
            console.warn('TikWM gagal untuk /api/images-zip, coba yt-dlp:', fallbackErr.message);
            data = await tiktokService.getImages(url);
        }

        const images = Array.isArray(data.images) ? data.images : [];
        if (images.length === 0 && data.thumbnail) images.push(data.thumbnail);

        if (images.length === 0) {
            return res.status(404).json({ error: 'Tidak ada gambar yang ditemukan' });
        }

        // Unduh semua gambar sekaligus dengan Promise.all (maks 20)
        const limit = Math.min(images.length, 20);
        const chunks = [];
        await Promise.all(images.slice(0, limit).map(async (imgUrl) => {
            try {
                const arr = await fetchBuffer(imgUrl);
                if (arr && arr.length > 0) chunks.push({ url: imgUrl, data: arr });
            } catch (e) { /* lewati gambar gagal */ }
        }));

        if (chunks.length === 0) {
            return res.status(500).json({ error: 'Gagal mengunduh gambar' });
        }

        const safeBase = String(reqTitle || 'tiktok_image')
            .replace(/[^\x20-\x7E]/g, '').replace(/[\\/:*?"<>|]/g, '_')
            .trim().slice(0, 40) || 'tiktok_image';

        const zip = buildZip(chunks.map((c, i) => ({
            name: `${safeBase}_${i + 1}.jpg`,
            data: c.data
        })));

        const zipName = `${safeBase}_foto.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
        res.setHeader('Content-Length', zip.length);
        res.setHeader('Cache-Control', 'no-store');
        res.end(zip);
    } catch (err) {
        console.error('Images-zip error:', err.message);
        res.status(500).json({ error: 'Gagal membuat ZIP gambar: ' + err.message });
    }
});

// ---- Helper: unduh buffer dari URL ----
async function fetchBuffer(imageUrl) {
    return new Promise((resolve, reject) => {
        let parsedUrl;
        try { parsedUrl = new URL(imageUrl); } catch (e) { return reject(e); }
        const lib = parsedUrl.protocol === 'https:' ? https : http;
        const req = lib.get({
            protocol: parsedUrl.protocol,
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0',
                'Referer': 'https://www.tiktok.com/',
                'Accept': 'image/*,*/*'
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchBuffer(res.headers.location).then(resolve).catch(reject);
                res.resume();
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
    });
}

// ---- Helper: bangun ZIP sederhana (no external dependency) ----
function buildZip(files) {
    const zip = [];
    const centralDir = [];
    let offset = 0;
    const crcTable = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();
    const crc32 = (buf) => {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    };
    const nameBuf = (n) => Buffer.from(n, 'utf8');

    files.forEach(f => {
        const nb = nameBuf(f.name);
        const crc = crc32(f.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);            // signature
        local.writeUInt16LE(20, 4);                     // version
        local.writeUInt16LE(0, 6);                      // flags
        local.writeUInt16LE(0, 8);                      // method (store)
        local.writeUInt16LE(0, 10);                     // mod time
        local.writeUInt16LE(0x21, 12);                  // mod date
        local.writeUInt32LE(crc, 14);                   // crc32
        local.writeUInt32LE(f.data.length, 18);         // compressed size
        local.writeUInt32LE(f.data.length, 22);         // uncompressed size
        local.writeUInt16LE(nb.length, 26);             // name length
        local.writeUInt16LE(0, 28);                     // extra length
        zip.push(local, nb, f.data);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);                // signature
        cd.writeUInt16LE(20, 4);                        // version made by
        cd.writeUInt16LE(20, 6);                        // version needed
        cd.writeUInt16LE(0, 8);
        cd.writeUInt16LE(0, 10);
        cd.writeUInt16LE(0, 12);
        cd.writeUInt16LE(0x21, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(f.data.length, 20);
        cd.writeUInt32LE(f.data.length, 24);
        cd.writeUInt16LE(nb.length, 28);
        cd.writeUInt16LE(0, 30);
        cd.writeUInt16LE(0, 32);
        cd.writeUInt16LE(0, 34);
        cd.writeUInt16LE(0, 36);
        cd.writeUInt32LE(offset, 42);                   // local header offset
        centralDir.push(cd, nb);
        offset += 30 + nb.length + f.data.length;
    });

    const cdStart = zip.reduce((acc, b) => acc + b.length, 0);
    const cdData = Buffer.concat(centralDir);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);                // total entries disk
    eocd.writeUInt16LE(files.length, 10);               // total entries
    eocd.writeUInt32LE(cdData.length, 12);              // central dir size
    eocd.writeUInt32LE(cdStart, 16);                    // central dir offset
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...zip, cdData, eocd]);
}

// Handle 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint tidak ditemukan' });
});

// Start server
if (tiktokService.EXTRACTOR_MODE === 'tikwm') {
    console.log('\n✅ Mode EXTRACTOR=tikwm aktif — download lewat TikWM (tanpa yt-dlp).');
    console.log('   Cocok untuk hosting Linux / Render tanpa binary yt-dlp.\n');
} else if (!tiktokService.checkYtDlp()) {
    console.warn('\n⚠️  yt-dlp tidak ditemukan di ' + tiktokService.YTDLP_PATH);
    console.warn('Masih bisa berjalan (mode auto akan fallback ke TikWM), tapi untuk hasil terbaik:');
    console.warn('- Windows: letakkan yt-dlp.exe di folder backend/bin/');
    console.warn('- Linux:   install via pip (pip install yt-dlp)');
    console.warn('Atau set EXTRACTOR=tikwm untuk memakai TikWM sepenuhnya.\n');
}
app.listen(PORT, HOST, () => {
    console.log(`\n🚀 MyTTDownloader API berjalan di:`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   API Info:   http://localhost:${PORT}/api/info?url=<TIKTOK_URL>`);
    console.log(`   API Download: http://localhost:${PORT}/api/video?url=<TIKTOK_URL>`);
    console.log('\nContoh: http://localhost:3000/api/info?url=https://vm.tiktok.com/xxxxxx/\n');
});
