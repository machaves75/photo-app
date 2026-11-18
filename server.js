require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3006;
const BACKUP_DIR = path.join(__dirname, 'backups');

// Garante que a pasta de backups exista
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Aumenta o limite do body para receber backups grandes
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Salvar backup no servidor (opcional, além do download local)
app.post('/api/backup', (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !Array.isArray(payload.photos)) {
      return res.status(400).json({ error: 'Payload inválido. Esperado { photos: [...] }' });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `backup-${stamp}.json`;
    const filePath = path.join(BACKUP_DIR, fileName);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    res.json({ ok: true, file: fileName, count: payload.photos.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Falha ao salvar backup no servidor.' });
  }
});

// Listar backups existentes
app.get('/api/backups', (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao listar backups.' });
  }
});

// Baixar um backup específico
app.get('/api/backups/:name', (req, res) => {
  const safeName = path.basename(req.params.name);
  const filePath = path.join(BACKUP_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Não encontrado' });
  res.download(filePath);
});

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
  console.log(`📸 Para testar no celular, use HTTPS ou ngrok (getUserMedia exige contexto seguro).`);
});