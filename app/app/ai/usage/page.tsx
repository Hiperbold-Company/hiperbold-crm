import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * A antiga tela "Uso e orçamento" saiu do catálogo em 25/11/2026 (decisão do dono do produto):
 * o cliente é cobrado em TOKENS e ela mostrava o consumo em DÓLAR. O consumo mora em
 * Configurações › Meu plano e consumo de IA; as métricas técnicas do agente (chamadas, turnos,
 * cache, passagem para uma pessoa, tempo de uma chamada) na aba "Agentes de IA" de Desempenho;
 * o custo em dólar, só no painel da plataforma. O endereço fica para link salvo, aviso antigo da
 * Central e a central de ajuda não darem 404. Quem decide o acesso é `/app/settings/plano`
 * (gerente para cima; os demais vão para /403).
 */
export default function AiUsagePage() {
  redirect("/app/settings/plano");
}
