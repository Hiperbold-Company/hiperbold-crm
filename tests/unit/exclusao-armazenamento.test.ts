import { describe, expect, it, vi } from "vitest";

import { apagarArquivosDaOrganizacao } from "@/lib/retencao/exclusao-de-organizacao/armazenamento";

const ORG = "11111111-2222-4333-8444-555555555555";
const OUTRA = "99999999-2222-4333-8444-555555555555";

/** Um Storage falso: pastas por caminho, arquivo tem id, pasta não. */
function storageFalso(arvore: Record<string, Record<string, { name: string; id: string | null }[]>>, opcoes: { falhaRemocao?: boolean } = {}) {
  const removidos: { bucket: string; caminhos: string[] }[] = [];
  const admin = {
    storage: {
      listBuckets: async () => ({ data: Object.keys(arvore).map((id) => ({ id })), error: null }),
      from: (bucket: string) => ({
        list: async (pasta: string, o: { limit: number; offset: number }) => ({
          data: (arvore[bucket]?.[pasta] ?? []).slice(o.offset, o.offset + o.limit),
          error: null,
        }),
        remove: async (caminhos: string[]) => {
          if (opcoes.falhaRemocao) return { error: { message: "boom" } };
          removidos.push({ bucket, caminhos });
          return { error: null };
        },
      }),
    },
  };
  return { admin: admin as never, removidos };
}

describe("apagar os arquivos de uma organização", () => {
  it("entra só na pasta da organização, recursivamente, em todo bucket, e nunca toca a de outra", async () => {
    const { admin, removidos } = storageFalso({
      "whatsapp-media": {
        [ORG]: [{ name: "conv-1", id: null }, { name: "avatars", id: null }],
        [`${ORG}/conv-1`]: [{ name: "a.jpg", id: "x1" }],
        [`${ORG}/avatars`]: [{ name: "c.jpg", id: "x2" }],
        [OUTRA]: [{ name: "intocavel.jpg", id: "y1" }],
      },
      "org-sounds": { [ORG]: [{ name: "som.mp3", id: "x3" }] },
    });
    const r = await apagarArquivosDaOrganizacao(admin, ORG);
    expect(r).toEqual({ ok: true, apagados: 3 });
    const todos = removidos.flatMap((x) => x.caminhos);
    expect(todos.sort()).toEqual([`${ORG}/avatars/c.jpg`, `${ORG}/conv-1/a.jpg`, `${ORG}/som.mp3`].sort());
    expect(todos.every((c) => c.startsWith(`${ORG}/`))).toBe(true);
  });

  it("organização sem arquivo: ok com zero", async () => {
    const { admin } = storageFalso({ "whatsapp-media": {} });
    expect(await apagarArquivosDaOrganizacao(admin, ORG)).toEqual({ ok: true, apagados: 0 });
  });

  it("id que não é um uuid inteiro é recusado (um prefixo parcial varreria o bucket de todos)", async () => {
    const { admin, removidos } = storageFalso({ "whatsapp-media": { "": [{ name: "x", id: "1" }] } });
    for (const ruim of ["", "1111", "../", `${ORG}/`]) {
      expect(await apagarArquivosDaOrganizacao(admin, ruim)).toMatchObject({ ok: false, motivo: "organizacao_invalida" });
    }
    expect(removidos).toHaveLength(0);
  });

  it("remoção que falha devolve ok:false (a exclusão do banco não deve seguir)", async () => {
    const { admin } = storageFalso({ "whatsapp-media": { [ORG]: [{ name: "a", id: "1" }] } }, { falhaRemocao: true });
    expect(await apagarArquivosDaOrganizacao(admin, ORG)).toMatchObject({ ok: false });
  });
});
