document.addEventListener('DOMContentLoaded', () => {
    // === STATE MANAGEMENT ===
    const appState = {
        userId: document.body.dataset.userId,
        activeMenu: null,
        timer: { isActive: false, isPaused: false, intervalId: null },
        stimulusCallback: null,
    };
    const DOM = {
        shell: document.querySelector('.app-shell'),
        leftPane: document.getElementById('thoughts-list-pane'),
        rightPane: document.getElementById('compose-thought-pane'),
    };

    // === NAVIGATION & UI ===
    function navigateTo(targetScreenId) {
        const currentActive = document.querySelector('.screen.active');
        const nextScreen = document.getElementById(targetScreenId);
        if (currentActive && nextScreen && currentActive.id !== nextScreen.id) {
            currentActive.classList.add('exiting');
            nextScreen.classList.add('active');
            setTimeout(() => currentActive.classList.remove('active', 'exiting'), 400);
        }
        closeAllPopups();
    }

    function togglePane(pane) {
        DOM.shell.classList.toggle(`${pane}-pane-visible`);
        if (pane === 'left' && DOM.shell.classList.contains('left-pane-visible')) {
            loadAndRenderThoughts();
        }
    }

    function togglePopupMenu(menuId) {
        const menu = document.getElementById(menuId);
        if (appState.activeMenu && appState.activeMenu !== menu) {
            appState.activeMenu.classList.remove('show');
        }
        menu.classList.toggle('show');
        appState.activeMenu = menu.classList.contains('show') ? menu : null;
    }

    function closeAllPopups() {
        document.querySelectorAll('.popup-menu.show').forEach(m => m.classList.remove('show'));
        appState.activeMenu = null;
    }
    
    function showToast(message, type = 'info', duration = 3000) {
        const toast = document.getElementById('toast-notification');
        toast.textContent = message;
        toast.className = 'toast';
        toast.classList.add(type, 'show');
        setTimeout(() => toast.classList.remove('show'), duration);
    }

    // === API & DATA RENDERING ===
    async function fetchApi(endpoint, options = {}) {
        try {
            const response = await fetch(endpoint, options);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            showToast('Сетевая ошибка', 'error');
            throw error;
        }
    }
    
    function renderList(container, templateId, data, renderItem) {
        const template = document.getElementById(templateId);
        container.innerHTML = '';
        if (!data || data.length === 0) {
            container.innerHTML = '<p class="empty-list-message">Здесь пока пусто.</p>';
            return;
        }
        data.forEach(item => {
            const clone = template.content.cloneNode(true);
            renderItem(clone, item);
            container.appendChild(clone);
        });
    }

    function loadAndRenderHistory() {
        const container = document.getElementById('history-list');
        container.innerHTML = '<div class="loader"></div>';
        fetchApi(`/api/analyses/${appState.userId}`)
            .then(data => renderList(container, 'history-item-template', data, (clone, item) => {
                clone.querySelector('.item-date').textContent = new Date(item.analysis_timestamp).toLocaleString('ru-RU');
                clone.querySelector('.item-content').innerHTML = window.marked ? marked.parse(item.report_content || '') : item.report_content;
            })).catch(() => container.innerHTML = '<p>Не удалось загрузить историю.</p>');
    }

    function loadAndRenderThoughts() {
        const container = document.getElementById('thoughts-list-container');
        container.innerHTML = '<div class="loader"></div>';
        fetchApi(`/api/thoughts/${appState.userId}`)
            .then(data => renderList(container, 'thought-item-template', data, (clone, item) => {
                clone.querySelector('.item-date').textContent = new Date(item.timestamp).toLocaleString('ru-RU');
                clone.querySelector('.item-content').textContent = item.content;
            })).catch(() => container.innerHTML = '<p>Не удалось загрузить мысли.</p>');
    }

    // === TIMER LOGIC ===
    const Timer = {
        tick() {
            const elapsedMs = Date.now() - appState.timer.startTime - appState.timer.totalPausedMs;
            const seconds = Math.floor(elapsedMs / 1000) % 60;
            const minutes = Math.floor(elapsedMs / (1000 * 60));
            document.getElementById('timer-time-display').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        },
        start(type, details) {
            Object.assign(appState.timer, { isActive: true, isPaused: false, startTime: Date.now(), pauseTime: null, totalPausedMs: 0, type, details });
            appState.timer.intervalId = setInterval(this.tick, 1000);
            document.getElementById('timer-activity-name').textContent = details.name;
            this.tick();
            navigateTo('timer');
        },
        pause() { appState.timer.isPaused ? this.resume() : this._doPause(); },
        _doPause() {
            if (!appState.timer.isActive || appState.timer.isPaused) return;
            clearInterval(appState.timer.intervalId);
            appState.timer.isPaused = true;
            appState.timer.pauseTime = Date.now();
            document.querySelector('[data-action="pause-timer"]').textContent = 'Продолжить';
        },
        resume() {
            if (!appState.timer.isActive || !appState.timer.isPaused) return;
            appState.timer.totalPausedMs += Date.now() - appState.timer.pauseTime;
            appState.timer.isPaused = false;
            appState.timer.intervalId = setInterval(this.tick, 1000);
            document.querySelector('[data-action="pause-timer"]').textContent = 'Пауза';
        },
        stop() {
            if (!appState.timer.isActive) return;
            clearInterval(appState.timer.intervalId);
            this.tick();
            
            const logData = {
                startTime: new Date(appState.timer.startTime).toISOString(),
                endTime: new Date().toISOString(),
                duration_seconds: Math.round((Date.now() - appState.timer.startTime - appState.timer.totalPausedMs) / 1000),
            };

            const typeHandlers = {
                'work': () => {
                    appState.stimulusCallback = (stimulusEnd) => {
                        const workData = { user_id: appState.userId, task_name_raw: appState.timer.details.name, location: appState.timer.details.location, session_type: 'Работа', ...logData, stimulus_level_start: appState.timer.details.stimulusStart, stimulus_level_end: stimulusEnd };
                        fetchApi('/api/log_session', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(workData)})
                          .then(() => showToast('Рабочая сессия сохранена', 'success'));
                        navigateTo('break-prompt');
                    };
                    document.getElementById('stimulus-prompt-title').textContent = 'Как вы себя чувствуете после работы?';
                    navigateTo('stimulus-prompt');
                },
                'sport': () => {
                    const sportData = { user_id: appState.userId, name: appState.timer.details.name, ...logData };
                    fetchApi('/api/log_sport_activity', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(sportData)})
                      .then(() => showToast('Тренировка сохранена', 'success'));
                    navigateTo('home');
                },
                'break': () => {
                    appState.stimulusCallback = (stimulusEnd) => {
                        const breakData = { user_id: appState.userId, session_type: 'Перерыв', ...logData, stimulus_level_start: appState.timer.details.stimulusStart, stimulus_level_end: stimulusEnd };
                        fetchApi('/api/log_session', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(breakData)})
                          .then(() => showToast('Перерыв сохранен', 'success'));
                        navigateTo('home');
                    };
                    document.getElementById('stimulus-prompt-title').textContent = 'Как вы себя чувствуете после перерыва?';
                    navigateTo('stimulus-prompt');
                }
            };
            typeHandlers[appState.timer.type]?.();
            appState.timer = { isActive: false, isPaused: false, intervalId: null };
        }
    };

    // === EVENT HANDLER ===
    function handleAction(e) {
        const target = e.target.closest('[data-action]');
        if (!target) return;

        e.preventDefault();
        const { action, target: targetId, menu: menuId, type, pane } = target.dataset;

        const actionHandlers = {
            'navigate': () => {
                navigateTo(targetId);
                if (targetId === 'history') loadAndRenderHistory();
            },
            'toggle-pane': () => togglePane(pane),
            'toggle-menu': () => togglePopupMenu(menuId),
            'submit-thought': () => {
                const thoughtInput = document.getElementById('thought-input');
                const thought = thoughtInput.value.trim();
                if (thought) {
                    fetchApi(`/api/thoughts/${appState.userId}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ thought })})
                      .then(() => {
                        showToast('Мысль сохранена!', 'success');
                        thoughtInput.value = '';
                        togglePane('right');
                      });
                }
            },
            'run-analysis': () => {
                showToast('Запускаю анализ... Это может занять до минуты.', 'info');
                fetchApi(`/api/run_analysis/${appState.userId}`, { method: 'POST' })
                  .then(response => {
                        showToast(response.message, 'success');
                        navigateTo('history');
                        loadAndRenderHistory();
                  });
            },
            'start-timer': () => {
                const details = type === 'work' ? {
                    name: document.getElementById('work-title').value || 'Работа без названия', location: document.getElementById('work-location').value || 'Не указано', stimulusStart: document.getElementById('work-stimulus').value,
                } : {
                    name: (document.querySelector('#sport-type-group .choice-btn.selected')?.dataset.value) || 'Спорт', stimulusStart: document.getElementById('sport-stimulus').value,
                };
                Timer.start(type, details);
            },
            'pause-timer': Timer.pause.bind(Timer),
            'stop-timer': Timer.stop.bind(Timer),
            'submit-stimulus': () => {
                const stimulusValue = document.getElementById('prompt-stimulus-slider').value;
                if (appState.stimulusCallback) {
                    appState.stimulusCallback(stimulusValue);
                    appState.stimulusCallback = null;
                }
            },
            'start-break': () => {
                appState.stimulusCallback = (stimulusStart) => Timer.start('break', { name: 'Перерыв', stimulusStart });
                document.getElementById('stimulus-prompt-title').textContent = 'Как вы себя чувствуете перед перерывом?';
                navigateTo('stimulus-prompt');
            },
            'skip-break': () => {
                showToast('Перерыв пропущен');
                navigateTo('home');
            },
        };

        actionHandlers[action]?.();
    }
    
    // === INITIALIZATION ===
    document.body.addEventListener('click', handleAction);

    document.querySelectorAll('.choice-group').forEach(group => {
        group.addEventListener('click', e => {
            if (e.target.classList.contains('choice-btn')) {
                group.querySelectorAll('.choice-btn').forEach(btn => btn.classList.remove('selected'));
                e.target.classList.add('selected');
            }
        });
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.popup-menu') && !e.target.closest('[data-action="toggle-menu"]')) {
            closeAllPopups();
        }
    });
});
