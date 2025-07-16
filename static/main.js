document.addEventListener('DOMContentLoaded', () => {
    // === STATE MANAGEMENT ===
    const appState = {
        currentScreen: 'home',
        isPanelOpen: false,
        activeMenu: null,
        userId: document.body.dataset.userId,
        timer: {
            isActive: false,
            isPaused: false,
            startTime: null,
            pauseTime: null,
            totalPausedMs: 0,
            intervalId: null,
            type: null, // 'work', 'sport', 'break'
            details: {} // { name, location, stimulusStart, etc. }
        },
        stimulusCallback: null,
    };

    // === DOM ELEMENTS ===
    const screenWrapper = document.querySelector('.screen-wrapper');
    const thoughtsPanel = document.getElementById('thoughts-panel');

    // === NAVIGATION ===
    function navigateTo(targetScreenId) {
        const currentActive = document.querySelector('.screen.active');
        const nextScreen = document.getElementById(targetScreenId);

        if (currentActive && nextScreen && currentActive.id !== nextScreen.id) {
            screenWrapper.style.minHeight = `${currentActive.offsetHeight}px`; // Prevent layout jump
            
            currentActive.classList.add('exiting');
            nextScreen.classList.add('active');

            // Wait for animation to finish before cleaning up
            currentActive.addEventListener('transitionend', () => {
                currentActive.classList.remove('active', 'exiting');
                screenWrapper.style.minHeight = '';
            }, { once: true });
            
            appState.currentScreen = targetScreenId;
        }
        closeAllPopups();
    }

    // === UI HELPERS ===
    function toggleThoughtsPanel() {
        appState.isPanelOpen = !appState.isPanelOpen;
        thoughtsPanel.classList.toggle('open', appState.isPanelOpen);
        if (appState.isPanelOpen) {
            document.getElementById('thought-input').focus();
        }
    }

    function togglePopupMenu(menuId) {
        if (appState.activeMenu === menuId) {
            closeAllPopups();
            return;
        }
        closeAllPopups();
        const menu = document.getElementById(menuId);
        if (menu) {
            menu.classList.add('show');
            appState.activeMenu = menuId;
        }
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
    
    function renderList(containerId, templateId, data, renderItem) {
        const container = document.getElementById(containerId);
        const template = document.getElementById(templateId);
        container.innerHTML = '';
        if (data.length === 0) {
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
        const containerId = 'history-list';
        document.getElementById(containerId).innerHTML = '<div class="loader"></div>';
        fetchApi(`/api/analyses/${appState.userId}`)
            .then(data => {
                renderList(containerId, 'history-item-template', data, (clone, item) => {
                    clone.querySelector('.item-date').textContent = new Date(item.analysis_timestamp).toLocaleString('ru-RU');
                    clone.querySelector('.item-content').innerHTML = item.report_content; // Assuming markdown is pre-rendered or trusted
                });
            }).catch(() => document.getElementById(containerId).innerHTML = '<p>Не удалось загрузить историю.</p>');
    }

    function loadAndRenderThoughts() {
        const containerId = 'thoughts-list-container';
        document.getElementById(containerId).innerHTML = '<div class="loader"></div>';
        fetchApi(`/api/thoughts/${appState.userId}`)
            .then(data => {
                renderList(containerId, 'thought-item-template', data, (clone, item) => {
                    clone.querySelector('.item-date').textContent = new Date(item.timestamp).toLocaleString('ru-RU');
                    clone.querySelector('.item-content').textContent = item.content;
                });
            }).catch(() => document.getElementById(containerId).innerHTML = '<p>Не удалось загрузить мысли.</p>');
    }

    // === TIMER LOGIC ===
    const Timer = {
        tick() {
            const now = Date.now();
            const elapsedMs = now - appState.timer.startTime - appState.timer.totalPausedMs;
            const seconds = Math.floor(elapsedMs / 1000) % 60;
            const minutes = Math.floor(elapsedMs / (1000 * 60));
            document.getElementById('timer-time-display').textContent = 
                `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        },

        start(type, details) {
            Object.assign(appState.timer, {
                isActive: true,
                isPaused: false,
                startTime: Date.now(),
                pauseTime: null,
                totalPausedMs: 0,
                type: type,
                details: details,
            });
            appState.timer.intervalId = setInterval(this.tick, 1000);
            document.getElementById('timer-activity-name').textContent = details.name;
            this.tick();
            navigateTo('timer');
        },

        pause() {
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
            appState.timer.pauseTime = null;
            appState.timer.intervalId = setInterval(this.tick, 1000);
             document.querySelector('[data-action="pause-timer"]').textContent = 'Пауза';
        },

        stop(stoppedByUser = true) {
            if (!appState.timer.isActive) return;
            
            clearInterval(appState.timer.intervalId);
            this.tick(); // Final tick to get precise time
            
            const endTime = Date.now();
            const durationSeconds = Math.round((endTime - appState.timer.startTime - appState.timer.totalPausedMs) / 1000);
            
            const logData = {
                user_id: appState.userId,
                name: appState.timer.details.name,
                startTime: new Date(appState.timer.startTime).toISOString(),
                endTime: new Date(endTime).toISOString(),
                duration_seconds: durationSeconds,
            };
            
            // LOGIC FOR DIFFERENT TIMER TYPES
            if (appState.timer.type === 'work') {
                appState.stimulusCallback = (stimulusEnd) => {
                    const workData = {
                        user_id: appState.userId,
                        task_name_raw: appState.timer.details.name,
                        location: appState.timer.details.location,
                        session_type: 'Работа',
                        start_time: logData.startTime,
                        end_time: logData.endTime,
                        duration_seconds: logData.duration_seconds,
                        stimulus_level_start: appState.timer.details.stimulusStart,
                        stimulus_level_end: stimulusEnd,
                    };
                    fetchApi('/api/log_session', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(workData)
                    }).then(() => showToast('Рабочая сессия сохранена', 'success'));
                    
                    navigateTo('break-prompt');
                };
                document.getElementById('stimulus-prompt-title').textContent = 'Как вы себя чувствуете после работы?';
                navigateTo('stimulus-prompt');
            } else if (appState.timer.type === 'sport') {
                fetchApi('/api/log_sport_activity', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(logData)
                }).then(() => showToast('Тренировка сохранена', 'success'));
                navigateTo('home');
            } else if (appState.timer.type === 'break') {
                appState.stimulusCallback = (stimulusEnd) => {
                    const breakData = {
                        user_id: appState.userId,
                        session_type: 'Перерыв',
                        start_time: logData.startTime,
                        end_time: logData.endTime,
                        duration_seconds: logData.duration_seconds,
                        stimulus_level_start: appState.timer.details.stimulusStart,
                        stimulus_level_end: stimulusEnd,
                    };
                    fetchApi('/api/log_session', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(breakData)
                    }).then(() => showToast('Перерыв сохранен', 'success'));
                    navigateTo('home');
                };
                document.getElementById('stimulus-prompt-title').textContent = 'Как вы себя чувствуете после перерыва?';
                navigateTo('stimulus-prompt');
            }

            // Reset timer state
            appState.timer = { isActive: false, isPaused: false, intervalId: null };
        }
    };

    // === EVENT HANDLERS ===
    function handleAction(e) {
        const target = e.target.closest('[data-action]');
        if (!target) return;

        const { action, target: targetScreen, menu: menuId, type, value } = target.dataset;

        switch (action) {
            case 'navigate':
                navigateTo(targetScreen);
                if (targetScreen === 'history') loadAndRenderHistory();
                if (targetScreen === 'thoughts-list') loadAndRenderThoughts();
                break;
            case 'toggle-menu':
                togglePopupMenu(menuId);
                break;
            case 'toggle-thoughts-panel':
                toggleThoughtsPanel();
                break;
            case 'close-panel':
                if (appState.isPanelOpen) toggleThoughtsPanel();
                navigateTo('home');
                break;
            case 'submit-thought':
                const thoughtInput = document.getElementById('thought-input');
                const thought = thoughtInput.value.trim();
                if (thought) {
                    fetchApi(`/api/thoughts/${appState.userId}`, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ thought })
                    }).then(() => {
                        showToast('Мысль сохранена!', 'success');
                        thoughtInput.value = '';
                        toggleThoughtsPanel();
                    });
                }
                break;
            case 'start-timer':
                if (type === 'work') {
                    const name = document.getElementById('work-title').value || 'Работа без названия';
                    const location = document.getElementById('work-location').value || 'Не указано';
                    const stimulusStart = document.getElementById('work-stimulus').value;
                    Timer.start('work', { name, location, stimulusStart });
                } else if (type === 'sport') {
                    const selectedSport = document.querySelector('#sport-type-group .choice-btn.selected');
                    const name = selectedSport ? selectedSport.dataset.value : 'Спорт';
                    const stimulusStart = document.getElementById('sport-stimulus').value;
                    Timer.start('sport', { name, stimulusStart });
                }
                break;
            case 'pause-timer':
                appState.timer.isPaused ? Timer.resume() : Timer.pause();
                break;
            case 'stop-timer':
                Timer.stop();
                break;
            case 'submit-stimulus':
                const stimulusValue = document.getElementById('prompt-stimulus-slider').value;
                if (appState.stimulusCallback) {
                    appState.stimulusCallback(stimulusValue);
                    appState.stimulusCallback = null;
                }
                break;
            case 'start-break':
                appState.stimulusCallback = (stimulusStart) => {
                    Timer.start('break', { name: 'Перерыв', stimulusStart });
                };
                document.getElementById('stimulus-prompt-title').textContent = 'Как вы себя чувствуете перед перерывом?';
                navigateTo('stimulus-prompt');
                break;
            case 'skip-break':
                // Here you could log a skipped break if needed
                showToast('Перерыв пропущен');
                navigateTo('home');
                break;
        }
    }
    
    // === INITIALIZATION ===
    document.body.addEventListener('click', handleAction);

    // Handle choice button selection
    document.querySelectorAll('.choice-group').forEach(group => {
        group.addEventListener('click', e => {
            if (e.target.classList.contains('choice-btn')) {
                group.querySelectorAll('.choice-btn').forEach(btn => btn.classList.remove('selected'));
                e.target.classList.add('selected');
            }
        });
    });

    // Global click to close popups
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.popup-menu') && !e.target.closest('[data-action="toggle-menu"]')) {
            closeAllPopups();
        }
    });

});
