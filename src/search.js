// A search box with a list of suggestions (the ARIA combobox pattern): type to search, arrow keys
// to move through the results, Enter to pick one, Escape to close the list or clear the box.
// `search(query)` returns (a promise of) results like { name, detail }, best first.
export function setupSearch({ input, list, status, search, onSelect, describe = (n) => `${n} found` }) {
  let results = [];
  let active = -1;
  let latest = 0;

  function render() {
    list.replaceChildren(
      ...results.map((result, i) => {
        const option = document.createElement('li');
        option.id = `search-option-${i}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(i === active));
        const name = document.createElement('span');
        name.className = 'search-name';
        name.textContent = result.name;
        option.append(name);
        if (result.detail) {
          const detail = document.createElement('span');
          detail.className = 'search-detail';
          detail.textContent = result.detail;
          option.append(detail);
        }
        // Keep focus in the box while clicking, so the list does not close first.
        option.addEventListener('mousedown', (event) => event.preventDefault());
        option.addEventListener('click', () => choose(i));
        return option;
      }),
    );
    const open = results.length > 0;
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `search-option-${active}`);
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function show(items, message = '') {
    results = items;
    active = -1;
    render();
    status.textContent = message;
  }

  function choose(i) {
    const result = results[i];
    if (!result) return;
    input.value = result.name;
    show([]);
    onSelect(result);
  }

  input.addEventListener('input', async () => {
    const query = input.value;
    const request = ++latest;
    if (query.trim().length < 2) {
      show([]);
      return;
    }
    try {
      const found = await search(query);
      // Ignore answers to queries that have since been replaced by more typing.
      if (request !== latest) return;
      show(found, found.length ? describe(found.length) : 'Nothing found');
    } catch (err) {
      console.error(err);
      if (request === latest) show([], 'Search is unavailable right now');
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!results.length) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + delta + results.length) % results.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (results.length) choose(Math.max(0, active));
    } else if (event.key === 'Escape' && (results.length || input.value)) {
      // Close the list, or else clear the box; only Escape in an empty box reaches the page
      // (where it closes the open panel).
      event.stopPropagation();
      event.preventDefault();
      if (!results.length) input.value = '';
      show([]);
    }
  });

  input.addEventListener('blur', () => {
    results = [];
    active = -1;
    render();
  });
}
