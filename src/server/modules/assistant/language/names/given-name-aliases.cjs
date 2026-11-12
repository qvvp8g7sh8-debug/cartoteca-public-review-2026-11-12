// Declared search aliases only. Formal names never merge through a shared short form.
const aliases = Object.freeze({
  юлия: ['юля'],
  ольга: ['оля'],
  екатерина: ['катя'],
  елена: ['лена'],
  анастасия: ['настя'],
  анна: ['аня'],
  татьяна: ['таня'],
  мария: ['маша'],
  дарья: ['даша'],
  светлана: ['света'],
  людмила: ['люда'],
  любовь: ['люба'],
  надежда: ['надя'],
  елизавета: ['лиза'],
  ирина: ['ира'],
  маргарита: ['рита'],
  виктория: ['вика'],
  галина: ['галя'],
  ксения: ['ксюша'],
  наталья: ['наташа'],
  наталия: ['наташа'],
  софия: ['соня'],
  софья: ['соня'],
  александр: ['саша', 'шура'],
  александра: ['саша', 'шура'],
  евгений: ['женя'],
  евгения: ['женя'],
  валентин: ['валя'],
  валентина: ['валя'],
  алексей: ['леша', 'алеша'],
  михаил: ['миша'],
  павел: ['паша'],
  дмитрий: ['дима'],
  иван: ['ваня'],
  петр: ['петя'],
  николай: ['коля'],
  сергей: ['сережа'],
});
const byShort = new Map();
for (const [canonical, names] of Object.entries(aliases))
  for (const name of names) {
    if (!byShort.has(name)) byShort.set(name, []);
    byShort.get(name).push(canonical);
  }
const shortGivenNames = Object.freeze([...byShort.keys()]);
function givenNameBases(word) {
  if (Object.hasOwn(aliases, word)) return [word, ...aliases[word]];
  const canonical = byShort.get(word);
  return canonical
    ? [...new Set([word, ...canonical, ...canonical.flatMap((name) => aliases[name])])]
    : [word];
}
module.exports = { shortGivenNames, givenNameBases };
