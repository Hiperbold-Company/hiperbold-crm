"use client";
import { useT } from "@/hooks/i18n/useT";
import { SeletorDeEtiquetas } from "@/components/tags/SeletorDeEtiquetas";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { normalizarTag, TAMANHO_MAXIMO_DA_TAG } from "@/lib/contacts/tag-normalizada";

interface Props {
  contactId: string;
  orgId: string;
  tags: string[];
}

const LIMITE_DE_TAGS = 20;

/** Edita as tags do CONTATO (distinto de ConversationTagsEditor, que edita as
 * tags da conversa) — aberto pelo botão "Tags do contato" do painel do Inbox.
 *
 * Mostra a LISTA de etiquetas da organização (a mesma fonte da tela
 * Configurações › Tags) no `SeletorDeEtiquetas`: marcar/desmarcar grava na hora.
 *
 * Grava a forma NORMALIZADA (`normalizarTag`), como a rota (`normalizarTags`) fará
 * de qualquer modo: a lista MOSTRA a grafia do cadastro ("Novo Paciente"), o
 * contato GUARDA a chave — para "Novo Paciente" e "novo paciente" nunca serem duas
 * tags, nem quebrar o filtro `?tag=` (#852, #1224). */
export function ContactTagsEditor({ contactId, orgId, tags }: Props) {
  const t = useT();
  const mutation = useUpdateContact(contactId);

  return (
    <SeletorDeEtiquetas
      className="mt-2 space-y-2 rounded-md border border-border p-2"
      orgId={orgId}
      value={tags}
      onChange={(next) => mutation.mutate({ tags: next })}
      limite={LIMITE_DE_TAGS}
      tamanhoMaximo={TAMANHO_MAXIMO_DA_TAG}
      paraGravar={normalizarTag}
      rotuloDoCampo={t("Adicionar tag ao contato")}
      disabled={mutation.isPending}
    />
  );
}
