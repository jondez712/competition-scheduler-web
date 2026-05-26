export function selectDistributedSlots<T>(candidateSlots: readonly T[], routineCount: number): T[] {
  if (routineCount <= 0) return [];
  if (candidateSlots.length <= routineCount) return [...candidateSlots];
  if (routineCount === 1) return [candidateSlots[0]!];

  const lastIndex = candidateSlots.length - 1;
  const indexes = new Set<number>();
  for (let i = 0; i < routineCount; i++) {
    indexes.add(Math.round((i * lastIndex) / (routineCount - 1)));
  }

  for (let i = 0; indexes.size < routineCount && i < candidateSlots.length; i++) {
    indexes.add(i);
  }

  return [...indexes]
    .sort((a, b) => a - b)
    .map((index) => candidateSlots[index]!);
}
