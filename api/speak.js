// Função serverless que converte texto em áudio (voz) usando o Google Cloud Text-to-Speech.
// A chave fica guardada como variável de ambiente na Vercel:
//   GOOGLE_TTS_API_KEY -> sua chave de API do Google Cloud

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GOOGLE_TTS_API_KEY não configurada no servidor.' });
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Nenhum texto enviado.' });
  }

  // Limite de segurança para controlar custo/tempo por chamada
  const safeText = text.slice(0, 1500);

  try {
    const googleRes = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: safeText },
        voice: {
          languageCode: 'pt-BR',
          name: 'pt-BR-Neural2-A' // voz feminina neural, natural, em português do Brasil
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 0.96,
          pitch: 0
        }
      })
    });

    const data = await googleRes.json();

    if (!googleRes.ok) {
      console.error('Erro do Google TTS:', data);
      return res.status(googleRes.status).json({ error: 'Erro ao gerar áudio.', debug: data?.error?.message });
    }

    const audioBuffer = Buffer.from(data.audioContent, 'base64');
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.status(200).send(audioBuffer);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro interno ao gerar a fala.' });
  }
};
