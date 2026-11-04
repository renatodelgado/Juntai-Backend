import { Profile } from './contracts';

// Shuffle only ties: a lower score must never displace a higher score.
export function selectHighlights(items: Profile[], limit = 3, random = Math.random): Profile[] {
  const score = (item: Profile) => item.probabilidadeInteresse ?? item.scoreRanking ?? item.score ?? -1;
  const ranked = [...items].sort((a, b) => score(b) - score(a));
  for (let start = 0; start < ranked.length && start < limit;) {
    let end = start + 1;
    while (end < ranked.length && score(ranked[end]) === score(ranked[start])) end++;
    for (let index = end - 1; index > start; index--) {
      const other = start + Math.floor(random() * (index - start + 1));
      [ranked[index], ranked[other]] = [ranked[other], ranked[index]];
    }
    start = end;
  }
  return ranked.slice(0, limit);
}
