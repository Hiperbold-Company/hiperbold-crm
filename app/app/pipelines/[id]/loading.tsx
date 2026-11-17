import { Skeleton } from "@/components/ui/skeleton";

export default function PipelineLoading() {
  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between gap-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-9 w-40" />
      </div>
      <div className="flex gap-4 overflow-x-auto">
        {Array.from({ length: 5 }).map((_, col) => (
          <div key={col} className="w-72 shrink-0 space-y-3">
            <Skeleton className="h-6 w-32" />
            {Array.from({ length: 3 }).map((_, card) => (
              <Skeleton key={card} className="h-24 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
