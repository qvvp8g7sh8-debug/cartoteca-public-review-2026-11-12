// One coverage contract shared by release planning and the browser runners.
const widths = { main: [320, 390, 412, 768, 1440], admin: [320, 390, 412, 768, 1024, 1440] };

function groups(suite, requested = widths[suite]) {
  if (!widths[suite]) throw Error('Unknown browser suite');
  const values = typeof requested === 'string' ? requested.split(',').map(Number) : requested;
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.some((width) => !Number.isInteger(width) || width < 280 || width > 4000) ||
    new Set(values).size !== values.length
  )
    throw Error('Invalid viewport widths');
  return [true, false].flatMap((mobile) => {
    const layoutWidths = values.filter((width) => width < 700 === mobile).sort((a, b) => a - b);
    if (!layoutWidths.length) return [];
    const preferred = mobile ? 390 : 1440;
    return [
      {
        mode: mobile ? 'mobile' : 'desktop',
        width: layoutWidths.includes(preferred) ? preferred : layoutWidths[0],
        layoutWidths,
      },
    ];
  });
}

module.exports = { widths, groups };
