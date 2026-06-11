// DS Cards — SM-2 SRS приложение
// Версия 0.1 (MVP) — 03.06.2026

(function() {
  'use strict';

  // ============================================================
  // КОНСТАНТЫ И НАСТРОЙКИ
  // ============================================================
  const STORAGE_KEY_PROGRESS = 'dscards_progress_v1';
  const STORAGE_KEY_SETTINGS = 'dscards_settings_v1';
  const STORAGE_KEY_DAILY = 'dscards_daily_v1';
  const DEFAULT_EASE = 2.5;
  const MIN_EASE = 1.3;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // ============================================================
  // СОСТОЯНИЕ
  // ============================================================
  let DECK = [];           // мастер-набор карточек из deck.json
  let progress = {};       // прогресс per card: { cardId: {ease, interval, reps, due, lapses} }
  let settings = { theme: 'auto', dailyLimit: 30 };
  let dailyState = { date: null, studied: 0 };
  let currentScreen = 'home';
  let studyQueue = [];     // массив cardId в текущем сеансе
  let currentCardIdx = 0;
  let currentDeckFilter = null; // null = все колоды

  // глоссарий
  let GLOSSARY = [];       // статьи из glossary.json
  let glossaryQuery = '';  // текущий поиск
  let currentEntryId = null;
  let navStack = [];       // откуда пришли в статью: {screen, id?}

  // ============================================================
  // ИНИЦИАЛИЗАЦИЯ
  // ============================================================
  async function init() {
    loadSettings();
    loadProgress();
    loadDailyState();
    applyTheme();
    await loadDeck();
    await loadGlossary();
    bindEvents();
    renderHome();
    registerServiceWorker();
  }

  async function loadDeck() {
    try {
      const response = await fetch('deck.json');
      const data = await response.json();
      DECK = data.cards || data;
      document.getElementById('version-cards').textContent = DECK.length;
    } catch (e) {
      console.error('Failed to load deck.json:', e);
      DECK = [];
    }
  }

  async function loadGlossary() {
    try {
      const response = await fetch('glossary.json');
      const data = await response.json();
      GLOSSARY = data.entries || [];
    } catch (e) {
      console.error('Failed to load glossary.json:', e);
      GLOSSARY = [];
    }
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_PROGRESS);
      progress = raw ? JSON.parse(raw) : {};
    } catch (e) {
      progress = {};
    }
  }

  function saveProgress() {
    localStorage.setItem(STORAGE_KEY_PROGRESS, JSON.stringify(progress));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
      if (raw) settings = Object.assign(settings, JSON.parse(raw));
    } catch (e) {}
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
  }

  function loadDailyState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_DAILY);
      if (raw) dailyState = JSON.parse(raw);
      // reset if new day
      const today = todayKey();
      if (dailyState.date !== today) {
        dailyState = { date: today, studied: 0 };
        saveDailyState();
      }
    } catch (e) {
      dailyState = { date: todayKey(), studied: 0 };
    }
  }

  function saveDailyState() {
    localStorage.setItem(STORAGE_KEY_DAILY, JSON.stringify(dailyState));
  }

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate();
  }

  // ============================================================
  // ТЕМА
  // ============================================================
  function applyTheme() {
    if (settings.theme === 'auto') {
      document.body.removeAttribute('data-theme');
    } else {
      document.body.setAttribute('data-theme', settings.theme);
    }
  }

  // ============================================================
  // SM-2 АЛГОРИТМ (упрощённый)
  // ============================================================
  function getCardState(cardId) {
    return progress[cardId] || {
      ease: DEFAULT_EASE,
      interval: 0,
      reps: 0,
      due: 0,         // 0 = новая карточка
      lapses: 0,
      lastReview: null
    };
  }

  function isDue(cardId) {
    const s = getCardState(cardId);
    if (s.reps === 0) return false; // новая, не due
    return s.due <= Date.now();
  }

  function isNew(cardId) {
    return getCardState(cardId).reps === 0;
  }

  // rating: 1=Again, 2=Hard, 3=Good, 4=Easy
  function applyRating(cardId, rating) {
    const s = getCardState(cardId);
    const now = Date.now();

    let newEase = s.ease;
    let newInterval; // in days
    let newReps = s.reps;
    let newLapses = s.lapses;

    if (rating === 1) {
      // Again — учим сначала
      newReps = 0;
      newInterval = 0; // показать снова сегодня
      newEase = Math.max(MIN_EASE, s.ease - 0.2);
      newLapses += 1;
    } else if (rating === 2) {
      // Hard
      if (s.reps === 0) {
        // Hard на НОВОЙ карточке — мини-повтор в сессии (~10 мин в Anki-стиле).
        // Карточка остаётся "в обучении" (reps = 0), увидишь её снова через 2-5 карточек.
        newInterval = 0;
        newReps = 0;
        newEase = Math.max(MIN_EASE, s.ease - 0.15);
      } else {
        newInterval = Math.max(1, Math.round(s.interval * 1.2));
        newEase = Math.max(MIN_EASE, s.ease - 0.15);
        newReps = s.reps + 1;
      }
    } else if (rating === 3) {
      // Good
      if (s.reps === 0) {
        newInterval = 1;
      } else if (s.reps === 1) {
        newInterval = 4;
      } else {
        newInterval = Math.round(s.interval * s.ease);
      }
      newReps = s.reps + 1;
    } else if (rating === 4) {
      // Easy
      if (s.reps === 0) {
        newInterval = 4;
      } else {
        newInterval = Math.round(s.interval * s.ease * 1.3);
      }
      newEase = Math.min(2.8, s.ease + 0.15);
      newReps = s.reps + 1;
    }

    const newDue = newInterval === 0 ? now : now + newInterval * DAY_MS;

    progress[cardId] = {
      ease: parseFloat(newEase.toFixed(2)),
      interval: newInterval,
      reps: newReps,
      due: newDue,
      lapses: newLapses,
      lastReview: now
    };
    saveProgress();

    return { interval: newInterval };
  }

  // helper: предсказать интервал для button labels
  function predictInterval(cardId, rating) {
    const s = getCardState(cardId);
    if (rating === 1) return '< 1 мин';
    if (rating === 2) {
      if (s.reps === 0) return '~10 мин';
      const i = Math.max(1, Math.round(s.interval * 1.2));
      return i + ' д';
    }
    if (rating === 3) {
      let i;
      if (s.reps === 0) i = 1;
      else if (s.reps === 1) i = 4;
      else i = Math.round(s.interval * s.ease);
      return i + ' д';
    }
    if (rating === 4) {
      const i = s.reps === 0 ? 4 : Math.round(s.interval * s.ease * 1.3);
      return i + ' д';
    }
  }

  // ============================================================
  // СТАТИСТИКА
  // ============================================================
  function getDeckStats(deckName) {
    const cards = deckName ? DECK.filter(c => c.deck === deckName) : DECK;
    let due = 0, fresh = 0, total = cards.length;
    cards.forEach(c => {
      if (isDue(c.id)) due++;
      else if (isNew(c.id)) fresh++;
    });
    return { due, fresh, total };
  }

  function getDeckNames() {
    const names = new Set();
    DECK.forEach(c => names.add(c.deck));
    return [...names].sort();
  }

  // ============================================================
  // ОЧЕРЕДЬ К ОБУЧЕНИЮ
  // ============================================================
  function buildStudyQueue(deckName) {
    const cards = deckName ? DECK.filter(c => c.deck === deckName) : DECK;
    const due = cards.filter(c => isDue(c.id));
    const fresh = cards.filter(c => isNew(c.id));

    // лимит на день
    const remaining = settings.dailyLimit - dailyState.studied;
    const maxNewToShow = Math.max(0, Math.min(remaining, fresh.length));
    const maxDueToShow = Math.max(0, Math.min(remaining, due.length));

    // due идут раньше new (как в Anki)
    const queue = [
      ...due.slice(0, maxDueToShow),
      ...fresh.slice(0, maxNewToShow)
    ];
    // limit overall
    return queue.slice(0, remaining).map(c => c.id);
  }

  // ============================================================
  // РЕНДЕР: HOME
  // ============================================================
  function renderHome() {
    showScreen('home');
    document.getElementById('screen-title').textContent = 'DS Cards';
    document.getElementById('btn-back').hidden = true;

    const stats = getDeckStats(null);
    document.getElementById('stat-due').textContent = stats.due;
    document.getElementById('stat-new').textContent = stats.fresh;
    document.getElementById('stat-total').textContent = stats.total;

    const queue = buildStudyQueue(null);
    document.getElementById('study-all-count').textContent = queue.length;

    // ближайшие повторы — делаем график SM-2 видимым
    const upBox = document.getElementById('upcoming');
    if (upBox) {
      const now = Date.now();
      const buckets = { today: 0, tomorrow: 0, week: 0, later: 0 };
      DECK.forEach(c => {
        const s = getCardState(c.id);
        if (s.reps === 0) return; // новые не считаем
        const days = Math.ceil((s.due - now) / DAY_MS);
        if (days <= 0) buckets.today++;
        else if (days === 1) buckets.tomorrow++;
        else if (days <= 7) buckets.week++;
        else buckets.later++;
      });
      upBox.innerHTML =
        `<span>сегодня <b>${buckets.today}</b></span>` +
        `<span>завтра <b>${buckets.tomorrow}</b></span>` +
        `<span>за неделю <b>${buckets.week}</b></span>` +
        `<span>позже <b>${buckets.later}</b></span>`;
    }

    const list = document.getElementById('deck-list');
    list.innerHTML = '';
    const names = getDeckNames();
    names.forEach(name => {
      const s = getDeckStats(name);
      const item = document.createElement('li');
      item.className = 'deck-item';
      item.dataset.deck = name;
      item.innerHTML = `
        <div>
          <div class="deck-name">${escapeHtml(name)}</div>
          <div class="deck-meta">${s.fresh} новых · ${s.total - s.fresh - s.due} в обучении</div>
        </div>
        <div class="deck-due ${s.due === 0 ? 'zero' : ''}">${s.due}</div>
      `;
      item.addEventListener('click', () => startStudy(name));
      list.appendChild(item);
    });
  }

  // ============================================================
  // РЕНДЕР: STUDY
  // ============================================================
  function startStudy(deckName) {
    currentDeckFilter = deckName;
    studyQueue = buildStudyQueue(deckName);
    currentCardIdx = 0;

    if (studyQueue.length === 0) {
      alert('В этой колоде нет карточек к повтору / Nothing to study');
      return;
    }

    showScreen('study');
    document.getElementById('btn-back').hidden = false;
    document.getElementById('screen-title').textContent = 'Учить / Study';
    document.getElementById('study-deck-name').textContent = deckName || 'Все колоды';

    renderCurrentCard();
  }

  function renderCurrentCard() {
    if (currentCardIdx >= studyQueue.length) {
      // готово
      document.getElementById('card').hidden = true;
      document.getElementById('study-done').hidden = false;
      return;
    }

    document.getElementById('card').hidden = false;
    document.getElementById('study-done').hidden = true;

    const cardId = studyQueue[currentCardIdx];
    const card = DECK.find(c => c.id === cardId);
    if (!card) {
      // bad data — skip
      currentCardIdx++;
      renderCurrentCard();
      return;
    }

    document.getElementById('study-counter').textContent =
      `${currentCardIdx + 1} / ${studyQueue.length}`;

    document.getElementById('card-front-text').innerHTML = formatText(card.front);
    document.getElementById('card-front-text-back').innerHTML = formatText(card.front);
    document.getElementById('card-back-text').innerHTML = formatText(card.back) +
      (card.img ? `<img class="card-img" src="${card.img}" alt="схема">` : '');

    // tags
    const tagsEl = document.getElementById('card-tags');
    tagsEl.innerHTML = '';
    if (card.tags && card.tags.length) {
      card.tags.forEach(t => {
        const span = document.createElement('span');
        span.textContent = t;
        tagsEl.appendChild(span);
      });
    }

    // ссылки в глоссарий ("не понял → провались вглубь")
    const glossEl = document.getElementById('card-gloss');
    glossEl.innerHTML = '';
    const related = findEntriesForCard(card);
    if (related.length) {
      const label = document.createElement('div');
      label.className = 'card-gloss-label';
      label.textContent = 'Не понял? Подробнее:';
      glossEl.appendChild(label);
      related.forEach(en => {
        const chip = document.createElement('button');
        chip.className = 'gloss-chip';
        chip.textContent = '📖 ' + en.term;
        chip.addEventListener('click', () => openEntry(en.id, 'study'));
        glossEl.appendChild(chip);
      });
    }

    // обновить предсказание интервалов на кнопках
    document.querySelectorAll('.rate-interval').forEach(el => {
      const rate = parseInt(el.dataset.int, 10);
      el.textContent = predictInterval(cardId, rate);
    });

    // hide back, show front
    document.querySelector('.card-front').hidden = false;
    document.querySelector('.card-back').hidden = true;
  }

  function showAnswer() {
    document.querySelector('.card-front').hidden = true;
    document.querySelector('.card-back').hidden = false;
  }

  // тост "увидишь через X" — делает интервалы видимыми
  let toastTimer = null;
  function showToast(text) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
  }

  function rateCard(rating) {
    const cardId = studyQueue[currentCardIdx];
    const predicted = predictInterval(cardId, rating);
    const result = applyRating(cardId, rating);
    showToast(result.interval === 0
      ? '🔁 вернётся в этой сессии'
      : '⏱ увидишь через ' + predicted);

    // Если interval = 0 (Again ИЛИ Hard на новой) — карточка снова в очередь сессии.
    // Иначе — пошла в график на дни вперёд, считаем как изученную сегодня.
    if (result.interval === 0) {
      studyQueue.push(cardId);
    } else {
      dailyState.studied++;
      saveDailyState();
    }

    currentCardIdx++;
    renderCurrentCard();
  }

  // ============================================================
  // РЕНДЕР: ГЛОССАРИЙ
  // ============================================================
  function entryMatchesQuery(entry, q) {
    if (!q) return true;
    const hay = (entry.term + ' ' + entry.id + ' ' +
      (entry.aliases || []).join(' ') + ' ' + (entry.what || '')).toLowerCase();
    return hay.includes(q);
  }

  function renderGlossary() {
    showScreen('glossary');
    document.getElementById('screen-title').textContent = 'Глоссарий';
    document.getElementById('btn-back').hidden = false;

    const input = document.getElementById('gloss-search');
    input.value = glossaryQuery;

    const q = glossaryQuery.trim().toLowerCase();
    const list = document.getElementById('gloss-list');
    list.innerHTML = '';

    // группируем по категориям, сохраняя порядок появления
    const cats = [];
    const byCat = {};
    GLOSSARY.filter(en => entryMatchesQuery(en, q)).forEach(en => {
      if (!byCat[en.cat]) { byCat[en.cat] = []; cats.push(en.cat); }
      byCat[en.cat].push(en);
    });

    if (cats.length === 0) {
      list.innerHTML = '<p class="muted">Ничего не найдено</p>';
      return;
    }

    cats.forEach(cat => {
      const h = document.createElement('h3');
      h.className = 'gloss-cat';
      h.textContent = cat;
      list.appendChild(h);
      byCat[cat].forEach(en => {
        const item = document.createElement('div');
        item.className = 'gloss-item';
        item.innerHTML =
          `<div class="gloss-term">${escapeHtml(en.term)}</div>` +
          `<div class="gloss-what">${escapeHtml(shorten(en.what, 80))}</div>`;
        item.addEventListener('click', () => openEntry(en.id, 'glossary'));
        list.appendChild(item);
      });
    });
  }

  function shorten(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // origin: 'glossary' | 'study' | 'entry' — откуда открыли статью
  function openEntry(id, origin) {
    if (origin === 'entry') {
      navStack.push({ screen: 'glossary-entry', id: currentEntryId });
    } else if (origin) {
      navStack.push({ screen: origin });
    }
    renderGlossaryEntry(id);
  }

  function renderGlossaryEntry(id) {
    const en = GLOSSARY.find(x => x.id === id);
    if (!en) return;
    currentEntryId = id;

    showScreen('glossary-entry');
    document.getElementById('screen-title').textContent = 'Глоссарий';
    document.getElementById('btn-back').hidden = false;

    const box = document.getElementById('gloss-entry');
    let html = `<h2 class="gloss-entry-term">${escapeHtml(en.term)}</h2>`;
    html += `<div class="gloss-entry-cat">${escapeHtml(en.cat)}</div>`;
    html += `<div class="gloss-block"><div class="card-label">Что это</div>` +
            `<div class="card-text">${formatText(en.what)}</div></div>`;
    if (en.analogy) {
      html += `<div class="gloss-block gloss-analogy"><div class="card-label">💡 Аналогия</div>` +
              `<div class="card-text">${formatText(en.analogy)}</div></div>`;
    }
    if (en.example) {
      html += `<div class="gloss-block"><div class="card-label">Пример</div>` +
              `<div class="card-text">${formatText(en.example)}</div></div>`;
    }
    if (en.why) {
      html += `<div class="gloss-block"><div class="card-label">🎯 Зачем в DS</div>` +
              `<div class="card-text">${formatText(en.why)}</div></div>`;
    }
    box.innerHTML = html;

    // связанные статьи
    const seeBox = document.getElementById('gloss-see');
    seeBox.innerHTML = '';
    (en.see || []).forEach(sid => {
      const target = GLOSSARY.find(x => x.id === sid);
      if (!target) return;
      const chip = document.createElement('button');
      chip.className = 'gloss-chip';
      chip.textContent = '📖 ' + target.term;
      chip.addEventListener('click', () => openEntry(sid, 'entry'));
      seeBox.appendChild(chip);
    });
  }

  // статьи глоссария, релевантные карточке (по тегам)
  function findEntriesForCard(card) {
    const tags = new Set((card.tags || []).map(t => t.toLowerCase()));
    return GLOSSARY.filter(en =>
      tags.has(en.id) || (en.aliases || []).some(a => tags.has(a)));
  }

  // ============================================================
  // РЕНДЕР: MENU
  // ============================================================
  function renderMenu() {
    showScreen('menu');
    document.getElementById('screen-title').textContent = 'Меню / Menu';
    document.getElementById('btn-back').hidden = false;

    // theme radio
    document.querySelectorAll('input[name="theme"]').forEach(r => {
      r.checked = (r.value === settings.theme);
    });

    // daily limit
    document.getElementById('daily-limit').value = settings.dailyLimit;
  }

  // ============================================================
  // НАВИГАЦИЯ
  // ============================================================
  function showScreen(name) {
    currentScreen = name;
    document.querySelectorAll('.screen').forEach(s => s.hidden = true);
    document.getElementById(name).hidden = false;
  }

  function goBack() {
    if (currentScreen === 'glossary-entry') {
      const prev = navStack.pop();
      if (prev && prev.screen === 'glossary-entry') {
        renderGlossaryEntry(prev.id);
      } else if (prev && prev.screen === 'study') {
        // вернуться к открытой карточке, не сбрасывая сессию
        showScreen('study');
        document.getElementById('screen-title').textContent = 'Учить / Study';
        document.getElementById('btn-back').hidden = false;
      } else {
        renderGlossary();
      }
    } else if (currentScreen === 'glossary') {
      navStack = [];
      renderHome();
    } else if (currentScreen === 'study' || currentScreen === 'menu') {
      renderHome();
    }
  }

  // ============================================================
  // УТИЛИТЫ
  // ============================================================
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatText(s) {
    // сначала вырезаем ```блоки кода``` (внутри них переносы и ` не трогаем),
    // потом экранируем + распознаём `code`, **bold**, переносы строк
    const blocks = [];
    let out = String(s).replace(/```\w*\n?([\s\S]*?)```/g, (m, code) => {
      blocks.push('<pre><code>' + escapeHtml(code.replace(/\n+$/, '')) + '</code></pre>');
      return '\u0000' + (blocks.length - 1) + '\u0000';
    });
    out = escapeHtml(out);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\n/g, '<br>');
    out = out.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[+i]);
    return out;
  }

  // ============================================================
  // ЭКСПОРТ / ИМПОРТ
  // ============================================================
  function exportProgress() {
    const data = JSON.stringify({
      version: '0.1',
      exported: new Date().toISOString(),
      progress: progress,
      settings: settings
    }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dscards_backup_${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importProgress(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        if (data.progress) {
          progress = data.progress;
          saveProgress();
        }
        if (data.settings) {
          settings = Object.assign(settings, data.settings);
          saveSettings();
          applyTheme();
        }
        alert('Импорт выполнен / Imported');
        renderHome();
      } catch (e) {
        alert('Файл повреждён / Invalid file');
      }
    };
    reader.readAsText(file);
  }

  function resetProgress() {
    if (!confirm('Сбросить весь прогресс? / Reset all progress?')) return;
    progress = {};
    dailyState = { date: todayKey(), studied: 0 };
    saveProgress();
    saveDailyState();
    renderHome();
  }

  // ============================================================
  // SERVICE WORKER
  // ============================================================
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(e => {
        console.log('SW registration failed:', e);
      });
    }
  }

  // ============================================================
  // СОБЫТИЯ
  // ============================================================
  function bindEvents() {
    document.getElementById('btn-menu').addEventListener('click', renderMenu);
    document.getElementById('btn-back').addEventListener('click', goBack);
    document.getElementById('btn-back-home').addEventListener('click', renderHome);

    document.getElementById('btn-study-all').addEventListener('click', () => startStudy(null));

    document.getElementById('btn-glossary').addEventListener('click', () => {
      navStack = [];
      renderGlossary();
    });
    document.getElementById('gloss-search').addEventListener('input', e => {
      glossaryQuery = e.target.value;
      renderGlossary();
      document.getElementById('gloss-search').focus();
    });

    document.getElementById('btn-show-answer').addEventListener('click', showAnswer);

    document.querySelectorAll('.rate-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = parseInt(btn.dataset.rate, 10);
        rateCard(r);
      });
    });

    document.querySelectorAll('input[name="theme"]').forEach(r => {
      r.addEventListener('change', () => {
        settings.theme = r.value;
        saveSettings();
        applyTheme();
      });
    });

    document.getElementById('daily-limit').addEventListener('change', e => {
      const val = parseInt(e.target.value, 10);
      if (val >= 5 && val <= 200) {
        settings.dailyLimit = val;
        saveSettings();
      }
    });

    document.getElementById('btn-export').addEventListener('click', exportProgress);
    document.getElementById('btn-import').addEventListener('click', () => {
      document.getElementById('import-file').click();
    });
    document.getElementById('import-file').addEventListener('change', e => {
      if (e.target.files.length) importProgress(e.target.files[0]);
    });
    document.getElementById('btn-reset').addEventListener('click', resetProgress);

    // keyboard shortcuts (desktop)
    document.addEventListener('keydown', e => {
      if (currentScreen !== 'study') return;
      if (e.key === ' ') {
        e.preventDefault();
        if (!document.querySelector('.card-back').hidden) return;
        showAnswer();
      } else if (e.key === '1') rateCard(1);
      else if (e.key === '2') rateCard(2);
      else if (e.key === '3') rateCard(3);
      else if (e.key === '4') rateCard(4);
    });
  }

  // ============================================================
  // СТАРТ
  // ============================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
