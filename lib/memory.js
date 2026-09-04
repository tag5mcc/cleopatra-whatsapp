// Memória da Cleópatra.
//
// Duas metades:
//   loadRelevantMemories() — monta o contexto que vai para a IA. Recupera só
//     o que interessa para a mensagem atual, nunca o histórico inteiro.
//   extractAndSave() — depois da resposta, olha a troca e atualiza o banco.
//
// A recuperação usa: pessoas citadas na mensagem + busca textual em português
// + recência + decisões em aberto. A tabela memory_embeddings já existe no
// schema para quando a busca semântica entrar (ver README).

const { db, getSetting } = require('./db');
const { extractStructured } = require('./aiProvider');

const norm = (s) =>
  (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// ---------------------------------------------------------------------
// RECUPERAÇÃO
// ---------------------------------------------------------------------

/** Quais das pessoas conhecidas dela aparecem no texto? */
function matchPeople(text, people) {
  const t = norm(text);
  return people.filter((p) => {
    const names = [p.name, ...(p.aliases || [])].filter(Boolean);
    return names.some((n) => {
      const nn = norm(n);
      return nn.length > 2 && new RegExp(`\\b${nn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t);
    });
  });
}

async function loadRelevantMemories(userId, incomingText) {
  const supabase = db();

  const [{ data: profile }, { data: allPeople }] = await Promise.all([
    supabase.from('profiles').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('people').select('*').eq('user_id', userId).order('is_primary', { ascending: false })
  ]);

  const people = allPeople || [];
  let focus = matchPeople(incomingText, people);

  // Ela disse "ele/ela" sem nome: assume a pessoa principal, se houver uma só.
  if (focus.length === 0 && /\b(ele|dele|nele|ela|dela|nela)\b/i.test(incomingText || '')) {
    const primary = people.filter((p) => p.is_primary);
    if (primary.length === 1) focus = primary;
    else if (people.length === 1) focus = people;
  }

  const focusIds = focus.map((p) => p.id);

  // Decisões em aberto — o que dá à Cleópatra o poder de cobrar continuidade.
  const { data: openDecisions } = await supabase
    .from('memories').select('content, result, created_at, person_id')
    .eq('user_id', userId).eq('kind', 'decision').eq('status', 'open')
    .order('created_at', { ascending: false }).limit(5);

  // Padrões percebidos.
  const { data: patterns } = await supabase
    .from('memories').select('content')
    .eq('user_id', userId).eq('kind', 'pattern')
    .order('created_at', { ascending: false }).limit(4);

  // Fatos: prioriza os das pessoas citadas; completa com os mais recentes.
  let facts = [];
  if (focusIds.length) {
    const { data } = await supabase
      .from('memories').select('content, person_id')
      .eq('user_id', userId).eq('kind', 'fact').in('person_id', focusIds)
      .order('created_at', { ascending: false }).limit(8);
    facts = data || [];
  }
  if (facts.length < 5) {
    const { data } = await supabase
      .from('memories').select('content, person_id')
      .eq('user_id', userId).eq('kind', 'fact')
      .order('created_at', { ascending: false }).limit(6);
    const seen = new Set(facts.map((f) => f.content));
    facts = facts.concat((data || []).filter((f) => !seen.has(f.content))).slice(0, 8);
  }

  // Busca textual pelo assunto da mensagem, para pescar memória antiga relevante.
  const query = (incomingText || '').split(/\s+/).filter((w) => w.length > 4).slice(0, 6).join(' | ');
  let searched = [];
  if (query) {
    const { data } = await supabase
      .from('memories').select('content, kind')
      .eq('user_id', userId)
      .textSearch('search_tsv', query, { config: 'pt_unaccent' })
      .limit(4);
    searched = data || [];
  }

  // Eventos recentes.
  let eventsQ = supabase.from('events')
    .select('occurred_on, description, person_id')
    .eq('user_id', userId).eq('hidden', false)
    .order('occurred_on', { ascending: false }).limit(8);
  if (focusIds.length) eventsQ = eventsQ.in('person_id', focusIds);
  const { data: events } = await eventsQ;

  return {
    profile: profile || null,
    people,
    focusPeople: focus,
    facts,
    openDecisions: openDecisions || [],
    patterns: patterns || [],
    searched,
    events: events || []
  };
}

/** Transforma o resultado acima no bloco de texto que a IA lê. */
function buildMemoryBlock(mem, today) {
  if (!mem) return '';
  const L = [];
  L.push('=== O QUE VOCÊ SABE SOBRE ELA (uso interno — nunca mencione que isto é uma memória) ===');
  L.push(`Hoje é ${today}.`);

  if (mem.profile) {
    const p = mem.profile;
    if (p.summary) L.push(`História até aqui: ${p.summary}`);
    if (p.relationship_status) L.push(`Situação amorosa: ${p.relationship_status}`);
    if (p.goals?.length) L.push(`Objetivos dela: ${p.goals.join('; ')}`);
    if (p.concerns?.length) L.push(`Preocupações: ${p.concerns.join('; ')}`);
    if (p.boundaries?.length) L.push(`Limites: ${p.boundaries.join('; ')}`);
    if (p.communication_style) L.push(`Estilo de comunicação dela: ${p.communication_style}`);
  }

  if (mem.people?.length) {
    L.push('\nPESSOAS DA VIDA DELA:');
    for (const p of mem.people.slice(0, 6)) {
      const bits = [p.relation, p.status, p.since_label && `há ${p.since_label}`].filter(Boolean);
      L.push(`- ${p.name}${bits.length ? ` (${bits.join(', ')})` : ''}${p.last_event ? `. Último acontecimento: ${p.last_event}` : ''}${p.user_goal ? `. Ela quer: ${p.user_goal}` : ''}`);
    }
  }

  if (mem.focusPeople?.length) {
    L.push(`\nA conversa agora parece ser sobre: ${mem.focusPeople.map((p) => p.name).join(', ')}.`);
  } else if (mem.people?.length > 1) {
    L.push('\nAtenção: ela tem mais de uma pessoa importante na história e não ficou claro sobre quem ela fala agora. Se for ambíguo, pergunte de quem se trata antes de responder — isso é natural e não quebra a conversa.');
  }

  if (mem.facts?.length) {
    L.push('\nFATOS:');
    mem.facts.forEach((f) => L.push(`- ${f.content}`));
  }

  if (mem.openDecisions?.length) {
    L.push('\nDECISÕES EM ABERTO (cobre continuidade quando fizer sentido):');
    mem.openDecisions.forEach((d) => L.push(`- ${d.content}${d.result ? ` → ${d.result}` : ''}`));
  }

  if (mem.patterns?.length) {
    L.push('\nPADRÕES QUE VOCÊ PERCEBEU (nunca apresente como diagnóstico):');
    mem.patterns.forEach((p) => L.push(`- ${p.content}`));
  }

  if (mem.events?.length) {
    L.push('\nO QUE FOI ACONTECENDO:');
    mem.events.forEach((e) => L.push(`- ${e.occurred_on}: ${e.description}`));
  }

  if (mem.searched?.length) {
    L.push('\nOUTRAS COISAS QUE ELA JÁ CONTOU E PODEM SE RELACIONAR:');
    mem.searched.forEach((s) => L.push(`- ${s.content}`));
  }

  L.push('\nUse isto como quem lembra de verdade: puxe um fio só, o relevante para agora. Nunca liste o que sabe.');
  return L.join('\n');
}

// ---------------------------------------------------------------------
// EXTRAÇÃO
// ---------------------------------------------------------------------

const EXTRACTION_SYSTEM = (today) => `Você é um extrator silencioso de memória. Leia a última troca entre a usuária e a mentora e devolve APENAS o que for informação nova e concreta. Hoje é ${today}.

Responda SOMENTE com JSON puro, sem markdown, sem texto antes ou depois:

{
  "user_name": null ou "primeiro nome dela, se ela disse agora",
  "relationship_status": null ou "solteira/namorando/casada/complicado/etc, se ficou claro agora",
  "profile_summary": null ou "resumo de 1 a 2 frases da situação geral dela",
  "people": [{"name":"Nome","relation":"namorado/ex/ficante/amiga/etc","status":"situação atual","since_label":null ou "1 ano","last_event":null ou "o que aconteceu por último","user_goal":null ou "o que ela quer com isso"}],
  "facts": [{"person":null ou "Nome","content":"fato curto e concreto"}],
  "decisions": [{"person":null ou "Nome","content":"o que ela decidiu fazer","result":null}],
  "decisions_resolved": [{"content":"decisão anterior que agora teve desfecho","result":"o que aconteceu"}],
  "patterns": ["padrão comportamental percebido, curto"],
  "events": [{"person":null ou "Nome","date":"YYYY-MM-DD","description":"acontecimento curto e datável"}],
  "followup": null ou {"subject":"assunto para retomar depois","due":"YYYY-MM-DD","kind":"reminder ou followup"}
}

Regras rígidas:
- Só inclua o que é NOVO nesta troca. Se nada novo apareceu, devolva todos os campos vazios ou nulos.
- Nunca invente. Se ela não disse, não existe.
- "events": só quando algo concreto aconteceu (brigaram, ele sumiu, ele voltou a falar, se encontraram). Use a data de hoje se ela não deu outra.
- "followup": preencha quando ela mencionar algo com data futura ("vou encontrar ele amanhã", "vou esperar três dias") ou pedir para ser lembrada. Calcule a data a partir de hoje.
- "decisions_resolved": quando a troca mostrar o desfecho de algo que ela tinha decidido antes.
- Nomes de pessoas sempre com a primeira letra maiúscula, sem sobrenome.`;

async function extractAndSave({ userId, userText, assistantText, today, messageId }) {
  const payload = `MENSAGEM DELA:\n${userText}\n\nRESPOSTA DA MENTORA:\n${assistantText}\n\nDevolva o JSON agora.`;

  const data = await extractStructured({
    system: EXTRACTION_SYSTEM(today),
    userMessage: payload,
    userId
  });
  if (!data) return null;

  const supabase = db();

  // --- perfil -------------------------------------------------------
  if (data.user_name) {
    await supabase.from('users')
      .update({ name: data.user_name, nickname: data.user_name })
      .eq('id', userId).is('name', null);
  }
  if (data.relationship_status || data.profile_summary) {
    const patch = { user_id: userId, updated_at: new Date().toISOString() };
    if (data.relationship_status) patch.relationship_status = data.relationship_status;
    if (data.profile_summary) patch.summary = data.profile_summary;
    await supabase.from('profiles').upsert(patch, { onConflict: 'user_id' });
  }

  // --- pessoas ------------------------------------------------------
  const peopleIds = {};
  for (const p of data.people || []) {
    if (!p?.name) continue;
    const row = {
      user_id: userId,
      name: p.name.trim(),
      relation: p.relation || null,
      status: p.status || null,
      since_label: p.since_label || null,
      last_event: p.last_event || null,
      user_goal: p.user_goal || null,
      updated_at: new Date().toISOString()
    };
    Object.keys(row).forEach((k) => row[k] === null && delete row[k]);
    const { data: saved } = await supabase.from('people')
      .upsert(row, { onConflict: 'user_id,name' }).select('id').maybeSingle();
    if (saved) peopleIds[p.name.trim().toLowerCase()] = saved.id;
  }

  // Se ela só tem uma pessoa, ela é a principal.
  const { data: allPeople } = await supabase.from('people').select('id').eq('user_id', userId);
  if (allPeople?.length === 1) {
    await supabase.from('people').update({ is_primary: true }).eq('id', allPeople[0].id);
  }

  async function personId(name) {
    if (!name) return null;
    const key = name.trim().toLowerCase();
    if (peopleIds[key]) return peopleIds[key];
    const { data } = await supabase.from('people')
      .select('id').eq('user_id', userId).ilike('name', name.trim()).maybeSingle();
    if (data) peopleIds[key] = data.id;
    return data?.id || null;
  }

  // --- memórias -----------------------------------------------------
  const rows = [];
  for (const f of data.facts || []) {
    if (f?.content) rows.push({ user_id: userId, person_id: await personId(f.person), kind: 'fact', content: f.content, source_message_id: messageId });
  }
  for (const d of data.decisions || []) {
    if (d?.content) rows.push({ user_id: userId, person_id: await personId(d.person), kind: 'decision', content: d.content, status: 'open', source_message_id: messageId });
  }
  for (const p of data.patterns || []) {
    if (p) rows.push({ user_id: userId, kind: 'pattern', content: p, source_message_id: messageId });
  }
  if (rows.length) await supabase.from('memories').insert(rows);

  // --- decisões concluídas -----------------------------------------
  for (const r of data.decisions_resolved || []) {
    if (!r?.content) continue;
    const { data: match } = await supabase.from('memories')
      .select('id').eq('user_id', userId).eq('kind', 'decision').eq('status', 'open')
      .ilike('content', `%${r.content.slice(0, 30)}%`).limit(1).maybeSingle();
    if (match) {
      await supabase.from('memories')
        .update({ status: 'closed', result: r.result || null }).eq('id', match.id);
    }
  }

  // --- eventos ------------------------------------------------------
  for (const e of data.events || []) {
    if (!e?.description) continue;
    await supabase.from('events').insert({
      user_id: userId,
      person_id: await personId(e.person),
      occurred_on: e.date || today,
      description: e.description
    });
  }

  // --- follow-up ----------------------------------------------------
  if (data.followup?.subject && data.followup?.due) {
    const dailyCap = Number(await getSetting('followup_daily_cap', 1));
    const { count } = await supabase.from('reminders')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('status', 'pending')
      .gte('due_at', `${data.followup.due}T00:00:00Z`)
      .lte('due_at', `${data.followup.due}T23:59:59Z`);

    if ((count || 0) < dailyCap) {
      await supabase.from('reminders').insert({
        user_id: userId,
        kind: data.followup.kind === 'reminder' ? 'reminder' : 'followup',
        subject: data.followup.subject,
        due_at: `${data.followup.due}T12:00:00-03:00`,
        template_name: data.followup.kind === 'reminder' ? 'lembrete_combinado' : 'followup_evento'
      });
    }
  }

  return data;
}

module.exports = { loadRelevantMemories, buildMemoryBlock, extractAndSave };
