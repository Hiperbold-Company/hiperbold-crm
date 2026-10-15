/**
 * Um `auth.admin` falso, com memória: guarda os usuários e aplica `updateUserById` como o GoTrue faz: o
 * `app_metadata` enviado é MESCLADO com o existente, chave ausente permanece e só o `null` explícito a
 * remove. (Antes o falso substituía o objeto inteiro, e um código que apagava a chave em vez de enviar
 * `null` passava nos testes e deixava o dado gravado no provedor de verdade.) Serve aos testes da
 * verificação de e-mail, que dependem do que fica gravado entre uma chamada e a outra.
 */
export interface UsuarioFalso {
  id: string;
  email: string | null;
  app_metadata: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
}

export function criarAuthAdminFalso(inicial: UsuarioFalso[] = []) {
  const usuarios = new Map<string, UsuarioFalso>(
    inicial.map((u) => [u.id, { ...u, app_metadata: { ...u.app_metadata } }]),
  );
  const escritas: Array<{ id: string; app_metadata: Record<string, unknown> }> = [];
  let falharAoGravar = false;

  const cliente = {
    auth: {
      admin: {
        getUserById: async (id: string) => {
          const u = usuarios.get(id);
          return u
            ? { data: { user: { ...u, app_metadata: { ...u.app_metadata } } }, error: null }
            : { data: { user: null }, error: { message: "User not found" } };
        },
        updateUserById: async (id: string, attrs: { app_metadata?: Record<string, unknown> }) => {
          if (falharAoGravar) return { data: { user: null }, error: { message: "boom" } };
          const u = usuarios.get(id);
          if (!u) return { data: { user: null }, error: { message: "User not found" } };
          if (attrs.app_metadata) {
            const mesclado: Record<string, unknown> = { ...u.app_metadata };
            for (const [k, v] of Object.entries(JSON.parse(JSON.stringify(attrs.app_metadata)) as Record<string, unknown>)) {
              if (v === null) delete mesclado[k];
              else mesclado[k] = v;
            }
            u.app_metadata = mesclado;
            escritas.push({ id, app_metadata: u.app_metadata });
          }
          return { data: { user: u }, error: null };
        },
      },
    },
  };

  return {
    cliente: cliente as never,
    /** O mesmo cliente, tipado, para `vi.spyOn` e afins. */
    bruto: cliente,
    usuarios,
    escritas,
    appMetadata: (id: string) => usuarios.get(id)?.app_metadata ?? {},
    falharGravacao: (v: boolean) => {
      falharAoGravar = v;
    },
  };
}
