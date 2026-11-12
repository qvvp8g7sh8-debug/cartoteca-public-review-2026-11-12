const assert = require('node:assert/strict');

async function checkLayout(page, dialogSelector) {
  const issue = await page.evaluate((selector) => {
    const width = innerWidth;
    if (document.documentElement.scrollWidth > width + 1) {
      const overflow = [...document.querySelectorAll('body *')]
        .filter(
          (element) =>
            element.getClientRects().length && element.getBoundingClientRect().right > width + 1,
        )
        .map((element) => {
          const style = getComputedStyle(element);
          return `${element.tagName}#${element.id}.${String(element.className)}: right=${Math.round(element.getBoundingClientRect().right)}, width=${style.width}, min=${style.minWidth}, display=${style.display}`;
        })
        .slice(0, 8);
      return `Document overflow: ${document.documentElement.scrollWidth} > ${width}; ${overflow.join(', ')}`;
    }
    if (!selector) return '';
    const dialog = document.querySelector(selector),
      box = dialog.getBoundingClientRect();
    if (box.left < -1 || box.right > width + 1 || box.top < -1 || box.bottom > innerHeight + 1)
      return `Dialog outside viewport: ${JSON.stringify(box.toJSON())}`;
    for (const element of dialog.querySelectorAll(
      'input:not([type=hidden]),select,textarea,button',
    )) {
      if (!element.getClientRects().length) continue;
      // Closed details can retain layout rectangles while their contents are not painted.
      const popover = element.closest('[popover]');
      const topLayer = popover?.showPopover && popover.matches(':popover-open');
      if (
        !topLayer &&
        element.checkVisibility &&
        !element.checkVisibility({ checkVisibilityCSS: true })
      )
        continue;
      let closed = element.closest('details:not([open])');
      while (closed) {
        // A top-layer popover can escape a closed outer details, not its own collapsed groups.
        if (topLayer && closed.contains(popover)) {
          closed = null;
          break;
        }
        if (!closed.querySelector(':scope > summary')?.contains(element)) break;
        closed = closed.parentElement?.closest('details:not([open])');
      }
      if (closed) continue;
      const rect = element.getBoundingClientRect();
      const sheet = element.closest(
        '#appointment-service[data-service-window][open] .appointment-service-menu',
      );
      const bounds = sheet ? sheet.getBoundingClientRect() : box;
      if (
        sheet &&
        (bounds.left < -1 ||
          bounds.right > width + 1 ||
          bounds.top < -1 ||
          bounds.bottom > innerHeight + 1 ||
          bounds.left < box.left - 1 ||
          bounds.right > box.right + 1)
      )
        return 'Service window outside viewport or editor';
      let visibleTop = rect.top,
        visibleBottom = rect.bottom;
      if (sheet)
        for (
          let parent = element.parentElement;
          parent && parent !== sheet;
          parent = parent.parentElement
        ) {
          if (!/^(auto|scroll|hidden|clip)$/.test(getComputedStyle(parent).overflowY)) continue;
          const clip = parent.getBoundingClientRect();
          visibleTop = Math.max(visibleTop, clip.top);
          visibleBottom = Math.min(visibleBottom, clip.bottom);
        }
      if (
        rect.left < bounds.left - 1 ||
        rect.right > bounds.right + 1 ||
        (sheet &&
          visibleTop < visibleBottom &&
          (visibleTop < bounds.top - 1 || visibleBottom > bounds.bottom + 1))
      )
        return `Control overflow: ${element.id || element.name || element.textContent.trim()}`;
    }
    return '';
  }, dialogSelector);
  assert.equal(issue, '');
  if (
    dialogSelector &&
    process.env.CARTOTECA_BROWSER_SCREENSHOTS === '1' &&
    (await page.evaluate(() => innerWidth)) === 390 &&
    process.env.CARTOTECA_BROWSER_REPORT
  ) {
    const title = await page
      .locator(`${dialogSelector} h2,${dialogSelector} h3`)
      .first()
      .textContent();
    const file = `${page.context().browser().browserType().name()}-390-${title.replace(/[^\p{L}\p{N}-]/gu, '-')}.png`;
    await page.screenshot({
      path: require('node:path').join(process.env.CARTOTECA_BROWSER_REPORT, file),
    });
  }
}
async function installBanner(page) {
  const install = page.locator('.install-app');
  const banner = await install.boundingBox();
  const nav = await page.locator('.topbar').boundingBox();
  const add = await page.locator('#calendar-new').boundingBox();
  if ((await page.evaluate(() => innerWidth)) <= 700) {
    assert.ok(banner.y + banner.height <= nav.y);
    assert.ok(banner.y + banner.height <= add.y);
  }
}

