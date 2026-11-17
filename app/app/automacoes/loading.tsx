import { Skeleton } from "@/components/ui/skeleton";

export default function AutomacoesLoading() {
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-72" />
      </div>
      <Skeleton className="h-10 w-full max-w-md" />
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    </div>
  );
}
