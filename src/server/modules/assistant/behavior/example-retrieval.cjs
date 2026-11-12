const { fold, tokens, hints, features, documentProfile } = require('./example-features.cjs');
function tokenCounts(words) {
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
  return counts;
}
function indexRows(rows, profileFor = (row) => documentProfile(row.example)) {
  const frequency = new Map();
  const documents = rows.map((row) => {
    const profile = profileFor(row),
      counts = profile.counts ?? tokenCounts(profile.tokens);
    for (const word of counts.keys()) frequency.set(word, (frequency.get(word) || 0) + 1);
    return { ...row, ...profile, counts, length: profile.tokens.length };
  });
  return {
    documents,
    frequency,
    averageLength:
      documents.reduce((sum, row) => sum + row.length, 0) / Math.max(1, documents.length),
  };
}
function scoreRows(index, text, context = {}) {
  const queryText = fold(text).replace(/\s+/gu, ' ').trim(),
    query = new Set(tokens(text)),
    tasks = hints(text),
    wanted = features(text, null, context.clock);
  const total = index.documents.length;
  const ranked = index.documents
    .map((row) => {
      let lexical = 0;
      for (const word of query) {
        const count = row.counts.get(word) || 0;
        if (!count) continue;
        const frequency = index.frequency.get(word) || 0;
        const idf = Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5));
        const norm = 1.2 * (0.25 + (0.75 * row.length) / Math.max(1, index.averageLength));
        lexical += (idf * count * 2.2) / (count + norm);
      }
      const task = Math.max(tasks.get(row.intent) || 0, row.routeBoundary === true ? 1 : 0);
      let shared = 0;
      for (const item of wanted) if (row.features.has(item)) shared++;
      const exactMatch = Boolean(
        queryText &&
        queryText === (row.normalizedText ?? fold(row.example.text).replace(/\s+/gu, ' ').trim()),
      );
      const relevant = lexical > 0 || task > 0 || exactMatch;
      const score = relevant
        ? lexical +
          task * 3 +
          shared * 0.2 +
          (exactMatch ? 1 : 0) +
          (row.source === 'custom' ? 0.45 : 0)
        : 0;
      return { ...row, score, task, exactMatch, wanted };
    })
    .filter((row) => row.score > 0);
  ranked.sort((a, b) => b.score - a.score || a.order - b.order || a.id.localeCompare(b.id));
  return ranked;
}
function redundancy(left, right) {
  const a = left.words,
    b = right.words;
  let shared = 0;
  for (const word of a.keys()) if (b.has(word)) shared++;
  return shared / Math.max(1, a.size + b.size - shared);
}
function resultShape(expected) {
  return JSON.stringify(
    Object.keys(expected)
      .filter((key) => expected[key] !== null && expected[key] !== undefined)
      .sort(),
  );
}
function packRows(ranked, { maxCount, maxBytes, maxWireBytes = Infinity }) {
  const chosen = [],
    selected = [],
    covered = new Set(),
    coveredFeatures = new Set();
  const best = ranked[0]?.score || 0;
  let bytes = 2,
    wireBytes = 2;
  // Keep exact phrases and recognized tasks available to the coverage stage even
  // when common vocabulary gives them a lower BM25 score than rarer tasks.
  const candidates = ranked
    .filter((row) => row.exactMatch || row.task > 0 || row.score >= Math.max(0.65, best * 0.22))
    .map((row) => {
      const encoded = JSON.stringify(row.example);
      return {
        row,
        words: row.counts ?? new Set(row.tokens),
        exampleBytes: Buffer.byteLength(encoded, 'utf8'),
        wire: Number.isFinite(maxWireBytes)
          ? Buffer.byteLength(JSON.stringify(encoded), 'utf8') - 2
          : 0,
      };
    });
  while (candidates.length && chosen.length < maxCount) {
    let winner = -1,
      utility = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const { row, exampleBytes, wire } = candidates[i];
      const separator = chosen.length ? 1 : 0;
      if (
        bytes + exampleBytes + separator > maxBytes ||
        wireBytes + wire + separator > maxWireBytes
      )
        continue;
      let similarity = 0;
      let duplicate = false;
      for (const previous of selected) {
        const overlap = redundancy(candidates[i], previous);
        // Do not spend the prompt on near-identical phrasing with the same result shape.
        if (
          previous.row.intent === row.intent &&
          overlap > 0.9 &&
          resultShape(previous.row.example.expected) === resultShape(row.example.expected)
        ) {
          duplicate = true;
          break;
        }
        similarity = Math.max(similarity, overlap);
      }
      if (duplicate) continue;
      let newFeatures = 0;
      for (const feature of row.wanted)
        if (row.features.has(feature) && !coveredFeatures.has(feature)) newFeatures++;
      const value =
        (0.72 * row.score) / best -
        0.28 * similarity +
        (row.task && !covered.has(row.intent) ? 0.18 : 0) +
        Math.min(0.12, newFeatures * 0.04);
      if (value > utility) {
        winner = i;
        utility = value;
      }
    }
    if (winner < 0) break;
    const candidate = candidates.splice(winner, 1)[0];
    const { row, exampleBytes, wire } = candidate;
    const separator = chosen.length ? 1 : 0;
    bytes += exampleBytes + separator;
    wireBytes += wire + separator;
    chosen.push(row.example);
    selected.push(candidate);
    covered.add(row.intent);
    for (const feature of row.features) coveredFeatures.add(feature);
  }
  return { examples: chosen, selected: selected.map(({ row }) => row), bytes };
}
module.exports = { indexRows, scoreRows, packRows, tokenCounts };
