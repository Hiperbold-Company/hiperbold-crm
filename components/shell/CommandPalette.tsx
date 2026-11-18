"use client";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoCanalDaConversa } from "@/lib/channels/estado";
import { rotuloParaAEquipe } from "@/lib/contacts/rotulo-do-contato";
import { buscaValeConsulta } from "@/lib/inbox/termo-de-busca";
import { NAV_GROUPS, searchable } from "@/lib/navigation/registry";
import { ChatCircle, UserCircle } from "@/lib/ui/icons";
import {
  PaletaDeDestinos,
  type GrupoDeDados,
  type ItemDeDados,
} from "@/components/shell/PaletaDeDestinos";

/**
 * Paleta de navegação (⌘K) do APP DO TENANT.
 *
 * A UI, o filtro e o teclado moram em `PaletaDeDestinos`. O que sobra aqui é a
 * FONTE deste lado:
 *   - telas: `searchable(...)`;
 *   - dados: contatos e conversas, pelas MESMAS rotas das listas
 *     (`GET /api/v1/contacts?search=` e `GET /api/v1/conversations?search=`).
 *     Sessão, organização e escopo (RLS: `fn_can_view_conversation` aplica o
 *     "só as minhas" do atendente) são os da tela correspondente. Cada grupo só
 *     existe se a tela dele (`/app/contacts`, `/app/inbox`) está entre as
 *     visíveis — o que cobre papel, interface e funções ocultas.
 *
 * Negócios ficam de fora: nenhuma rota GET de `app/api/v1` busca negócio por
 * texto hoje (`/api/v1/leads` só tem POST; `pipelines/[id]/leads` não busca).
 */

const ESPERA_DA_DIGITACAO_MS = 250;
const ITENS_POR_GRUPO = 5;

interface ContatoDaBusca {
  id: string;
  name: string | null;
  display_name: string | null;
  address_book_name?: string | null;
  phone_number: string | null;
  email: string | null;
}

interface ConversaDaBusca {
  id: string;
  contacts?: {
    name: string | null;
    display_name: string | null;
    address_book_name?: string | null;
    phone_number: string | null;
  } | null;
  channel_sessions?: { display_name?: string | null; phone_number?: string | null } | null;
}

function useTermoAdiado(termo: string): string {
  const [adiado, setAdiado] = useState(termo);
  useEffect(() => {
    const id = setTimeout(() => setAdiado(termo), ESPERA_DA_DIGITACAO_MS);
    return () => clearTimeout(id);
  }, [termo]);
  return adiado;
}

function estadoDoGrupo(
  termoValido: boolean,
  aindaDigitando: boolean,
  q: { isPending: boolean; isError: boolean; isFetching: boolean },
): GrupoDeDados["estado"] {
  if (!termoValido) return "pronto";
  if (aindaDigitando || q.isPending || q.isFetching) return "carregando";
  if (q.isError) return "erro";
  return "pronto";
}

// Item só conta quando está na tela: durante o debounce, num refetch ou num erro
// com dado retido, o grupo mostra esqueleto/erro, e um item escondido ainda
// contado faria o Enter abrir algo que a pessoa não viu (e o
// aria-activedescendant apontar para um id que não existe).
function comItensSoQuandoPronto(
  estado: GrupoDeDados["estado"],
  itens: ItemDeDados[],
): Pick<GrupoDeDados, "estado" | "itens"> {
  return { estado, itens: estado === "pronto" ? itens : [] };
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { user, activeOrg } = useAuth();
  const [termo, setTermo] = useState("");

  const visiveis = useMemo(
    () =>
      searchable(
        user.is_platform_admin && !user.support,
        activeOrg?.role ?? null,
        activeOrg?.interface_settings,
        activeOrg?.modulos_ligados ?? [],
        activeOrg?.capacidades_ligadas ?? [],
      ),
    [
      user.is_platform_admin,
      user.support,
      activeOrg?.role,
      activeOrg?.interface_settings,
      activeOrg?.modulos_ligados,
      activeOrg?.capacidades_ligadas,
    ],
  );

  const podeContatos = visiveis.some((d) => d.href === "/app/contacts");
  const podeConversas = visiveis.some((d) => d.href === "/app/inbox");

  const termoLimpo = termo.trim();
  const adiado = useTermoAdiado(termoLimpo);
  const termoValido = open && buscaValeConsulta(termoLimpo);
  const adiadoValido = open && buscaValeConsulta(adiado);
  const aindaDigitando = termoLimpo !== adiado;
  const orgId = activeOrg?.orgId ?? null;

  const contatos = useQuery({
    queryKey: ["busca-da-paleta", orgId, "contatos", adiado],
    enabled: adiadoValido && podeContatos,
    retry: false,
    staleTime: 30_000,
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams({ search: adiado, limit: String(ITENS_POR_GRUPO) });
      return apiClient.get<{ data: ContatoDaBusca[] }>(`/api/v1/contacts?${qs.toString()}`, {
        signal,
      });
    },
  });

  const conversas = useQuery({
    queryKey: ["busca-da-paleta", orgId, "conversas", adiado],
    enabled: adiadoValido && podeConversas,
    retry: false,
    staleTime: 30_000,
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams({ search: adiado, limit: String(ITENS_POR_GRUPO) });
      return apiClient.get<{ data: ConversaDaBusca[] }>(
        `/api/v1/conversations?${qs.toString()}`,
        { signal },
      );
    },
  });

  const gruposDeDados = useMemo<GrupoDeDados[]>(() => {
    const grupos: GrupoDeDados[] = [];
    if (podeContatos) {
      const itens: ItemDeDados[] = (contatos.data?.data ?? [])
        .slice(0, ITENS_POR_GRUPO)
        .map((c) => ({
          id: c.id,
          href: `/app/contacts/${c.id}`,
          titulo: rotuloParaAEquipe(c, t),
          secundaria: c.phone_number ? phoneForDisplay(c.phone_number) : c.email,
        }));
      grupos.push({
        id: "contatos",
        rotulo: t("Contatos"),
        icon: UserCircle,
        ...comItensSoQuandoPronto(estadoDoGrupo(termoValido, aindaDigitando, contatos), termoValido ? itens : []),
      });
    }
    if (podeConversas) {
      const itens: ItemDeDados[] = (conversas.data?.data ?? [])
        .slice(0, ITENS_POR_GRUPO)
        .map((c) => ({
          id: c.id,
          href: `/app/inbox?id=${encodeURIComponent(c.id)}`,
          titulo: rotuloParaAEquipe(c.contacts ?? null, t),
          secundaria: rotuloDoCanalDaConversa(c.channel_sessions ?? null, t),
        }));
      grupos.push({
        id: "conversas",
        rotulo: t("Conversas"),
        icon: ChatCircle,
        ...comItensSoQuandoPronto(estadoDoGrupo(termoValido, aindaDigitando, conversas), termoValido ? itens : []),
      });
    }
    return grupos;
  }, [podeContatos, podeConversas, contatos, conversas, termoValido, aindaDigitando, t]);

  function mudarAbertura(aberta: boolean) {
    if (!aberta) setTermo("");
    onOpenChange(aberta);
  }

  return (
    <PaletaDeDestinos
      open={open}
      onOpenChange={mudarAbertura}
      destinos={visiveis}
      grupos={NAV_GROUPS}
      titulo={t("Buscar telas")}
      rotuloLista={t("Telas")}
      placeholder={t(
        "Buscar por nome, objetivo ou função (ex: leads, agenda, prompt, whatsapp)...",
      )}
      aoMudarBusca={setTermo}
      gruposDeDados={gruposDeDados}
    />
  );
}
