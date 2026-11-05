"use client";
import { useT } from "@/hooks/i18n/useT";
import { SeletorDeEtiquetas } from "@/components/tags/SeletorDeEtiquetas";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import { normalizarTag, TAMANHO_MAXIMO_DA_TAG } from "@/lib/contacts/tag-normalizada";
import { TETO_DE_TAGS, TETO_DO_TAMANHO_DA_TAG_DO_LEAD } from "@/lib/schemas/tetos";

/**
 * O alvo do editor — e ele é a ÚNICA coisa que decide para onde a etiqueta vai.
 * A etiqueta do NEGÓCIO (`crm_leads.tags`) e a do CONTATO (`contacts.tags`) são
 * colunas diferentes, em rotas diferentes, em contextos diferentes: ver o
 * cabeçalho deste arquivo.
 */
type AlvoDoEditor =
  | {
      /** Padrão: a PESSOA (Inbox, ficha, campanha). Grava em `contacts.tags`. */
      entityType?: "contact";
    }
  | {
      /** O NEGÓCIO do funil. Grava em `crm_leads.tags`, nunca no contato. */
      entityType: "lead";
      /**
       * O funil do negócio. `useEditLead` o exige para acertar o cache do quadro
       * (`["board", pipelineId]`) — sem ele a etiqueta gravaria no servidor e o
       * card continuaria mostrando a lista antiga.
       */
      pipelineId: string;
    };

type Props = {
  /** Id do alvo: contato (`/contacts/{id}`) ou negócio (`/leads/{id}`). */
  entityId: string;
  /** Organização ativa — vocabulário de sugestões e régua de papel para a cor. */
  orgId: string;
  /** As etiquetas do alvo, como o servidor as devolveu. */
  tags: string[];
} & AlvoDoEditor;

const LIMITE_DE_TAGS = 20;

/**
 * O editor de etiquetas do Inbox e do FUNIL (issue #2979 do upstream).
 *
 * ─── Duas caixas, um editor ─────────────────────────────────────────────────
 *
 * `crm_leads.tags` (a etiqueta do NEGÓCIO) e `contacts.tags` (a da PESSOA) são
 * colunas distintas, gravadas por rotas distintas — `PATCH /api/v1/leads/{id}`
 * e `PATCH /api/v1/contacts/{id}`. Trazer o editor para o funil sem trazer o
 * DESTINO junto seria pior: a etiqueta do negócio iria para o perfil do contato
 * — silenciosamente, porque o PATCH responderia 200 do mesmo jeito. Por isso
 * `entityType` decide a mutação, e não o que estiver disponível na tela.
 *
 * Hiperbold: a tela é a LISTA de etiquetas da organização (a mesma fonte da tela
 * Configurações › Tags) no `SeletorDeEtiquetas`: marcar/desmarcar grava na hora.
 *
 * Grava a forma NORMALIZADA (`normalizarTag`), como a rota (`normalizarTags`) fará
 * de qualquer modo: a lista MOSTRA a grafia do cadastro ("Novo Paciente"), o
 * alvo GUARDA a chave — para "Novo Paciente" e "novo paciente" nunca serem duas
 * tags, nem quebrar o filtro `?tag=` (#852, #1224).
 */
export function ContactTagsEditor(props: Props) {
  const { entityId, orgId, tags } = props;
  const t = useT();
  const noNegocio = props.entityType === "lead";
  // Os DOIS hooks são chamados em toda renderização (regra dos hooks) e nenhum
  // deles dispara nada enquanto `mutate` não for chamado — o id vazio do hook
  // não escolhido é só o que impede um disparo acidental. Quem separa os
  // caminhos é `apply()`, e só ele.
  const daPessoa = useUpdateContact(noNegocio ? "" : entityId);
  const doNegocio = useEditLead(noNegocio ? props.pipelineId : "");
  const pendente = daPessoa.isPending || doNegocio.isPending;
  // Os textos dizem de QUEM é a etiqueta: "Adicionar tag ao contato" num
  // formulário de negócio ensinaria o operador a esperar o destino errado.
  const rotuloCampo = noNegocio ? t("Adicionar tag ao negócio") : t("Adicionar tag ao contato");

  function apply(next: string[]) {
    if (noNegocio) {
      // A MESMA lista de etiquetas, a OUTRA caixa: `crm_leads.tags`, por
      // `PATCH /api/v1/leads/{id}` — nunca o perfil do contato.
      doNegocio.mutate({ leadId: entityId, patch: { tags: next } });
      return;
    }
    daPessoa.mutate({ tags: next });
  }

  return (
    <SeletorDeEtiquetas
      className="mt-2 space-y-2 rounded-md border border-border p-2"
      orgId={orgId}
      value={tags}
      onChange={apply}
      limite={noNegocio ? TETO_DE_TAGS : LIMITE_DE_TAGS}
      tamanhoMaximo={noNegocio ? TETO_DO_TAMANHO_DA_TAG_DO_LEAD : TAMANHO_MAXIMO_DA_TAG}
      // O negócio guarda a grafia do cadastro ("Novo Paciente"), só aparada; o
      // contato guarda a forma normalizada.
      paraGravar={noNegocio ? (tag) => tag.trim().slice(0, TETO_DO_TAMANHO_DA_TAG_DO_LEAD) : normalizarTag}
      rotuloDoCampo={rotuloCampo}
      disabled={pendente}
    />
  );
}
