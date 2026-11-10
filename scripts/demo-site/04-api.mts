/**
 * Fase 2 da demo do site: o que tem forma de produto (agentes, fontes de captação,
 * automações) nasce pela API do próprio app, logado como a dona da org demo.
 * Só aceita app em localhost. Uso:
 *   DEMO_URL=http://localhost:3210 PIPE=<id> STAGES=<id1,id2,...> npx tsx scripts/demo-site/04-api.mts
 */
import { chromium, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const BASE = process.env.DEMO_URL ?? "http://localhost:3210";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE)) throw new Error(`RECUSADO: app não local (${BASE})`);
const PIPE = process.env.PIPE!;
const ST = (process.env.STAGES ?? "").split(",");
const USERS = (process.env.USERS ?? "").split(","); // ricardo, beatriz, lucas
const SENHA = readFileSync(`${homedir()}/temp/2026-11-10/d228/demo-senha`, "utf8").trim();
const SO = process.argv[2]; // opcional: "agentes" | "fontes" | "automacoes"

async function chamar(req: APIRequestContext, metodo: "get" | "post" | "patch", url: string, data?: unknown) {
  const r = await req[metodo](`${BASE}${url}`, {
    data,
    headers: { Origin: BASE, "Content-Type": "application/json" },
  });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok()) throw new Error(`${metodo.toUpperCase()} ${url} -> ${r.status()} ${JSON.stringify(corpo).slice(0, 1500)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- roteiro de demonstração; a forma varia por rota
  return corpo as { data: any };
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "pt-BR" });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`);
await page.locator("#email").fill("juliana.ferraz@exemplo.com.br");
await page.locator("#password").fill(SENHA);
await page.getByRole("button", { name: "Entrar", exact: true }).click();
await page.waitForURL(/\/app/, { timeout: 30_000 });
const req = page.request;

// ---------------- Agentes ----------------
if (!SO || SO === "agentes") {
  const agentes = [
    {
      name: "Recepção",
      description: "Atende quem chega pelo WhatsApp, tira dúvidas e agenda a avaliação.",
      system_prompt:
        "Você é a recepção da Clínica Demonstração. Atenda com simpatia, em português do Brasil, frases curtas. Entenda qual tratamento a pessoa procura, tire dúvidas gerais e ofereça a avaliação gratuita com o dentista, sugerindo dois horários. Nunca informe preço fechado: diga que o valor sai na avaliação e que parcelamos em até 12x.",
    },
    {
      name: "Pós-venda",
      description: "Acompanha o paciente depois do tratamento e pede avaliação.",
      system_prompt:
        "Você cuida do pós-venda da Clínica Demonstração. Pergunte como o paciente está depois do procedimento, lembre os cuidados combinados, confirme o retorno e, se tudo estiver bem, peça uma avaliação da clínica no Google. Se houver dor ou queixa, passe a conversa para a equipe na hora.",
    },
  ];
  const existentes = (await chamar(req, "get", "/api/v1/ai/agents")).data as Array<{ id: string; name: string; published_version_id: string | null }>;
  for (const a of agentes) {
    const ja = existentes.find((e) => e.name === a.name);
    if (ja?.published_version_id) { console.log(`agente já publicado: ${a.name}`); continue; }
    const id = ja ? ja.id : ((await chamar(req, "post", "/api/v1/ai/agents", a)).data.id as string);
    const versoes = await chamar(req, "get", `/api/v1/ai/agents/${id}/versions`);
    const lista = (versoes.data?.versions ?? versoes.data) as Array<{ id: string }>;
    await chamar(req, "post", `/api/v1/ai/agents/${id}/publish`, { version_id: lista[0]!.id });
    console.log(`agente publicado: ${a.name} ${id}`);
  }
}

