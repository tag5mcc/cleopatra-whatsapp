// CleopatraEngine — o ciclo completo de uma mensagem recebida.
//
//   loadUser → consentimento → controle de acesso → intenção
//   → memória relevante → resposta → extração → envio
//
// Tudo que o webhook faz é enfileirar. Quem pensa é este arquivo.

const { db, getSetting } = require('./db');
const wa = require('./whatsapp');
const { buildSystemPrompt } = require('./persona');
const { generateResponse } = require('./aiProvider');
const { loadRelevantMemories, buildMemoryBlock, extractAndSave } = require('./memory');
const { getCheckoutLink } = require('./checkout');

const today = () =>
  new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD

// ---------------------------------------------------------------------
// USUÁRIA
// ---------------------------------------------------------------------

async function loadUser(waId, profileName) {
  const supabase = db();

  const { data: existing } = await supabase.from('users')
    .select('*').eq('wa_id', waId).maybeSingle();

  if (existing) {
    await supabase.from('users')
      .update({ last_seen_at: new Date().toISOString() }).eq('id', existing.id);
    return { user: existing, isNew: false };
  }

  // O wa_id pode ser um telefone ou um BSUID (quando a usuária adota nome de
  // usuário no WhatsApp). Só tratamos como telefone o que parece um.
  const isPhone = /^\d{10,15}$/.test(String(waId));

  const { data: created, error } = await supabase.from('users').insert({
    phone_e164: isPhone ? `+${waId}` : null,
    wa_id: waId,
    wa_id_type: isPhone ? 'phone' : 'bsuid',
    name: profileName || null,
    last_seen_at: new Date().toISOString()
  }).select().single();

  if (error) throw new Error(`Falha ao criar usuária: ${error.message}`);

  await supabase.from('profiles').insert({ user_id: created.id }).then(() => {}, () => {});
  await supabase.from('conversations').insert({ user_id: created.id }).then(() => {}, () => {});

  return { user: created, isNew: true };
}