// Page forms may extend below the viewport. Their controls must stay within the
// form's horizontal bounds and remain reachable through the real scroll chain.
// Modal dialogs deliberately keep the stricter checkLayout viewport contract.
async function inlineForm(page, selector) {
  await checkLayout(page);
  const form = page.locator(selector);
  const scroll = await form.evaluate((element) => {
    if (element.tagName !== 'FORM' || element.closest('dialog'))
      throw Error('Inline form check requires a non-modal form');
    const positions = [];
    for (let node = element; node; node = node.parentElement)
      positions.push({ left: node.scrollLeft, top: node.scrollTop });
    return positions;
  });
  try {
    const controls = form.locator('input:not([type=hidden]),select,textarea,button');
    let visible = 0;
    for (let index = 0; index < (await controls.count()); index++) {
      const control = controls.nth(index);
      if (!(await control.isVisible())) continue;
      visible++;
      await control.evaluate((element) =>
        element.scrollIntoView({ block: 'center', inline: 'nearest' }),
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const issue = await control.evaluate((element) => {
        const box = element.getBoundingClientRect(),
          formBox = element.closest('form').getBoundingClientRect(),
          label = element.id || element.name || element.textContent.trim();
        if (
          box.left < formBox.left - 1 ||
          box.right > formBox.right + 1 ||
          box.left < -1 ||
          box.right > innerWidth + 1
        )
          return 'Inline form control overflow: ' + label;
        const x = box.left + box.width / 2,
          y = box.top + box.height / 2;
        if (y < 0 || y >= innerHeight || !element.contains(document.elementFromPoint(x, y)))
          return 'Inline form control is unreachable after scrolling: ' + label;
        return '';
      });
      assert.equal(issue, '');
    }
    assert.ok(visible > 0, 'Inline form must expose controls');
  } finally {
    await form.evaluate((element, positions) => {
      const nodes = [];
      for (let node = element; node; node = node.parentElement) nodes.push(node);
      // Restore outer and inner scroll containers, not just window.scrollY.
      for (let index = nodes.length - 1; index >= 0; index--)
        nodes[index].scrollTo(positions[index].left, positions[index].top);
    }, scroll);
  }
}

async function earlyHours(page) {
  // Background refresh can replace this control; sample a connected node atomically.
  const geometry = await page.waitForFunction(() => {
    const control = document.querySelector('.early-hours-control [data-toggle-early-hours]');
    if (!control?.isConnected) return false;
    const rect = control.getBoundingClientRect();
    return rect.width && rect.height
      ? { ...rect.toJSON(), viewport: innerWidth, heightLimit: innerHeight }
      : false;
  });
  const bounds = await geometry.jsonValue();
  await geometry.dispose();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= bounds.viewport + 1);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= bounds.heightLimit + 1);
  if (bounds.viewport <= 700) assert.ok(bounds.width < bounds.viewport - 24);
}

async function helpTargets(page) {
  const buttons = page.locator('.settings-label-row [data-settings-help]:visible');
  for (let index = 0; index < (await buttons.count()); index++) {
    const geometry = await buttons.nth(index).evaluate((el) => {
      const row = el.closest('.settings-label-row');
      const text = [...row.children].find(
        (child) =>
          !child.contains(el) &&
          !child.matches('.checkbox-hit-area') &&
          child.textContent.trim() &&
          child.getBoundingClientRect().width,
      );
      const label = text.getBoundingClientRect(),
        button = el.getBoundingClientRect();
      return {
        gap: button.left - label.right,
        width: button.width,
        height: button.height,
        label: text.textContent,
      };
    });
    assert.ok(
      geometry.gap >= -1 && geometry.gap <= 14,
      `Help is too far from text: ${JSON.stringify(geometry)}`,
    );
    assert.ok(geometry.width >= 36 && geometry.height >= 36, 'Help touch target is too small');
  }
}

