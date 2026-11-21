import type { MarcaDeEntrar } from "@/lib/redesign/entrar";

/**
 * O painel de marca das telas de entrada e de /get-started (redesign).
 *
 * Componente de SERVIDOR: recebe o nome da instalação (`marca.nome`, nunca fixo),
 * a função de tradução da própria tela e a marca `rd`. Sem a chave ligada
 * `rd("painel")` é `undefined` e nada é renderizado: DOM idêntico ao de sempre.
 * É decorativo (`aria-hidden`): o formulário ao lado é o conteúdo.
 */
const ICONES: readonly [string, string, string] = [
  "M4 5h16v11H8l-4 4z",
  "M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7-4.7-1.8 4.7-1.8zM18 15l.9 2.1 2.1.9-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z",
  "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v6h-4z",
];

export function PainelDeEntrar({
  marca,
  t,
  rd,
}: {
  marca: { nome: string };
  t: (texto: string) => string;
  rd: MarcaDeEntrar;
}) {
  if (!rd("painel")) return null;
  return (
    <aside data-rd-entrar={rd("painel")} aria-hidden="true">
      <p>{marca.nome}</p>
      <h2>{t("Todo o seu atendimento de WhatsApp, com IA, num lugar só")}</h2>
      <ul>
        <li>
          <span data-rd-entrar="beneficio-icone">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={ICONES[0]} />
            </svg>
          </span>
          <span>
            <b>{t("Todas as conversas num só lugar")}</b>
            <span>{t("O WhatsApp da equipe inteira, sem trocar de celular.")}</span>
          </span>
        </li>
        <li>
          <span data-rd-entrar="beneficio-icone">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={ICONES[1]} />
            </svg>
          </span>
          <span>
            <b>{t("IA que atende e agenda por você")}</b>
            <span>{t("Responde na hora e chama a equipe quando precisa.")}</span>
          </span>
        </li>
        <li>
          <span data-rd-entrar="beneficio-icone">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={ICONES[2]} />
            </svg>
          </span>
          <span>
            <b>{t("Vendas sempre em dia")}</b>
            <span>{t("Cada conversa vira um negócio no funil, sem anotar nada.")}</span>
          </span>
        </li>
      </ul>
      <div data-rd-entrar="conversa">
        <div data-rd-entrar="conversa-topo">
          <span data-rd-entrar="conversa-avatar">MC</span>
          <span>
            <b>Marina Costa</b>
            <span>{t("WhatsApp · agora")}</span>
          </span>
        </div>
        <div data-rd-entrar="conversa-corpo">
          <span data-rd-entrar="bolha-cliente">{t("Oi! Vocês têm horário amanhã de manhã?")}</span>
          <span data-rd-entrar="selo-ia">{t("Respondido pela IA")}</span>
          <span data-rd-entrar="bolha-ia">{t("Tenho 9h30 ou 10h. Qual fica melhor para você?")}</span>
          <span data-rd-entrar="bolha-cliente">{t("9h30 está ótimo!")}</span>
        </div>
        <div data-rd-entrar="conversa-rodape">{t("Consulta marcada e negócio movido para \"Agendado\"")}</div>
      </div>
    </aside>
  );
}
