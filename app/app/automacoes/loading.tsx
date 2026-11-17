import { Skeleton } from "@/components/ui/skeleton";

/**
 * Esqueleto genérico (título + blocos): vale também para as subrotas, que não
 * têm loading.tsx próprio, então não imita o formato de uma tela só.
 */
export default function AutomacoesLoading() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}
