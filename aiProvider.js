// Camada de IA. Nada no resto do sistema conhece a Anthropic diretamente:
// tudo passa por generateResponse() e extractStructured().
// Trocar de modelo (ou de fornecedor) acontece aqui e em app_settings.

const { db, getSetting } = require('./db');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

async function callAnthropic({ model, system, messages, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada.');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages })
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || 'Erro na chamada de IA.');
    err.status = res.status;
    throw err;
  }

  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return {
    text,
    usage: {
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0
    },
    model
  };
}

// Registra consumo para o painel de custos. Nunca derruba o fluxo.
async function logUsage({ userId, conversationId, purpose, model, usage, waType, waCost }) {
  try {
    const priceIn = Number(await getSetting('ai_price_input', 0.000003));
    const priceOut = Number(await getSetting('ai_price_output', 0.000015));
    const cost = usage.input_tokens * priceIn + usage.output_tokens * priceOut;

    await db().from('ai_usage').insert({
      user_id: userId || null,
      conversation_id: conversationId || null,
      purpose,
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      estimated_ai_cost: cost.toFixed(6),
      whatsapp_message_type: waType || null,
      estimated_whatsapp_cost: waCost || 0
    });
  } catch (e) {
    console.error('Falha ao registrar uso de IA (não crítico):', e.message);
  }
}

/**
 * Resposta da Cleópatra na conversa.
 */
async function generateResponse({ system, messages, userId, conversationId, maxTokens = 700 }) {
  const model = await getSetting('ai_model', 'claude-sonnet-5');
  const result = await callAnthropic({ model, system, messages, maxTokens });
  await logUsage({ userId, conversationId, purpose: 'reply', model, usage: result.usage });
  return result.text;
}

/**
 * Extração estruturada (memória, intenção). Usa modelo mais barato e
 * devolve objeto já parseado — ou null se o modelo não entregar JSON válido.
 */
async function extractStructured({ system, userMessage, userId, maxTokens = 800 }) {
  const model = await getSetting('ai_model_extraction', 'claude-haiku-4-5-20251001');
  const result = await callAnthropic({
    model,
    system,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens
  });
  await logUsage({ userId, purpose: 'extract', model, usage: result.usage });

  const match = result.text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('Extração devolveu JSON inválido:', result.text.slice(0, 300));
    return null;
  }
}

module.exports = { generateResponse, extractStructured, logUsage };
