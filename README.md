# Cleópatra v2 — canal WhatsApp

Reformulação do projeto para funcionar pelo WhatsApp Cloud API oficial da Meta,
com memória persistente em Postgres.

**Nada aqui foi publicado.** Os arquivos abaixo convivem com o site atual: o
`index.html` e as funções antigas continuam funcionando enquanto você testa.

---

## O que mudou

| | Antes | Agora |
|---|---|---|
| Canal | site | WhatsApp (site vira vitrine) |
| Identidade | `anonymousId` do navegador | telefone (`wa_id`) |
| Memória | localStorage do navegador | Postgres, recuperada por relevância |
| Banco | Redis (3 chaves) | Postgres com 18 tabelas |
| Acesso | 5 minutos cronometrados | mensagens grátis configuráveis |
| Pagamento | `paid:{email}` no Redis | tabela `subscriptions` + retomada da conversa |
| Proatividade | não existia | lembretes e follow-ups por cron |
| Custo | invisível | tabela `ai_usage` por mensagem |
| Modelo de IA | fixo no código | `app_settings.ai_model` |

---

## Arquivos

```
api/whatsapp/webhook.js       recebe da Meta, valida assinatura, enfileira, responde 200
api/whatsapp/process.js       worker: roda o engine (protegido por INTERNAL_SECRET)
api/cron/followups.js         lembretes vencidos + resgate de mensagens presas
api/payments/kiwify-webhook.js  assinatura no Postgres + aviso no WhatsApp

lib/db.js                     Supabase + app_settings
lib/aiProvider.js             única porta para a IA, com log de custo
lib/persona.js                personalidade, conhecimento, modos, onboarding
lib/memory.js                 recuperação relevante + extração e gravação
lib/whatsapp.js               envio, botões, templates, mídia, janela de 24h
lib/cleopatraEngine.js        o ciclo completo

db/schema.sql                 rode uma vez no Supabase
db/seed.sql                   configurações, planos e templates iniciais
```

---

## Instalação

### 1. Supabase

Crie o projeto, abra o **SQL Editor** e rode `db/schema.sql` inteiro. Depois
`db/seed.sql` (ajuste preços e o `free_message_limit` antes).

Em **Settings → API**, copie a URL e a `service_role` key.

### 2. Meta / WhatsApp

Em developers.facebook.com, crie um app do tipo Business e adicione o produto
**WhatsApp**. Você vai precisar de:

- **Phone Number ID** (não é o número; é o ID dele)
- **Token permanente** — crie um usuário do sistema no Business Manager com
  permissão `whatsapp_business_messaging`. O token de teste expira em 24h e vai
  te derrubar em produção.
- **App Secret** — Configurações Básicas do app. É o que valida a assinatura.

Configure o webhook em WhatsApp → Configuração:

```
URL:   https://SEU-PROJETO.vercel.app/api/whatsapp/webhook
Token: o mesmo valor de WHATSAPP_VERIFY_TOKEN
```

Assine os campos `messages` e `message_status`.

Submeta os três templates do `seed.sql` no Gerenciador do WhatsApp, categoria
**UTILITY**. Faça isso agora — a aprovação leva de horas a dias e você só
descobre que foi reprovado depois.

### 3. Vercel

Copie o `.env.example` para as variáveis de ambiente do projeto. Gere o
`INTERNAL_SECRET` com `openssl rand -hex 32`.

O `vercel.json` já registra o cron de 10 em 10 minutos. **Cron e o
`maxDuration` de 120s do worker exigem o plano Pro.** No plano gratuito o
limite é 10s, e o worker vai ser cortado no meio da resposta.

### 4. Teste

Mande "oi" para o número. A sequência esperada:

1. Ela se apresenta e pergunta sobre guardar a memória (dois botões).
2. Você toca em "Pode guardar" → ela pergunta sobre lembretes.
3. Depois pergunta como você gosta de ser chamada.
4. A partir daí, conversa normal com onboarding conversacional.

Confira no Supabase se `users`, `privacy_consents`, `messages` e `ai_usage`
foram preenchidos.

---

## Decisões que tomei e você deve saber

**Não migrei para Next.js.** O canal WhatsApp é backend puro. Trocar de
framework no mesmo movimento dobraria o risco sem entregar nada a mais. A
migração faz sentido quando os painéis entrarem (fases 10 e 11).

**A recuperação de memória ainda não usa embeddings.** Ela combina quatro
sinais: pessoas citadas na mensagem, busca textual em português (`tsvector`
com `unaccent`), decisões em aberto e recência. A Anthropic não oferece API de
embeddings — usar busca semântica exigiria contratar Voyage ou OpenAI só para
isso. A tabela `memory_embeddings` já existe no schema, então a troca é local
quando o volume justificar. Para uma usuária com dezenas de memórias, a busca
textual resolve bem; o gargalo aparece na casa das centenas.

