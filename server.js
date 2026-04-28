const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 500 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

const IMGBB_KEY = process.env.IMGBB_KEY || '7d5f38e0ab86c1663f6c2c296a66a13e';
const META_BASE = 'https://graph.facebook.com/v21.0'; // ✅ Versão atualizada

// Health check
app.get('/', (req, res) => res.json({ status: 'InstaMatrix Backend online ✅' }));

function isVideo(mimetype, originalname) {
  if (mimetype && mimetype.startsWith('video/')) return true;
  if (originalname && originalname.match(/\.(mp4|mov|avi|mkv|webm)$/i)) return true;
  return false;
}

// Upload: imagem vai pro ImgBB, vídeo fica no servidor temporariamente
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const fileIsVideo = isVideo(req.file.mimetype, req.file.originalname);

    if (fileIsVideo) {
      res.json({ localPath: req.file.path, isVideo: true, filename: req.file.filename });
    } else {
      const fileBuffer = fs.readFileSync(req.file.path);
      const base64 = fileBuffer.toString('base64');
      const fd = new FormData();
      fd.append('image', base64);
      const imgbbRes = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_KEY}`, { method: 'POST', body: fd });
      const imgbbData = await imgbbRes.json();
      fs.unlinkSync(req.file.path);
      if (!imgbbData.success) return res.status(500).json({ error: 'Falha no upload para ImgBB' });
      res.json({ url: imgbbData.data.url, isVideo: false });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Publicar no Instagram (Feed, Story, Reels)
app.post('/publish', upload.single('videoFile'), async (req, res) => {
  try {
    const { igid, token, mediaUrl, caption, type, storyLink, localPath } = req.body;

    if (!igid || !token) return res.status(400).json({ error: 'igid e token são obrigatórios' });

    const containerParams = new URLSearchParams();
    containerParams.append('access_token', token);

    let videoLocalPath = localPath || (req.file ? req.file.path : null);
    let publicVideoUrl = null;

    if (videoLocalPath && fs.existsSync(videoLocalPath)) {
      publicVideoUrl = await uploadVideoToMeta(igid, token, videoLocalPath);
    }

    if (type === 'reel') {
      containerParams.append('media_type', 'REELS');
      containerParams.append('video_url', publicVideoUrl || mediaUrl);
      containerParams.append('caption', caption || '');
    } else if (type === 'story') {
      containerParams.append('media_type', 'STORIES');
      if (publicVideoUrl) {
        containerParams.append('video_url', publicVideoUrl);
      } else {
        containerParams.append('image_url', mediaUrl);
      }
      if (storyLink) containerParams.append('story_sticker_link', storyLink);
    } else {
      containerParams.append('image_url', mediaUrl);
      containerParams.append('caption', caption || '');
    }

    const containerRes = await fetch(`${META_BASE}/${igid}/media`, { method: 'POST', body: containerParams });
    const containerData = await containerRes.json();
    if (containerData.error) return res.status(400).json({ error: containerData.error.message });

    if (type === 'reel' || (type === 'story' && publicVideoUrl)) {
      await waitForVideoReady(token, containerData.id);
    }

    const publishParams = new URLSearchParams();
    publishParams.append('creation_id', containerData.id);
    publishParams.append('access_token', token);
    const publishRes = await fetch(`${META_BASE}/${igid}/media_publish`, { method: 'POST', body: publishParams });
    const publishData = await publishRes.json();
    if (publishData.error) return res.status(400).json({ error: publishData.error.message });

    if (videoLocalPath && fs.existsSync(videoLocalPath)) fs.unlinkSync(videoLocalPath);

    res.json({ success: true, id: publishData.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function uploadVideoToMeta(igid, token, localPath) {
  const fileBuffer = fs.readFileSync(localPath);
  const fileSize = fileBuffer.length;

  const initRes = await fetch(`https://rupload.facebook.com/video-upload/v21.0/${igid}/videos`, {
    method: 'POST',
    headers: {
      'Authorization': `OAuth ${token}`,
      'X-FB-Video-File-Chunk': '0',
      'X-FB-Video-File-Length': String(fileSize),
      'X-FB-Video-Name': 'upload.mp4',
      'Content-Type': 'application/octet-stream',
    },
    body: fileBuffer,
  });
  const initData = await initRes.json();
  if (initData.error) throw new Error('Erro no upload do vídeo: ' + initData.error.message);
  return `https://rupload.facebook.com/video-upload/v21.0/${igid}/videos/${initData.h}`;
}

async function waitForVideoReady(token, containerId, attempts = 24) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await fetch(`${META_BASE}/${containerId}?fields=status_code&access_token=${token}`);
    const statusData = await statusRes.json();
    if (statusData.status_code === 'FINISHED') return;
    if (statusData.status_code === 'ERROR') throw new Error('Erro no processamento do vídeo pela Meta');
  }
  throw new Error('Timeout ao processar vídeo');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`InstaMatrix Backend rodando na porta ${PORT}`));
