/**
 * O mod-11 da Receita Federal — a regra brasileira, e a única do repositório
 * que confere dígito verificador. Mora num módulo próprio porque o perfil do país
 * (`perfil-do-pais.ts`) e os tipos de documento (`tipos-de-documento.ts`) o
 * usam, e cada um re-exporta ou importa daqui sem ciclo.
 */
export function isValidCpf(raw: string): boolean {
  const s = raw.replace(/\D/g, "");
  if (!/^\d{11}$/.test(s) || /^(\d)\1{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(s[i]!, 10) * (10 - i);
  let d1 = (sum * 10) % 11;
  if (d1 === 10) d1 = 0;
  if (d1 !== parseInt(s[9]!, 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(s[i]!, 10) * (11 - i);
  let d2 = (sum * 10) % 11;
  if (d2 === 10) d2 = 0;
  return d2 === parseInt(s[10]!, 10);
}

