// Dependency-free build helper. Keep all CSS tokens; trim ASCII indentation only
// after structural separators. Quoted, grouped and custom-property values stay raw.
const isWhitespace = (char) => /[\t\n\f\r ]/.test(char || '');
const isName = (char) => /[A-Za-z0-9_-]/.test(char || '') || char?.charCodeAt(0) >= 128;

function escapeEnd(source, start) {
  let end = start + 1;
  if (/[0-9a-f]/i.test(source[end] || '')) {
    const first = end;
    while (end - first < 6 && /[0-9a-f]/i.test(source[end] || '')) end++;
    const code = parseInt(source.slice(first, end), 16);
    if (isWhitespace(source[end])) {
      if (source[end] === '\r' && source[end + 1] === '\n') end++;
      end++;
    }
    return { end, name: code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd' };
  }
  if (source[end] === '\r' && source[end + 1] === '\n') end++;
  return { end: Math.min(source.length, end + 1), name: source[start + 1] || '' };
}

function unquotedUrlEnd(source, start) {
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') index = escapeEnd(source, index).end - 1;
    else if (source[index] === ')') return index + 1;
  }
  throw Error('Unclosed CSS url()');
}

function compactStyles(source) {
  let output = '',
    quote = '',
    identifier = '',
    trim = false;
  let parentheses = 0,
    brackets = 0,
    blocks = 0,
    custom = false,
    customBraces = 0;
  let property = '',
    propertyPossible = true,
    propertyEnded = false;
  const resetProperty = () => {
    property = '';
    propertyPossible = true;
    propertyEnded = false;
  };
  const propertyName = (name) => {
    if (propertyEnded) propertyPossible = false;
    property += name;
  };
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (char === '\\') {
      const escaped = escapeEnd(source, index);
      output += source.slice(index, escaped.end);
      if (!quote) {
        identifier += escaped.name;
        if (!parentheses && !brackets && !custom) propertyName(escaped.name);
      }
      index = escaped.end;
      trim = false;
      continue;
    }
    if (quote) {
      output += char;
      if (char === quote) quote = '';
      index++;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) throw Error('Unclosed CSS comment');
      output += source.slice(index, end + 2);
      identifier = '';
      if (property) propertyEnded = true;
      trim = false;
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      identifier = '';
      propertyPossible = false;
      trim = false;
      output += char;
      index++;
      continue;
    }
    if (isWhitespace(char)) {
      if (!(trim && !parentheses && !brackets && !custom)) output += char;
      identifier = '';
      if (!parentheses && !brackets && !custom && property) propertyEnded = true;
      index++;
      continue;
    }
    trim = false;
    if (char === '(') {
      let next = index + 1;
      while (isWhitespace(source[next])) next++;
      if (identifier.toLowerCase() === 'url' && !['"', "'"].includes(source[next])) {
        const end = unquotedUrlEnd(source, index);
        output += source.slice(index, end);
        identifier = '';
        propertyPossible = false;
        index = end;
        continue;
      }
      parentheses++;
    } else if (char === ')') parentheses--;
    else if (char === '[') brackets++;
    else if (char === ']') brackets--;
    else if (!parentheses && !brackets) {
      if (custom) {
        if (char === '{') customBraces++;
        else if (char === '}' && customBraces) customBraces--;
        else if (char === ';' && !customBraces) {
          custom = false;
          resetProperty();
          trim = true;
        } else if (char === '}' && !customBraces) {
          custom = false;
          blocks--;
          resetProperty();
          trim = true;
        }
      } else if (char === '{' || char === '}' || char === ';') {
        if (char === '{') blocks++;
        if (char === '}') blocks--;
        resetProperty();
        trim = true;
      } else if (char === ':') {
        custom = blocks > 0 && propertyPossible && property.startsWith('--');
        propertyPossible = false;
      } else if (isName(char)) propertyName(char);
      else propertyPossible = false;
    }
    output += char;
    identifier = isName(char) ? identifier + char : '';
    index++;
  }
  if (quote || parentheses || brackets || blocks || customBraces)
    throw Error('Unclosed CSS token or block');
  return output;
}

module.exports = { compactStyles };
