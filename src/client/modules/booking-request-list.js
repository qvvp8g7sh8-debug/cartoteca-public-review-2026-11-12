function createBookingRequestList(state, actions) {
  const rendered = new window.WeakMap();
  // Refresh the loaded window, not just its first page. Keep older loaded rows when new ones arrive.
  async function readBookingRequestWindow(previous, more, cursor, live) {
    let next = more ? cursor : null,
      items = more ? [...previous] : [],
      version = null,
      settingsRevision = null;
    const oldest = !more && previous.at(-1);
    const covered = (last) =>
      !oldest ||
      (last &&
        (last.createdAt < oldest.createdAt ||
          (last.createdAt === oldest.createdAt && last.id <= oldest.id)));
    const seen = new Set();
    do {
      const url =
        '/api/online-booking/requests' +
        (next ? '?cursor=' + encodeURIComponent(JSON.stringify(next)) : '');
      if (seen.has(url)) throw Error('Список заявок изменился. Повторите обновление.');
      seen.add(url);
      const page = await actions.readBackground(url);
      if (!live()) return null;
      if (version !== null && page.version !== version)
        throw Error('Список заявок изменился во время загрузки. Повторим обновление.');
      version = page.version;
      settingsRevision = page.settingsRevision;
      items.push(...page.items);
      next = page.cursor;
      if (more || covered(page.items.at(-1))) break;
    } while (next);
    return {
      items: [...new Map(items.map((r) => [r.id, r])).values()],
      cursor: next,
      version,
      settingsRevision,
    };
  }
  function reconcileBookingRequests(content, html) {
    const draft = document.createElement('div');
    draft.innerHTML = html;
    const existing = new Map(
      [...content.querySelectorAll('[data-booking-request-row]')].map((row) => [
        row.dataset.bookingRequestRow,
        row,
      ]),
    );
    const incoming = new Set();
    const order = [...draft.children].map((row) => row.dataset.bookingRequestRow).filter(Boolean);
    const anchor = [...content.querySelectorAll('[data-booking-request-row]')].find(
      (row) => row.getBoundingClientRect().bottom > 0,
    );
    const top = anchor?.getBoundingClientRect().top;
    for (const fresh of [...draft.children]) {
      const id = fresh.dataset.bookingRequestRow;
      if (!id) continue;
      incoming.add(id);
      const row = existing.get(id);
      if (!row) {
        const following = [...content.children].find((node) => {
          const other = node.dataset.bookingRequestRow;
          return other && order.indexOf(other) > order.indexOf(id);
        });
        content.insertBefore(
          fresh,
          following || content.querySelector('[data-booking-request-more]'),
        );
        rendered.set(fresh, fresh.innerHTML);
        continue;
      }
      const protectedRow = editing(row);
      const changed = rendered.get(row) !== fresh.innerHTML;
      const invalid = row.dataset.bookingRequestVersion !== fresh.dataset.bookingRequestVersion;
      if (protectedRow && changed) {
        // Preserve the date, selected time and contact. Revision/permission changes block new commands.
        markBookingRequest(
          row,
          invalid ? 'changed' : '',
          invalid ? 'Заявка или доступ изменились. Обновите заявку, чтобы продолжить.' : '',
        );
      } else if (changed || row.dataset.bookingRequestStale) {
        const contact = row.querySelector('[data-booking-contact]')?.value;
        row.innerHTML = fresh.innerHTML;
        rendered.set(row, fresh.innerHTML);
        row.dataset.bookingRequestVersion = fresh.dataset.bookingRequestVersion;
        delete row.dataset.bookingRequestStale;
        const select = row.querySelector('[data-booking-contact]');
        if (select && [...select.options].some((option) => option.value === contact))
          select.value = contact;
      }
    }
    for (const [id, row] of existing) {
      if (incoming.has(id)) continue;
      if (editing(row)) {
        markBookingRequest(
          row,
          'removed',
          'Заявка уже обработана. Закройте выбор времени или обновите список.',
        );
      } else row.remove();
    }
    content
      .querySelectorAll('.booking-requests-empty,[data-booking-request-more]')
      .forEach((node) => node.remove());
    [...draft.children]
      .filter((node) => !node.hasAttribute('data-booking-request-row'))
      .forEach((node) => {
        if (
          !node.classList.contains('booking-requests-empty') ||
          !content.querySelector('[data-booking-request-row]')
        )
          content.append(node);
      });
    if (anchor?.isConnected && top !== undefined) {
      const shift = anchor.getBoundingClientRect().top - top;
      if (shift) window.scrollBy(0, shift);
    }
  }
  function editing(row) {
    return (
      row.querySelector('.booking-time-editor') ||
      (row.contains(document.activeElement) &&
        document.activeElement.matches('input,select,textarea'))
    );
  }
  function markBookingRequest(row, stale, text) {
    if (stale) row.dataset.bookingRequestStale = stale;
    let warning = row.querySelector('[data-booking-request-warning]');
    if (!text) return;
    if (!warning) {
      warning = document.createElement('p');
      warning.dataset.bookingRequestWarning = '';
      warning.className = 'booking-request-warning';
      warning.setAttribute('role', 'status');
      row.querySelector('.booking-request-summary').append(warning);
    }
    warning.textContent = text;
    row.querySelectorAll('[data-booking-request-action]').forEach((button) => {
      button.disabled = true;
    });
    row.dispatchEvent(
      new window.CustomEvent('booking-request-stale', { detail: { reason: stale } }),
    );
  }
  function expireBookingRequestEditors(root, items) {
    for (const item of items) {
      if (item.kind !== 'reserve' || item.status !== 'expired') continue;
      const row = [...root.querySelectorAll('[data-booking-request-row]')].find(
        (node) => node.dataset.bookingRequestRow === item.id,
      );
      if (
        !row?.querySelector('.booking-time-editor') ||
        row.querySelector('[data-booking-reserve-expired]')
      )
        continue;
      const warning = document.createElement('p');
      warning.dataset.bookingReserveExpired = '';
      warning.className = 'booking-request-warning';
      warning.textContent =
        'Резерв истёк. При подтверждении свободное время будет проверено заново.';
      row.querySelector('.booking-request-summary').append(warning);
    }
  }
  return { readBookingRequestWindow, reconcileBookingRequests, expireBookingRequestEditors };
}
