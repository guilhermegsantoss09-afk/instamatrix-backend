const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

const IMGBB_KEY = process.env.IMGBB_KEY || '7d5f38e0ab86c1663f6c2c296a66a13e';
const META_BASE = 'https://graph.facebook.com/v19.0';

// Health check
app.get('/', (req, res) => res.json({ status: 'InstaMatrix Backend online ✅' }));

// Upload de mídia para ImgBB e retorna URL pública
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const fileBuffer = fs.readFileSync(req.file.path);
    const base64 = fileBuffer.toString('base64');

    const fd = new FormData();
    fd.append('image', base64);

    const imgbbRes = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_KEY}`, {
      method: 'POST',
      body: fd,
    });
    const imgbbData = await imgbbRes.json();
    fs.unlinkSync(req.file.path); // limpa arquivo temporário

    if (!imgbbData.success) {
      return res.status(500).json({ error: 'Falha no upload para ImgBB', detail: imgbbData });
    }

    res.json({ url: imgbbData.data.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Publicar no Instagram (Feed, Story, Reels)
app.post('/publish', async (req, res) => {
  const { igid, token, mediaUrl, caption, type, storyLink } = req.body;

  if (!igid || !token || !mediaUrl) {
    return res.status(400).json({ error: 'igid, token e mediaUrl são obrigatórios' });
  }

  try {
    // 1. Criar container de mídia
    const containerParams = new URLSearchParams();
    containerParams.append('access_token', token);

    if (type === 'reel') {
      containerParams.append('media_type', 'REELS');
      containerParams.append('video_url', mediaUrl);
      containerParams.append('caption', caption || '');
    } else if (type === 'story') {
      containerParams.append('media_type', 'STORIES');
      // Detecta se é vídeo pelo content-type ou extensão
      if (mediaUrl.match(/\.(mp4|mov|avi|mkv)/i)) {
        containerParams.append('video_url', mediaUrl);
      } else {
        containerParams.append('image_url', mediaUrl);
      }
      if (storyLink) containerParams.append('story_sticker_link', storyLink);
    } else {
      // Feed (imagem)
      containerParams.append('image_url', mediaUrl);
      containerParams.append('caption', caption || '');
    }

    const containerRes = await fetch(`${META_BASE}/${igid}/media`, {
      method: 'POST',
      body: containerParams,
    });
    const containerData = await containerRes.json();

    if (containerData.error) {
      return res.status(400).json({ error: containerData.error.message });
    }

    // 2. Aguardar processamento de vídeo
    if (type === 'reel' || (type === 'story' && mediaUrl.match(/\.(mp4|mov|avi|mkv)/i))) {
      await waitForVideoReady(igid, token, containerData.id);
    }

    // 3. Publicar container
    const publishParams = new URLSearchParams();
    publishParams.append('creation_id', containerData.id);
    publishParams.append('access_token', token);

    const publishRes = await fetch(`${META_BASE}/${igid}/media_publish`, {
      method: 'POST',
      body: publishParams,
    });
    const publishData = await publishRes.json();

    if (publishData.error) {
      return res.status(400).json({ error: publishData.error.message });
    }

    res.json({ success: true, id: publishData.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Aguarda vídeo ficar pronto na Meta API
async function waitForVideoReady(igid, token, containerId, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const statusRes = await fetch(
      `${META_BASE}/${containerId}?fields=status_code&access_token=${token}`
    );
    const statusData = await statusRes.json();
    if (statusData.status_code === 'FINISHED') return;
    if (statusData.status_code === 'ERROR') throw new Error('Erro no processamento do vídeo pela Meta');
  }
  throw new Error('Timeout: vídeo demorou demais para processar');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`InstaMatrix Backend rodando na porta ${PORT}`));
