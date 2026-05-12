import { Suspense } from "react";
import { CompetitionClient } from "@/components/schedule/CompetitionClient";

type PageProps = { params: Promise<{ id: string }> };

export default async function CompetitionPage({ params }: PageProps) {
  const { id } = await params;
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) {
    return (
      <div className="p-8">
        <p className="text-red-600">Invalid competition id.</p>
      </div>
    );
  }
  return (
    <Suspense
      fallback={<div className="mx-auto max-w-[1920px] p-8 text-zinc-500">Loading event…</div>}
    >
      <CompetitionClient key={n} competitionId={n} />
    </Suspense>
  );
}
