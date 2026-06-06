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

  // ============================================================
  // ИНИЦИАЛИЗАЦИЯ
  // ============================================================
  async function init() {
    loadSettings();
    loadProgress();
    loadDailyState();
    applyTheme();
    await loadDeck();
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
    document.getElementById('card-back-text').innerHTML = formatText(card.back);

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

  function rateCard(rating) {
    const cardId = studyQueue[currentCardIdx];
    const result = applyRating(cardId, rating);

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
    if (currentScreen === 'study' || currentScreen === 'menu') {
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
    // экранируем + распознаём `code`, **bold**, переносы строк
    let out = escapeHtml(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\n/g, '<br>');
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
