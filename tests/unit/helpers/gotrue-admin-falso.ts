/**
 * Um GoTrue administrativo falso, só com o que a reassunção de conta usa (D-204): ler e gravar o usuário
 * (`app_metadata`), trocar a senha, listar e remover fatores de MFA e derrubar sessões. Guarda a ORDEM em que as
 * operações chegam (`chamadas`), porque a ordem é a segurança. É a borda do provedor, não o código sob teste.
 */
import { vi } from "vitest";

export type EtapaQuePodeFalhar = "senha" | "fatores" | "sessoes" | "revogacao" | "gravacao";

export interface OpcoesDoGotrueFalso {
  falharEm?: EtapaQuePodeFalhar;
  /** Fatores de MFA que a conta tem. */
  fatores?: Array<{ id: string; status: "verified" | "unverified" }>;
  /** `app_metadata` inicial. Padrão: pedido de verificação em aberto. */
  appMetadata?: Record<string, unknown>;
  /** Quantas linhas cada tabela devolve ao ser revogada pela reassunção (padrão 0). */
  criados?: { api_tokens?: number; team_invites?: number; webhook_sources?: number };
  /** Simula um provedor em que remover fator verificado encerra também a sessão nova (o GoTrue 2.196.0 só rebaixa). */
  sessaoNovaMorreAoRemoverFator?: boolean;
}

export const PEDIDO_EM_ABERTO = { hash: "h", expira_em: "2099-01-01T00:00:00Z", enviado_em: "2026-10-17T00:00:00Z" };

export function gotrueFalso(opcoes: OpcoesDoGotrueFalso = {}) {
  const chamadas: string[] = [];
  const removidos: string[] = [];
  const revogacoes: Array<{ tabela: string; valores: Record<string, unknown>; filtros: Array<[string, unknown]> }> = [];
  let sessaoNovaViva = true;
  const estado = {
    app_metadata: { ...(opcoes.appMetadata ?? { email_verificacao: PEDIDO_EM_ABERTO }) } as Record<string, unknown>,
    senha: null as string | null,
  };
  const admin = {
    // A revogação do que a conta criou: `update(...).eq(...).is(...).select("id")`. Devolve `criados[tabela]` linhas.
    from: vi.fn((tabela: string) => ({
      update: (valores: Record<string, unknown>) => {
        const filtros: Array<[string, unknown]> = [];
        if (chamadas[chamadas.length - 1] !== "revogacao") chamadas.push("revogacao");
        revogacoes.push({ tabela, valores, filtros });
        const cadeia = {
          eq: (c: string, v: unknown) => (filtros.push([c, v]), cadeia),
          is: (c: string, v: unknown) => (filtros.push([c, v]), cadeia),
          select: async () => {
            if (opcoes.falharEm === "revogacao") return { data: null, error: { message: "x" } };
            const n = (opcoes.criados as Record<string, number | undefined> | undefined)?.[tabela] ?? 0;
            return { data: Array.from({ length: n }, (_, i) => ({ id: `${tabela}-${i}` })), error: null };
          },
        };
        return cadeia;
      },
    })),
    auth: {
      // A conferência de que a sessão nova ainda vale, depois de remover os fatores.
      getUser: vi.fn(async () =>
        sessaoNovaViva ? { data: { user: { id: "u" } }, error: null } : { data: { user: null }, error: { message: "session_not_found" } },
      ),
      admin: {
        getUserById: vi.fn(async () => ({
          data: { user: { id: "u", email: "v@example.com", app_metadata: { ...estado.app_metadata } } },
          error: null,
        })),
        updateUserById: vi.fn(
          async (_id: string, atributos: { password?: string; app_metadata?: Record<string, unknown> }) => {
            if (atributos.password !== undefined) {
              chamadas.push("senha");
              if (opcoes.falharEm === "senha") return { data: null, error: { message: "x" } };
              estado.senha = atributos.password;
              return { data: {}, error: null };
            }
            chamadas.push("carimbo");
            if (opcoes.falharEm === "gravacao") return { data: null, error: { message: "x" } };
            for (const [k, v] of Object.entries(atributos.app_metadata ?? {})) {
              if (v === null) delete estado.app_metadata[k];
              else estado.app_metadata[k] = v;
            }
            return { data: {}, error: null };
          },
        ),
        signOut: vi.fn(async () => {
          chamadas.push("sessoes");
          return opcoes.falharEm === "sessoes"
            ? { data: null, error: { message: "x" } }
            : { data: null, error: null };
        }),
        mfa: {
          listFactors: vi.fn(async () => {
            chamadas.push("fatores");
            if (opcoes.falharEm === "fatores") return { data: null, error: { message: "x" } };
            return { data: { factors: (opcoes.fatores ?? []).map((f) => ({ ...f })) }, error: null };
          }),
          deleteFactor: vi.fn(async ({ id }: { id: string }) => {
            removidos.push(id);
            if (opcoes.sessaoNovaMorreAoRemoverFator) sessaoNovaViva = false;
            return { data: { id }, error: null };
          }),
        },
      },
    },
  };
  // A troca de senha PELA SESSÃO nova (`supabase.auth.updateUser`): o que as rotas passam a `trocarSenhaDaSessao`.
  const trocarSenha = vi.fn(async (senha: string) => {
    chamadas.push("senha");
    if (opcoes.falharEm === "senha") return { error: { message: "x" } };
    estado.senha = senha;
    return { error: null };
  });
  const falso = { admin, chamadas, removidos, revogacoes, estado, trocarSenha };
  atual = falso;
  return falso;
}

let atual: { chamadas: string[]; trocarSenha: (senha: string) => Promise<{ error: unknown }> } | null = null;
/** O último GoTrue falso criado: os dublês de `supabase.auth.updateUser` das rotas o consultam. */
export const gotrueFalsoAtual = () => atual;

export type AdminFalso = ReturnType<typeof gotrueFalso>["admin"];