async function getConversation(userId) {
  const supabase = db();
  const { data } = await supabase.from('conversations')
    .select('id').eq('user_id', userId)
    .order('last_message_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
  if (data) return data.id;
  const { data: created } = await supabase.from('conversations')
    .insert({ user_id: userId }).select('id').single();
  return created.id;
}

async function hasConsent(userId, type) {
  const { data } = await db().from('privacy_consents')
    .select('granted').eq('user_id', userId).eq('consent_type', type)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data?.granted === true;
}

async function saveConsent(userId, type, granted) {
  await db().from('privacy_consents').insert({
    user_id: userId,
    consent_type: type,
    granted,
    source: 'whatsapp',
    granted_at: granted ? new Date().toISOString() : null,
    revoked_at: granted ? null : new Date().toISOString()
  });
}

// ---------------------------------------------------------------------
// ACESSO
// ---------------------------------------------------------------------

async function checkAccess(user) {
  const supabase = db();

  const { data: sub } = await supabase.from('subscriptions')
    .select('status, current_period_end').eq('user_id', user.id).eq('status', 'active')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();

  if (sub) {
    const valid = !sub.current_period_end || new Date(sub.current_period_end) > new Date();
    if (valid) return { allowed: true, subscriber: true, nearLimit: false };
  }

  const limit = Number(await getSetting('free_message_limit', 12));
  const warnAt = Number(await getSetting('free_warning_at', Math.max(1, limit - 3)));
  const used = user.free_messages_used || 0;

  return {
    allowed: used < limit,
    subscriber: false,
    nearLimit: used >= warnAt,
    used,
    limit
  };
}

async function sendPaywall(user) {
  // Link individual: a referência volta no webhook e identifica quem pagou,
  // sem depender do e-mail ou telefone que ela digitar no checkout.
  const checkout = await getCheckoutLink(user.id);

  const nome = user.name ? user.name.split(' ')[0] : 'querida';
  const preco = checkout?.plan
    ? (checkout.plan.price_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : null;

  await wa.sendText(user.wa_id,
    `Quero continuar acompanhando essa história com você, ${nome}.\n\n` +
    `Para eu seguir lembrando de tudo e estar aqui quando você precisar, é só ativar seu acesso` +
    `${preco ? ` — ${preco}` : ''}:\n\n${checkout?.url || 'https://cleopatra.com.br/assinar'}\n\n` +
    `Assim que confirmar, eu continuo exatamente de onde paramos.`,
    { userId: user.id });
}

// ---------------------------------------------------------------------
// INTENÇÃO
// ---------------------------------------------------------------------

function detectIntent(text, hasImage) {
  if (hasImage) return 'analise_conversa';
  const t = (text || '').toLowerCase();

  if (/\b(me ajuda a responder|como (eu )?respondo|o que (eu )?respondo|me ajuda com a resposta)\b/.test(t))
    return 'ajudar_responder';
  if (/\b(vou mandar|posso mandar|ia mandar|antes de (eu )?enviar|escrevi isso|o que acha dessa mensagem)\b/.test(t))
    return 'antes_de_enviar';
  if (/\b(ele mandou|ela mandou|ele me mandou|olha o que ele|recebi essa|o que ele quis dizer|decifra)\b/.test(t))
    return 'decifrar';
  if (/\b(plano|o que eu faço agora|me d[aá] um caminho|passo a passo)\b/.test(t))
    return 'plano';
  return null;
}

// ---------------------------------------------------------------------
// COMANDOS
// ---------------------------------------------------------------------

async function handleCommand(user, text) {
  const t = (text || '').trim().toLowerCase();

  if (t === 'parar' || t === 'sair' || t === 'cancelar' || t === 'stop') {
    await db().from('whatsapp_contacts')
      .update({ opt_in: false, opt_out_at: new Date().toISOString() }).eq('user_id', user.id);
    await saveConsent(user.id, 'followup', false);
    await db().from('reminders')
      .update({ status: 'cancelled' }).eq('user_id', user.id).eq('status', 'pending');
    await wa.sendText(user.wa_id,
      'Pronto. Não vou mais te procurar.\n\nSe um dia quiser voltar, é só me mandar uma mensagem — eu vou estar aqui, com sua história.',
      { userId: user.id });
    return true;
  }

  if (t === '/privacidade' || t === 'privacidade') {
    await wa.sendText(user.wa_id,
      'Suas conversas são suas.\n\nEu guardo o que importa da sua história para poder lembrar quando você voltar. Você pode apagar tudo a qualquer momento escrevendo *apagar memória*, ou excluir sua conta com *excluir conta*.\n\nDetalhes: https://cleopatra.com.br/privacidade',
      { userId: user.id });
    return true;
  }

  if (/^(apagar mem[óo]ria|esquece tudo|apague minha mem[óo]ria)$/.test(t)) {
    const supabase = db();
    await Promise.all([
      supabase.from('memories').delete().eq('user_id', user.id),
      supabase.from('events').delete().eq('user_id', user.id),
      supabase.from('people').delete().eq('user_id', user.id),
      supabase.from('profiles').update({ summary: null, concerns: [], goals: [] }).eq('user_id', user.id)
    ]);
    await supabase.from('audit_log').insert({ actor: 'user', action: 'memory_wiped', user_id: user.id });
    await wa.sendText(user.wa_id,
      'Apaguei tudo que eu lembrava da sua história.\n\nSe quiser recomeçar, estou aqui.',
      { userId: user.id });
    return true;
  }

  if (/^(excluir conta|deletar conta|apagar meus dados)$/.test(t)) {
    await wa.sendButtons(user.wa_id,
      'Isso apaga tudo: sua história, nossas conversas e seus dados. Não tem como voltar atrás.\n\nVocê confirma?',
      [{ id: 'delete_yes', title: 'Sim, excluir' }, { id: 'delete_no', title: 'Não, cancelar' }],
      { userId: user.id });
    return true;
  }

  return false;
}

async function handleButton(user, buttonId) {
  const supabase = db();

  if (buttonId === 'consent_memory_yes') {
    await saveConsent(user.id, 'memory', true);
    await supabase.from('users').update({ onboarding_stage: 'in_progress' }).eq('id', user.id);
    await wa.sendButtons(user.wa_id,
      'Obrigada. Mais uma coisa: posso te mandar lembretes e voltar a falar com você para saber como as coisas ficaram?',
      [{ id: 'consent_followup_yes', title: 'Pode sim' }, { id: 'consent_followup_no', title: 'Prefiro não' }],
      { userId: user.id });
    return true;
  }

  if (buttonId === 'consent_memory_no') {
    await saveConsent(user.id, 'memory', false);
    await supabase.from('users').update({ onboarding_stage: 'in_progress' }).eq('id', user.id);
    await wa.sendText(user.wa_id,
      'Tudo bem. Então cada conversa nossa começa do zero — e eu vou precisar que você me situe de novo quando voltar.\n\nMe conta: o que está acontecendo?',
      { userId: user.id });
    return true;
  }

  if (buttonId === 'consent_followup_yes' || buttonId === 'consent_followup_no') {
    const yes = buttonId.endsWith('_yes');
    await saveConsent(user.id, 'followup', yes);
    await supabase.from('whatsapp_contacts')
      .update({ opt_in: yes, opt_in_at: yes ? new Date().toISOString() : null })
      .eq('user_id', user.id);
    await wa.sendText(user.wa_id,
      (yes ? 'Combinado.' : 'Entendido, só falo quando você me procurar.') +
      '\n\nAgora me conta. Como você gosta de ser chamada?',
      { userId: user.id });
    return true;
  }

  if (buttonId === 'delete_yes') {
    await supabase.from('audit_log').insert({ actor: 'user', action: 'account_deleted', user_id: user.id });
    await wa.sendText(user.wa_id, 'Feito. Apaguei tudo. Cuide-se.', { userId: user.id });
    await supabase.from('users').delete().eq('id', user.id); // cascade limpa o resto
    return true;
  }

  if (buttonId === 'delete_no') {
    await wa.sendText(user.wa_id, 'Que bom. Continuo aqui.', { userId: user.id });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------
// HISTÓRICO
// ---------------------------------------------------------------------

async function loadRecentConversation(userId, limit) {
  const { data } = await db().from('messages')
    .select('role, content')
    .eq('user_id', userId).in('role', ['user', 'assistant'])
    .not('content', 'is', null)
    .order('created_at', { ascending: false }).limit(limit);

  return (data || []).reverse().map((m) => ({ role: m.role, content: m.content }));
}

// ---------------------------------------------------------------------
// CICLO PRINCIPAL
// ---------------------------------------------------------------------

/**
 * @param {object} incoming  { waId, profileName, text, waMessageId, mediaId, buttonId }
 */
async function receiveMessage(incoming) {
  const supabase = db();
  const { waId, profileName, text, waMessageId, mediaId, buttonId } = incoming;

  const { user, isNew } = await loadUser(waId, profileName);
  await wa.touchWindow(user.id, waId, profileName);
  if (waMessageId) wa.markAsRead(waMessageId);

  // Botão de resposta rápida
  if (buttonId) {
    const handled = await handleButton(user, buttonId);
    if (handled) return { status: 'button' };
  }

  // Comandos de privacidade e opt-out têm prioridade sobre tudo
  if (text && await handleCommand(user, text)) return { status: 'command' };

  // Primeira mensagem: consentimento antes de qualquer memória
  if (isNew || !(await hasConsent(user.id, 'memory'))) {
    const alreadyAsked = await supabase.from('privacy_consents')
      .select('id', { count: 'exact', head: true }).eq('user_id', user.id);
    if (!alreadyAsked.count) {
      await wa.sendText(user.wa_id,
        'Oi. Eu sou a Cleópatra.\n\nAntes de começarmos, uma pergunta rápida.',
        { userId: user.id });
      await wa.sendButtons(user.wa_id,
        'Posso guardar os pontos importantes das nossas conversas, para lembrar da sua história quando você voltar?',
        [{ id: 'consent_memory_yes', title: 'Pode guardar' }, { id: 'consent_memory_no', title: 'Prefiro não' }],
        { userId: user.id });
      return { status: 'consent_requested' };
    }
  }

  const conversationId = await getConversation(user.id);

  // Controle de acesso
  const access = await checkAccess(user);
  if (!access.allowed) {
    await sendPaywall(user);
    return { status: 'paywalled' };
  }

  // Grava a mensagem dela
  const { data: savedMsg } = await supabase.from('messages').insert({
    user_id: user.id,
    conversation_id: conversationId,
    role: 'user',
    content: text || (mediaId ? '(enviou uma imagem)' : ''),
    media_type: mediaId ? 'image' : null,
    wa_message_id: waMessageId || null,
    status: 'received'
  }).select('id').maybeSingle();

  // Imagem: baixa e prepara para visão
  let imageBlock = null;
  if (mediaId) {
    try {
      const media = await wa.downloadMedia(mediaId);
      if (media.sizeBytes < 4_500_000) {
        imageBlock = { type: 'image', source: { type: 'base64', media_type: media.mimeType, data: media.base64 } };
      }
    } catch (e) {
      console.error('Falha ao baixar mídia:', e.message);
    }
  }

  const intent = detectIntent(text, !!imageBlock);
  if (intent && savedMsg) {
    await supabase.from('messages').update({ intent }).eq('id', savedMsg.id);
  }

  // Memória relevante
  const memoryConsent = await hasConsent(user.id, 'memory');
  let memoryBlock = '';
  if (memoryConsent) {
    const mem = await loadRelevantMemories(user.id, text || '');
    memoryBlock = buildMemoryBlock(mem, today());
  }

  // Histórico recente
  const historyWindow = Number(await getSetting('history_window', 16));
  const history = await loadRecentConversation(user.id, historyWindow);

  const currentContent = imageBlock
    ? [imageBlock, { type: 'text', text: text || 'Olha essa conversa.' }]
    : (text || '');

  const messages = [...history.slice(0, -1), { role: 'user', content: currentContent }];
  if (!messages.length) messages.push({ role: 'user', content: currentContent });

  const system = buildSystemPrompt({
    mode: intent,
    memoryBlock,
    onboarding: user.onboarding_stage !== 'done',
    nearLimit: access.nearLimit && !access.subscriber,
    userName: user.name
  });

  // Resposta
  const reply = await generateResponse({
    system,
    messages,
    userId: user.id,
    conversationId,
    maxTokens: intent ? 900 : 700
  });

  await wa.sendBubbles(user.wa_id, reply, { userId: user.id });

  await supabase.from('messages').insert({
    user_id: user.id,
    conversation_id: conversationId,
    role: 'assistant',
    content: reply,
    intent,
    status: 'sent'
  });

  await supabase.from('conversations')
    .update({ last_message_at: new Date().toISOString() }).eq('id', conversationId);

  if (!access.subscriber) {
    await supabase.from('users')
      .update({ free_messages_used: (user.free_messages_used || 0) + 1 }).eq('id', user.id);
  }

  // Extração de memória — depois de responder, nunca antes
  if (memoryConsent) {
    try {
      await extractAndSave({
        userId: user.id,
        userText: text || '(imagem)',
        assistantText: reply,
        today: today(),
        messageId: savedMsg?.id
      });
    } catch (e) {
      console.error('Falha na extração de memória (não crítico):', e.message);
    }
  }

  // Onboarding termina quando ela já tem nome e alguém na história
  if (user.onboarding_stage !== 'done') {
    const { count } = await supabase.from('people')
      .select('id', { count: 'exact', head: true }).eq('user_id', user.id);
    const { data: fresh } = await supabase.from('users').select('name').eq('id', user.id).maybeSingle();
    if (fresh?.name && (count || 0) > 0) {
      await supabase.from('users').update({ onboarding_stage: 'done' }).eq('id', user.id);
    }
  }

  return { status: 'replied', intent };
}

module.exports = { receiveMessage, loadUser, checkAccess, detectIntent, today };
