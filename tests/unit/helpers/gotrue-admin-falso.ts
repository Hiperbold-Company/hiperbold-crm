/**
 * Um GoTrue administrativo falso, só com o que a reassunção de conta usa (D-204): ler e gravar o usuário
 * (`app_metadata`), trocar a senha, listar e remover fatores de MFA e derrubar sessões. Guarda a ORDEM em que as
 * operações chegam (`chamadas`), porque a ordem é a segurança. É a borda do provedor, não o código sob teste.
 */
import { vi } from "vitest";

export type EtapaQuePodeFalhar = "senha" | "fatores" | "sessoes" | "gravacao";

export interface OpcoesDoGotrueFalso {
  falharEm?: EtapaQuePodeFalhar;
  /** Fatores de MFA que a conta tem. */
  fatores?: Array<{ id: string; status: "verified" | "unverified" }>;
  /** `app_metadata` inicial. Padrão: pedido de verificação em aberto. */
  appMetadata?: Record<string, unknown>;
}

export const PEDIDO_EM_ABERTO = { hash: "h", expira_em: "2099-01-01T00:00:00Z", enviado_em: "2026-10-17T00:00:00Z" };

export function gotrueFalso(opcoes: OpcoesDoGotrueFalso = {}) {
  const chamadas: string[] = [];
  const removidos: string[] = [];
  const estado = {
    app_metadata: { ...(opcoes.appMetadata ?? { email_verificacao: PEDIDO_EM_ABERTO }) } as Record<string, unknown>,
    senha: null as string | null,
  };
  const admin = {
    auth: {
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
            return { data: { id }, error: null };
          }),
        },
      },
    },
  };
  return { admin, chamadas, removidos, estado };
}

export type AdminFalso = ReturnType<typeof gotrueFalso>["admin"];