**A extração de memória usa Haiku, não Sonnet.** É tarefa mecânica de
transformar texto em JSON. Isso corta perto de 80% do custo da segunda chamada,
que hoje roda em Sonnet no site atual.

**A ambiguidade de pessoas virou pergunta, não chute.** Quando ela diz "ele" e
existe mais de uma pessoa na história, o prompt instrui a Cleópatra a perguntar
("É o Rafael?"). Isso protege contra o pior erro possível — confundir duas
pessoas — e por acaso é exatamente o diálogo que você escreveu no prompt mestre.

**O contador de mensagens grátis nunca aparece na conversa.** Ao chegar em
`free_warning_at`, o prompt ganha uma instrução para convidar naturalmente. Só
quando estoura o limite é que o link de checkout aparece.

---

## Kiwify

### O problema que o `sck` resolve

O pagamento acontece no site da Kiwify, mas a usuária é identificada pelo
telefone no WhatsApp. Se ela digitar no checkout um e-mail ou celular
diferente do WhatsApp dela — e isso acontece o tempo todo — o webhook não
consegue saber quem pagou. Ela paga e continua bloqueada. É a pior falha
possível no funil, porque acontece exatamente no momento em que ela confiou.

Por isso cada usuária recebe um link único. O `sendPaywall` gera uma
referência, grava em `checkout_sessions` e monta:

```
https://pay.kiwify.com.br/SEUPRODUTO?sck=u3f8a91b2c4d5e6f7
```

A Kiwify aceita `src`, `sck`, `utm_*` e `s1`/`s2`/`s3` na URL do checkout e
guarda no pedido. O webhook lê de volta e encontra a usuária sem depender do
que ela digitou. Telefone e e-mail continuam como fallback.

### Configuração

1. **Webhook**: Apps → Webhooks → Criar. URL:
   `https://SEU-PROJETO.vercel.app/api/payments/kiwify-webhook?token=SEU_SEGREDO`
   Eventos: `compra_aprovada`, `compra_reembolsada`, `compra_recusada`,
   `chargeback`, `subscription_canceled`, `subscription_late`,
   `subscription_renewed`.

2. **Mapeie os produtos**. Rode `db/migration-002-kiwify.sql` e depois, para
   cada plano:
   ```sql
   update plans set provider_product_id = 'ID_DO_PRODUTO_NA_KIWIFY'
    where slug = 'mensal';
   ```
   Sem isso o webhook cai no plano padrão e a data de vencimento sai errada
   em quem comprou trimestral ou anual.

3. **Confirme o formato do payload.** Antes de apontar para a Vercel, aponte
   o webhook para webhook.site e faça uma compra de teste. Confira dois
   campos: onde o `sck` aparece (o código procura em 11 caminhos possíveis,
   mas confirme) e o nome do campo do produto.

4. **Assinatura.** A Kiwify manda `?signature=` com o HMAC do corpo. O código
   testa SHA-1 e SHA-256 e **registra no log** se bateu, sem recusar — recusar
   com o algoritmo errado derrubaria pagamentos legítimos. Depois da primeira
   compra real, procure no log da Vercel:

   > Assinatura Kiwify confere (sha1). Já pode ligar KIWIFY_ENFORCE_SIGNATURE=true.

   Aí sim ligue `KIWIFY_ENFORCE_SIGNATURE=true`, e o token na URL deixa de ser
   a única defesa.

### Comportamentos que talvez você não espere

- **Renovação é silenciosa.** Todo mês a Kiwify dispara
  `subscription_renewed`. O código atualiza a data de validade mas **não**
  manda mensagem no WhatsApp — receber "Pronto ❤️" todo mês seria estranho.
- **Reembolso e chargeback cortam o acesso na hora**, sem aviso. Se preferir
  uma mensagem de despedida, é no bloco `revoke`.
- **Duplicatas são ignoradas** por `order_id` + tipo de evento. A Kiwify
  reenvia quando não recebe 2xx.

## O que ainda falta

Fases 7, 10 e 11 do plano: timeline no painel web, painel da usuária e painel
administrativo. Todos leem tabelas que já existem neste schema — é trabalho de
frontend, não de arquitetura.

Também não implementei ainda: áudio (o worker responde pedindo texto),
Conversions API da Meta, e a página `/assinar` com os planos vindos do banco.

---

## Correção urgente no site atual

Independente desta migração, o `api/chat.js` que está no ar hoje pula a
verificação de acesso quando `mode === 'checkin'`. Qualquer pessoa pode chamar
sua API com esse modo e consumir sua conta da Anthropic sem limite. A correção
é remover a condição:

```js
// antes
if (mode !== 'checkin') {
  const access = await checkAccess(anonymousId, paidEmail);
  if (!access.allowed) return res.status(200).json({ trialExpired: true });
}

// depois
const access = await checkAccess(anonymousId, paidEmail);
if (!access.allowed) return res.status(200).json({ trialExpired: true });
```

Vale publicar isso sozinho, hoje, sem esperar o resto.
