(() => {
  const searchInput = document.querySelector('.card-search input');
  const cards = [...document.querySelectorAll('.client-mini')];
  const emptyMessage = document.querySelector('#card-search-empty');

  if (!searchInput || !cards.length || !emptyMessage) return;

  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim().toLocaleLowerCase('ru-RU');
    let visibleCards = 0;

    cards.forEach((card) => {
      const searchableText = (card.dataset.search || card.textContent).toLocaleLowerCase('ru-RU');
      const isVisible = !query || searchableText.includes(query);
      card.hidden = !isVisible;
      if (isVisible) visibleCards += 1;
    });

    emptyMessage.hidden = visibleCards !== 0;
  });
})();