async function maxStatus(page) {
  assert.ok(
    await page.locator('.max-invitation-status').evaluate((el) => {
      const box = el.getBoundingClientRect();
      return (
        el.closest('dialog').matches(':modal') &&
        el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      );
    }),
  );
}

async function adminLayout(page) {
  const sizes = await page.evaluate(async () => {
    const controls = [...document.querySelectorAll('input,select,textarea,button')];
    // Only the documented mobile admin strip may contain offscreen controls.
    // It must still prove real scroll reachability, not just match a selector.
    const navs =
      innerWidth <= 760
        ? [...document.querySelectorAll('.admin-page nav.admin-tabs')].filter(
            (nav) =>
              /^(auto|scroll)$/.test(getComputedStyle(nav).overflowX) &&
              nav.scrollWidth > nav.clientWidth + 1 &&
              nav.clientWidth > 0,
          )
        : [];
    const navFor = (element) =>
      element.matches('button[data-admin-view]') ? navs.find((nav) => nav.contains(element)) : null;
    const sizes = {
      width: innerWidth,
      body: document.documentElement.scrollWidth,
      broken: controls
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width && !navFor(element) && (box.right > innerWidth + 1 || box.left < -1);
        })
        .map((element) => element.id || element.name || element.textContent),
      navIssue: '',
    };
    const owners = [],
      seen = new Set();
    for (const element of controls.filter((control) => navFor(control))) {
      const chain = [];
      for (let node = element; node; node = node.parentElement) chain.unshift(node);
      if (document.scrollingElement && !chain.includes(document.scrollingElement))
        chain.unshift(document.scrollingElement);
      for (const node of chain) {
        if (seen.has(node)) continue;
        seen.add(node);
        owners.push({ node, left: node.scrollLeft, top: node.scrollTop });
      }
    }
    const original = { x: scrollX, y: scrollY };
    try {
      for (const element of controls) {
        const nav = navFor(element);
        if (!nav || !element.getBoundingClientRect().width) continue;
        const label = element.id || element.name || element.textContent;
        element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
        await new Promise((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(finish, 250);
          requestAnimationFrame(() => requestAnimationFrame(finish));
        });
        const box = element.getBoundingClientRect(),
          frame = nav.getBoundingClientRect();
        const left = frame.left + nav.clientLeft,
          right = left + nav.clientWidth;
        if (
          !element.isConnected ||
          !nav.isConnected ||
          frame.width <= 0 ||
          frame.left < -1 ||
          frame.right > innerWidth + 1 ||
          box.left < left - 1 ||
          box.right > right + 1 ||
          box.left < -1 ||
          box.right > innerWidth + 1
        ) {
          sizes.navIssue = 'Admin navigation overflow after scrolling: ' + label;
          break;
        }
        const x = box.left + box.width / 2,
          y = box.top + box.height / 2;
        if (
          box.height <= 0 ||
          x < 0 ||
          x >= innerWidth ||
          y < 0 ||
          y >= innerHeight ||
          !element.contains(document.elementFromPoint(x, y))
        ) {
          sizes.navIssue = 'Admin navigation is unreachable after scrolling: ' + label;
          break;
        }
      }
    } finally {
      // scrollIntoView can move the strip, intermediate ancestors and the page.
      // Restore every captured owner outer-first, then the original window offset.
      try {
        for (const { node, left, top } of owners) node.scrollTo(left, top);
      } finally {
        scrollTo(original.x, original.y);
      }
    }
    return sizes;
  });
  assert.ok(sizes.body <= sizes.width + 1, 'Horizontal page overflow: ' + JSON.stringify(sizes));
  assert.deepEqual(sizes.broken, [], 'Form controls overflow');
  assert.equal(sizes.navIssue, '');
}

module.exports = {
  checkLayout,
  inlineForm,
  installBanner,
  earlyHours,
  helpTargets,
  maxStatus,
  adminLayout,
};