// ---------------- Fontes de captação + envios ----------------
if (!SO || SO === "fontes") {
  const fontes = [
    { name: "Formulário do site", leads: [
      { name: "Sabrina Lopes", phone: "+5511987336512", email: "sabrina.lopes@exemplo.com.br", utm_source: "google", utm_medium: "organic" },
      { name: "Otávio Marques", phone: "+5511976559081", email: "otavio.marques@exemplo.com.br" },
      { name: "Daniela Cunha", phone: "+5511965418827", email: "daniela.cunha@exemplo.com.br", utm_source: "instagram", utm_medium: "social" },
    ]},
    { name: "Landing de implantes", leads: [
      { name: "Sérgio Tavares", phone: "+5511954776203", email: "sergio.tavares@exemplo.com.br", utm_source: "google", utm_medium: "cpc", utm_campaign: "implantes-sp" },
      { name: "Lúcia Ramos", phone: "+5511943662914", email: "lucia.ramos@exemplo.com.br", utm_source: "google", utm_medium: "cpc", utm_campaign: "implantes-sp" },
    ]},
  ];
  for (const f of fontes) {
    const criado = await chamar(req, "post", "/api/v1/webhook-sources", {
      name: f.name, default_pipeline_id: PIPE, default_stage_id: ST[0],
    });
    const token = criado.data.path_token as string;
    for (const l of f.leads) {
      const r = await fetch(`${BASE}/api/v1/webhooks/in/${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(l),
      });
      console.log(`envio ${f.name} / ${l.name}: ${r.status}`);
    }
  }
}

// ---------------- Automações ----------------
type No = { id: string; type: string; label: string; config: unknown; position: { x: number; y: number } };
type Aresta = { id: string; source: string; target: string; priority: number; condition: unknown };
const SEMPRE = { type: "always" };
const ERRO = { type: "branch", branch_id: "erro" };

function grafo(nos: No[], ligacoes: Array<[string, string, unknown?]>) {
  const edges: Aresta[] = ligacoes.map(([s, t, c], i) => ({ id: `edge-${i + 1}`, source: s, target: t, priority: 0, condition: c ?? SEMPRE }));
  return { nodes: nos, edges };
}
const gatilho = (triggers: unknown[]): No => ({
  id: "n1", type: "trigger", label: "Início", position: { x: 0, y: 0 },
  config: { triggers, reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
});
const H = 3_600_000;

if (!SO || SO === "automacoes") {
  const [ricardo, beatriz, lucas] = USERS;
  const automacoes: Array<{ name: string; g: ReturnType<typeof grafo> }> = [
    {
      name: "Boas-vindas ao novo lead",
      g: grafo([
        gatilho([{ kind: "lead_created", pipeline_ids: [PIPE] }]),
        { id: "crm-1", type: "crm_action", label: "Distribuir para a equipe", position: { x: 0, y: 160 },
          config: { on_error: "continue", actions: [
            { type: "set_owner", mode: { m: "round_robin", user_ids: [beatriz, lucas] } },
            { type: "add_tags", target: "lead", tags: ["novo-lead"] } ] } },
        { id: "msg-2", type: "message", label: "Mensagem de boas-vindas", position: { x: 0, y: 320 },
          config: { body: "Olá, {{contact.name}}! Aqui é da Clínica Demonstração 😊 Recebemos seu contato e já vamos te ajudar. Qual tratamento você procura?" } },
        { id: "wait-3", type: "wait", label: "Esperar 2 horas", position: { x: 0, y: 480 }, config: { mode: "fixed", duration_ms: 2 * H } },
        { id: "crm-4", type: "crm_action", label: "Criar tarefa de ligação", position: { x: 0, y: 640 },
          config: { on_error: "continue", actions: [ { type: "create_task", title: "Ligar para {{contact.name}}", due_in_minutes: 60, assignee: "owner" } ] } },
        { id: "end-5", type: "end", label: "Fim do fluxo", position: { x: 0, y: 800 }, config: { outcome: "converted" } },
      ], [["n1", "crm-1"], ["crm-1", "msg-2"], ["msg-2", "wait-3"], ["msg-2", "end-5", ERRO], ["wait-3", "crm-4"], ["crm-4", "end-5"]]),
    },
    {
      name: "Lembrete de consulta",
      g: grafo([
        gatilho([{ kind: "appointment", events: ["created", "rescheduled"] }]),
        { id: "msg-1", type: "message", label: "Confirmação do agendamento", position: { x: 0, y: 160 },
          config: { body: "Oi, {{contact.name}}! Sua avaliação na Clínica Demonstração está agendada. Qualquer imprevisto, é só responder aqui." } },
        { id: "wait-2", type: "wait", label: "Esperar 1 dia", position: { x: 0, y: 320 }, config: { mode: "fixed", duration_ms: 24 * H } },
        { id: "msg-3", type: "message", label: "Pedir confirmação", position: { x: 0, y: 480 },
          config: { body: "Amanhã é o dia da sua avaliação! Você confirma presença?", reply_timeout_ms: 12 * H,
            options: { kind: "buttons", items: [ { id: "confirmo", label: "Confirmo" }, { id: "remarcar", label: "Preciso remarcar" } ] } } },
        { id: "crm-4", type: "crm_action", label: "Marcar como confirmado", position: { x: -260, y: 660 },
          config: { on_error: "continue", actions: [ { type: "add_tags", target: "lead", tags: ["confirmado"] } ] } },
        { id: "crm-5", type: "crm_action", label: "Avisar a recepção", position: { x: 260, y: 660 },
          config: { on_error: "continue", actions: [ { type: "notify", to: "owner", message: "{{contact.name}} pediu para remarcar a avaliação." } ] } },
        { id: "end-6", type: "end", label: "Fim do fluxo", position: { x: 0, y: 840 }, config: { outcome: "converted" } },
        { id: "end-7", type: "end", label: "Sem resposta", position: { x: 520, y: 660 }, config: { outcome: "exhausted" } },
      ], [["n1", "msg-1"], ["msg-1", "wait-2"], ["msg-1", "end-6", ERRO], ["wait-2", "msg-3"],
          ["msg-3", "crm-4", { type: "branch", branch_id: "confirmo" }], ["msg-3", "crm-5", { type: "branch", branch_id: "remarcar" }],
          ["msg-3", "end-7", { type: "branch", branch_id: "no_reply" }], ["msg-3", "end-6", ERRO], ["msg-3", "end-6"],
          ["crm-4", "end-6"], ["crm-5", "end-6"]]),
    },
    {
      name: "Reativar quem sumiu",
      g: grafo([
        gatilho([{ kind: "no_reply", after_minutes: 4320, only_if_last_was_outbound: true }]),
        { id: "msg-1", type: "message", label: "Retomar a conversa", position: { x: 0, y: 160 },
          config: { body: "Oi, {{contact.name}}! Passando para saber se ainda posso te ajudar com o seu tratamento. Ainda temos horários de avaliação nesta semana.",
            reply_timeout_ms: 48 * H, options: { kind: "buttons", items: [ { id: "quero", label: "Quero agendar" }, { id: "depois", label: "Mais para frente" } ] } } },
        { id: "crm-2", type: "crm_action", label: "Mover para avaliação", position: { x: -260, y: 340 },
          config: { on_error: "continue", actions: [ { type: "move_deal", pipeline_id: PIPE, stage_id: ST[1] }, { type: "notify", to: "owner", message: "{{contact.name}} voltou e quer agendar." } ] } },
        { id: "wait-3", type: "wait", label: "Esperar 7 dias", position: { x: 260, y: 340 }, config: { mode: "fixed", duration_ms: 7 * 24 * H } },
        { id: "crm-4", type: "crm_action", label: "Encerrar como perdido", position: { x: 520, y: 520 },
          config: { on_error: "continue", actions: [ { type: "lose_deal", reason: "Sem retorno ao contato" } ] } },
        { id: "end-5", type: "end", label: "Fim do fluxo", position: { x: 0, y: 700 }, config: { outcome: "converted" } },
      ], [["n1", "msg-1"], ["msg-1", "crm-2", { type: "branch", branch_id: "quero" }], ["msg-1", "wait-3", { type: "branch", branch_id: "depois" }],
          ["msg-1", "crm-4", { type: "branch", branch_id: "no_reply" }], ["msg-1", "end-5", ERRO], ["msg-1", "end-5"],
          ["crm-2", "end-5"], ["wait-3", "end-5"], ["crm-4", "end-5"]]),
    },
    {
      name: "Comentou no Instagram, recebe o Direct",
      g: grafo([
        gatilho([{ kind: "instagram_comment", match: "contains", keywords: ["preço", "valor", "quero"], create_contact: true }]),
        { id: "igpub-1", type: "instagram_public_reply", label: "Responder o comentário", position: { x: 0, y: 320 },
          config: { text: "Oi! Te mandei os detalhes no Direct 💬" } },
        { id: "igdm-2", type: "instagram_private_reply", label: "Mandar no Direct", position: { x: 0, y: 160 },
          config: { text: "Olá! Vi seu comentário 😊 A avaliação na Clínica Demonstração é gratuita e o tratamento parcela em até 12x. Quer que eu reserve um horário para você?" } },
        { id: "crm-3", type: "crm_action", label: "Criar negócio no funil", position: { x: 0, y: 480 },
          config: { on_error: "continue", actions: [
            { type: "create_deal", pipeline_id: PIPE, stage_id: ST[0], if_open_exists: "skip", title: "{{contact.name}} — Instagram" },
            { type: "add_tags", target: "lead", tags: ["instagram"] },
            { type: "set_owner", mode: { m: "round_robin", user_ids: [beatriz, lucas] } } ] } },
        { id: "end-4", type: "end", label: "Fim do fluxo", position: { x: 0, y: 640 }, config: { outcome: "converted" } },
      ], [["n1", "igdm-2"], ["igdm-2", "igpub-1"], ["igdm-2", "end-4", ERRO], ["igpub-1", "crm-3"], ["igpub-1", "end-4", ERRO], ["crm-3", "end-4"]]),
    },
  ];
  void ricardo;
  const ja = (await chamar(req, "get", "/api/v1/ai/followup-flows?surface=automacao")).data as Array<{ id: string; name: string; status: string }>;
  for (const a of automacoes) {
    const existente = ja.find((x) => x.name === a.name);
    if (existente?.status === "active") { console.log(`automação já publicada: ${a.name}`); continue; }
    const id = existente ? existente.id : ((await chamar(req, "post", "/api/v1/ai/followup-flows", { name: a.name, surface: "automacao" })).data.id as string);
    await chamar(req, "patch", `/api/v1/ai/followup-flows/${id}`, { draft_graph: a.g });
    try {
      await chamar(req, "post", `/api/v1/ai/followup-flows/${id}/publish`, {});
      console.log(`automação publicada: ${a.name} ${id}`);
    } catch (e) {
      console.log(`automação em rascunho (publish recusou): ${a.name} ${id} :: ${(e as Error).message}`);
    }
  }
}

await browser.close();
