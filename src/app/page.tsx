import Link from "next/link";
import { COMPETITIONS } from "@/lib/competitions";

export default function Home() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-8 px-4 py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Competition scheduler
        </h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Pick an event. You can open the published schedule in the timeline or start from the planner
          to map days and stages.
        </p>
      </header>
      <ul className="flex flex-col divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {COMPETITIONS.map((c) => (
          <li key={c.id}>
            <Link
              href={`/competition/${c.id}`}
              className="flex items-center justify-between px-4 py-3 text-zinc-900 hover:bg-zinc-50 dark:text-zinc-100 dark:hover:bg-zinc-900/60"
            >
              <span className="font-medium">{c.name}</span>
              <span className="font-mono text-sm text-zinc-500">{c.id}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
