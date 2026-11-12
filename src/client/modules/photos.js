function createPhotos(state, actions) {
  let uploadTask = null,
    addedPhotos = null;
  const phases = ['До', 'После', 'Контроль'];
  function photoSource(value) {
    if (typeof value !== 'string') return '';
    if (!state.multiUser || !/^\/api\/photos\/[a-f0-9]{32}$/.test(value)) return value;
    const account = state.account;
    if (
      typeof account?.id !== 'string' ||
      !account.id ||
      typeof account.organizationId !== 'string' ||
      !account.organizationId
    )
      return '';
    return (
      value +
      '?accountContext=' +
      encodeURIComponent(account.id) +
      '&organizationContext=' +
      encodeURIComponent(account.organizationId)
    );
  }
  function currentAddedPhotos() {
    if (
      !addedPhotos ||
      addedPhotos.editor !== state.editorMode ||
      addedPhotos.items !== state.uploadItems ||
      addedPhotos.account !== state.account
    ) {
      addedPhotos = null;
      return [];
    }
    return addedPhotos.photos.filter((photo) => {
      const index = state.uploadItems.indexOf(photo);
      return (
        index >= 0 && (!state.editorMode.appendOnly || index >= state.editorMode.savedPhotoCount)
      );
    });
  }
  function photosPending() {
    return Boolean(
      uploadTask &&
      uploadTask.editor === state.editorMode &&
      uploadTask.items === state.uploadItems,
    );
  }
  function cancelPhotoProcessing() {
    uploadTask?.controller.abort();
    uploadTask = null;
    syncPhotoControls();
  }
  function syncPhotoControls() {
    const input = actions.$('#photo-input'),
      count = actions.$('#photo-upload-count'),
      status = actions.$('#photo-upload-status'),
      empty = actions.$('#photo-upload-empty'),
      batch = actions.$('#photo-batch-caption'),
      pending = photosPending(),
      total = state.uploadItems?.length || 0;
    if (batch) {
      const photos = currentAddedPhotos(),
        caption = photos[0]?.caption;
      batch.closest('.visit-photos-batch').hidden = photos.length < 2 || pending;
      batch.disabled = state.busy || pending || photos.length < 2;
      batch.value =
        phases.includes(caption) && photos.every((photo) => photo.caption === caption)
          ? caption
          : '';
    }
    if (input) {
      input.disabled = state.busy || pending || total >= 6;
      input.closest('.upload-label')?.setAttribute('aria-disabled', String(input.disabled));
    }
    if (count) {
      count.textContent = total + ' / 6';
      count.setAttribute('aria-label', total + ' из 6 фотографий');
    }
    if (empty) empty.hidden = total > 0;
    if (status) {
      status.hidden = !pending && total < 6;
      status.textContent = pending
        ? `Обработка фото ${Math.min(uploadTask.processed + 1, uploadTask.total)} из ${uploadTask.total}…`
        : total >= 6
          ? 'Добавлено 6 фото — лимит посещения.'
          : '';
      status.classList.toggle('is-processing', pending);
    }
  }
  function updatePhotoSaveButton() {
    const button = actions.$('#save-editor');
    if (button)
      button.disabled = state.busy || photosPending() || Boolean(actions.cabinetSaveStatus?.());
    syncPhotoControls();
  }
  function renderUploads() {
    const root = actions.$('#upload-list');
    if (!root) return;
    root.innerHTML = state.uploadItems
      .map((x, i) => {
        const locked = state.editorMode?.appendOnly && i < state.editorMode.savedPhotoCount,
          source = photoSource(x.data);
        return [
          `<div class="upload-preview">`,
          `<div class="upload-preview-image"><button type="button" class="upload-preview-open" `,
          `data-photo="${actions.esc(source)}" data-upload-photo="${i}" data-caption="${actions.esc(x.caption || 'Фото визита')}" aria-label="Рассмотреть фото ${i + 1}" title="Рассмотреть фото">`,
          `<img${source ? ` src="${actions.esc(source)}"` : ''} alt="Предпросмотр фото ${i + 1}"></button>`,
          !locked && (actions.canDelete() || String(x.data).startsWith('data:'))
            ? `<button type="button" class="upload-preview-remove" data-remove-photo="${i}" aria-label="Удалить фото ${i + 1}" title="Удалить фото"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/></svg></button>`
            : '',
          `</div><label class="upload-preview-caption"><span>Фото ${i + 1}</span>`,
          `<select data-photo-caption="${i}" aria-label="Подпись фото ${i + 1}" ${locked ? 'disabled' : ''}>`,
          `<option ${!x.caption ? 'selected' : ''}>Фото визита</option>`,
          `<option ${x.caption === 'До' ? 'selected' : ''}>До</option>`,
          `<option ${x.caption === 'После' ? 'selected' : ''}>После</option>`,
          `<option ${x.caption === 'Контроль' ? 'selected' : ''}>Контроль</option>`,
          `</select></label></div>`,
        ].join('');
      })
      .join('');
    syncPhotoControls();
  }
  function changePhotoCaption(control) {
    if (state.editorMode?.kind !== 'visit' || state.busy) return;
    const caption = control.value;
    if (![...phases, 'Фото визита'].includes(caption)) return;
    if (control.id === 'photo-batch-caption') {
      if (photosPending()) return;
      for (const photo of currentAddedPhotos()) photo.caption = caption;
      renderUploads();
      return;
    }
    const index = Number(control.dataset.photoCaption);
    if (!Number.isInteger(index) || !state.uploadItems[index]) return;
    if (state.editorMode.appendOnly && index < state.editorMode.savedPhotoCount) return;
    state.uploadItems[index].caption = caption;
    syncPhotoControls();
  }
  async function processFiles(files) {
    if (state.editorMode?.kind !== 'visit' || state.busy) return;
    if (photosPending()) {
      actions.toast('Дождитесь обработки выбранных фотографий.');
      return;
    }
    const available = 6 - state.uploadItems.length,
      selected = Array.from(files || []);
    if (available <= 0) {
      actions.toast('На посещение можно добавить не более 6 фотографий.');
      return;
    }
    if (!selected.length) return;
    if (selected.length > available)
      actions.toast(`Можно добавить ещё ${available} фото. Остальные файлы не добавлены.`);
    const input = actions.$('#photo-input');
    if (input) input.value = '';
    cancelPhotoProcessing();
    currentAddedPhotos();
    addedPhotos ||= {
      editor: state.editorMode,
      items: state.uploadItems,
      account: state.account,
      photos: [],
    };
    const task = {
      editor: state.editorMode,
      items: state.uploadItems,
      account: state.account,
      total: Math.min(selected.length, available),
      processed: 0,
      controller: new AbortController(),
    };
    uploadTask = task;
    const current = () =>
      uploadTask === task &&
      state.editorMode === task.editor &&
      state.uploadItems === task.items &&
      state.account === task.account &&
      !task.controller.signal.aborted;
    updatePhotoSaveButton();
    try {
      for (const file of selected.slice(0, available)) {
        if (!current()) return;
        if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 10 * 1024 * 1024) {
          actions.toast('Фото должно быть JPEG, PNG или WebP, размером до 10 МБ.');
          task.processed++;
          syncPhotoControls();
          continue;
        }
        try {
          const data = await actions.resize(file, { signal: task.controller.signal });
          if (!current()) return;
          if (task.items.length < 6) {
            const photo = { data, caption: '' };
            task.items.push(photo);
            addedPhotos.photos.push(photo);
          }
          actions.renderUploads();
        } catch {
          if (current())
            actions.toast(
              'Не удалось обработать фотографию. Выберите другой файл или попробуйте ещё раз.',
            );
        } finally {
          task.processed++;
          if (current()) syncPhotoControls();
        }
      }
    } finally {
      if (uploadTask === task) {
        uploadTask = null;
        updatePhotoSaveButton();
      }
    }
  }
  function resize(file, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader(),
        image = new Image();
      let settled = false;
      const finish = (error, data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        reader.onload = reader.onerror = image.onload = image.onerror = null;
        if (reader.readyState === 1) reader.abort();
        if (error) reject(error);
        else resolve(data);
      };
      const abort = () => finish(new Error('Обработка фотографии отменена.'));
      const timeout = setTimeout(
        () => finish(new Error('Обработка фотографии заняла слишком много времени.')),
        20000,
      );
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      reader.onload = () => {
        image.onload = () => {
          try {
            const max = 1600,
              scale = Math.min(1, max / Math.max(image.width, image.height)),
              canvas = document.createElement('canvas');
            canvas.width = Math.round(image.width * scale);
            canvas.height = Math.round(image.height * scale);
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            finish(null, canvas.toDataURL('image/jpeg', 0.82));
          } catch (error) {
            finish(error);
          }
        };
        image.onerror = () => finish(new Error('Некорректное изображение.'));
        image.src = reader.result;
      };
      reader.onerror = () => finish(new Error('Не удалось прочитать файл.'));
      try {
        reader.readAsDataURL(file);
      } catch (error) {
        finish(error);
      }
    });
  }
  function showPhoto(btn) {
    if (!btn.dataset.photo) return;
    actions.$('#large-photo').src = btn.dataset.photo;
    const photo =
      btn.dataset.uploadPhoto !== undefined && state.editorMode?.kind === 'visit'
        ? state.uploadItems[Number(btn.dataset.uploadPhoto)]
        : null;
    actions.$('#photo-caption').textContent = photo
      ? photo.caption || 'Фото визита'
      : btn.dataset.caption || '';
    actions.$('#photo-view').showModal();
  }
  return {
    photoSource,
    renderUploads,
    changePhotoCaption,
    processFiles,
    resize,
    showPhoto,
    photosPending,
    cancelPhotoProcessing,
    updatePhotoSaveButton,
  };
}
