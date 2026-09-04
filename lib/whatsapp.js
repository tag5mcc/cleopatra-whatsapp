// WhatsApp Cloud API (Meta) — envio, recebimento de mídia e janela de 24h.
// Integração oficial. Nada de automação de WhatsApp Web.

const crypto = require('crypto');
const { db } = require('./db');

const GRAPH = 'https://graph.facebook.com/v21.0';

function config() {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    throw new Error('WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID precisam estar configuradas.');
  }
  return { token, phoneId };
}

/**
 * Valida a assinatura do webhook da Meta. Sem isso, qualquer um pode
 * postar mensagens falsas no seu endpoint.
 */
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    console.error('META_APP_SECRET não configurado — assinatura não verificada.');
    return false;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function graph(path, options = {}) {
  const { token } = config();
  const res = await fetch(`${GRAPH}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Erro da Graph API (${res.status})`);
    err.status = res.status;
    err.detail = data?.error;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------
// ENVIO
// ---------------------------------------------------------------------

async function sendText(waId, text, { userId } = {}) {
  const { phoneId } = config();
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: waId,
    type: 'text',
    text: { preview_url: false, body: text.slice(0, 4000) }
  };

  const data = await graph(`${phoneId}/messages`, { method: 'POST', body: JSON.stringify(body) });

  await db().from('whatsapp_messages').insert({
    user_id: userId || null,
    direction: 'outbound',
    wa_message_id: data?.messages?.[0]?.id || null,
    status: 'sent',
    conversation_category: 'service',
    payload: { text }
  }).then(() => {}, () => {});

  return data;
}

/** Divide a resposta em bolhas separadas (a IA marca com --- em linha própria). */
async function sendBubbles(waId, text, { userId } = {}) {
  const parts = String(text).split(/\n\s*---\s*\n/).map((p) => p.trim()).filter(Boolean).slice(0, 3);
  const results = [];
  for (const part of parts.length ? parts : [text]) {
    results.push(await sendText(waId, part, { userId }));
    if (parts.length > 1) await new Promise((r) => setTimeout(r, 900)); // ritmo humano
  }
  return results;
}

/** Botões de resposta rápida — usados no consentimento e na assinatura. */
async function sendButtons(waId, bodyText, buttons, { userId } = {}) {
  const { phoneId } = config();
  const body = {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText.slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, 20) }
        }))
      }
    }
  };
  const data = await graph(`${phoneId}/messages`, { method: 'POST', body: JSON.stringify(body) });
  await db().from('whatsapp_messages').insert({
    user_id: userId || null, direction: 'outbound',
    wa_message_id: data?.messages?.[0]?.id || null,
    status: 'sent', conversation_category: 'service', payload: body.interactive
  }).then(() => {}, () => {});
  return data;
}

/**
 * Template aprovado — obrigatório fora da janela de 24h.
 */
async function sendTemplate(waId, templateName, variables = [], { userId, language = 'pt_BR' } = {}) {
  const { phoneId } = config();
  const body = {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      components: variables.length
        ? [{ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: String(v) })) }]
        : []
    }
  };

  const data = await graph(`${phoneId}/messages`, { method: 'POST', body: JSON.stringify(body) });

  await db().from('whatsapp_messages').insert({
    user_id: userId || null,
    direction: 'outbound',
    wa_message_id: data?.messages?.[0]?.id || null,
    status: 'sent',
    template_name: templateName,
    conversation_category: 'utility',
    payload: body.template
  }).then(() => {}, () => {});

  return data;
}

async function markAsRead(waMessageId) {
  const { phoneId } = config();
  try {
    await graph(`${phoneId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: waMessageId })
    });
  } catch (e) {
    // Marcar como lida é cosmético; nunca deve quebrar o fluxo.
  }
}

// ---------------------------------------------------------------------
// MÍDIA
// ---------------------------------------------------------------------

/** Baixa uma imagem recebida e devolve base64 para a análise de visão. */
async function downloadMedia(mediaId) {
  const { token } = config();
  const meta = await graph(mediaId);
  if (!meta?.url) throw new Error('Mídia sem URL.');

  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Falha ao baixar mídia (${res.status})`);

  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    base64: buffer.toString('base64'),
    mimeType: meta.mime_type || 'image/jpeg',
    sizeBytes: buffer.length
  };
}

// ---------------------------------------------------------------------
// JANELA DE 24H
// ---------------------------------------------------------------------

/** A janela reabre a cada mensagem que ELA envia. */
async function touchWindow(userId, waId, profileName) {
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db().from('whatsapp_contacts').upsert({
    user_id: userId,
    wa_id: waId,
    profile_name: profileName || null,
    window_expires_at: expires,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  return expires;
}

async function isWindowOpen(userId) {
  const { data } = await db().from('whatsapp_contacts')
    .select('window_expires_at').eq('user_id', userId).maybeSingle();
  if (!data?.window_expires_at) return false;
  return new Date(data.window_expires_at) > new Date();
}

module.exports = {
  verifySignature, sendText, sendBubbles, sendButtons, sendTemplate,
  markAsRead, downloadMedia, touchWindow, isWindowOpen
};
