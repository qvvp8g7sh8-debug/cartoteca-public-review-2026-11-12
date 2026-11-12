const fs = require('node:fs');
const path = require('node:path');

async function setCssViewport(page, width, height = 900) {
  await page.setViewportSize({ width, height });
  // Windows WebKit can apply host DPI. Always confirm the CSS size, including popups.
  for (let attempt = 0; attempt < 2; attempt++) {
    const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (Math.abs(actual.width - width) <= 1 && Math.abs(actual.height - height) <= 1) {
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(finish, 250);
            requestAnimationFrame(() => requestAnimationFrame(finish));
          }),
      );
      return;
    }
    const current = page.viewportSize();
    await page.setViewportSize({
      width: Math.round((current.width * width) / actual.width),
      height: Math.round((current.height * height) / actual.height),
    });
  }
  throw Error(`Incorrect CSS viewport: expected ${width}x${height}`);
}

// Execute actions once per responsive mode. Measure the same state at every width.
// Appearance failures are recorded independently and do not swallow functional failures.
function createChecks({ page, width, layoutWidths, record, layout }) {
  let scenario, checkpoint, functionalMetadata;
  const check = async (name, run) => {
    scenario = name;
    checkpoint = 0;
    functionalMetadata = {
      category: 'functional',
      width,
      flowWidth: width,
      appearanceDurationMs: 0,
    };
    try {
      return await record(name, run, functionalMetadata);
    } finally {
      scenario = null;
    }
  };
  check.appearance = async (name, inspect, target = page) => {
    if (!scenario) throw Error('Appearance check requires an active scenario');
    const label = `${scenario}/${++checkpoint}-${name}`;
    const started = Date.now();
    const original = target.viewportSize();
    const scroll = await target.evaluate(() => ({ x: scrollX, y: scrollY }));
    try {
      for (const measuredWidth of layoutWidths) {
        await record(
          label,
          async () => {
            await setCssViewport(target, measuredWidth);
            await inspect(target, measuredWidth);
          },
          { category: 'appearance', width: measuredWidth, flowWidth: width },
        );
      }
    } finally {
      // A failed measurement must not leave the next business action at another width.
      try {
        await target.setViewportSize(original);
        await target.evaluate(
          ({ x, y }) =>
            new Promise((resolve) => {
              const finish = () => {
                clearTimeout(timer);
                scrollTo(x, y);
                resolve();
              };
              const timer = setTimeout(finish, 250);
              requestAnimationFrame(() => requestAnimationFrame(finish));
            }),
          scroll,
        );
      } finally {
        functionalMetadata.appearanceDurationMs += Date.now() - started;
      }
    }
  };
  check.layout = (target, selector) =>
    check.appearance(selector || 'page', (current) => layout(current, selector), target);
  return check;
}

function writeReports(output, results) {
  for (const category of ['functional', 'appearance'])
    fs.writeFileSync(
      path.join(output, category + '.json'),
      JSON.stringify(
        results.filter((row) => row.category === category),
        null,
        2,
      ),
    );
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
}

module.exports = { createChecks, setCssViewport, writeReports };
