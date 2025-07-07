// =======================================================
//        ГЛОБАЛЬНОЕ СОСТОЯНИЕ И UI
// =======================================================
const TIMER_STATE_KEY = 'timerState';
const appState = {
    userId: null,
    session: {
        startTime: null,
        isRunning: false,
        isOvertime: false,
        taskName: null,
        elapsedSeconds: 0,
        totalDuration: 25 * 60 // По умолчанию 25 минут
    },
    timerInterval: null,
    isStopping: false // Флаг для предотвращения двойного логгирования при выходе
};

function getTimerState() { return JSON.parse(localStorage.getItem(TIMER_STATE_KEY) || 'null'); }
function setTimerState(state) { localStorage.setItem(TIMER_STATE_KEY, JSON.stringify(state)); }
function clearTimerState() { localStorage.removeItem(TIMER_STATE_KEY); }

function showModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('visible'), 10);
    }
}

function hideModals() {
    document.querySelectorAll('.modal-overlay.visible').forEach(m => {
        m.classList.remove('visible');
        setTimeout(() => m.style.display = 'none', 200);
    });
}

function updatePersistentBar() {
    const bar = document.getElementById('persistent-timer-bar');
    if (!bar) return;

    // Очищаем старый интервал, если он есть
    if (bar.intervalId) clearInterval(bar.intervalId);

    const st = getTimerState();
    if (st && st.isWorkSessionActive && !document.querySelector('.timer-page')) {
        bar.classList.add('visible');
        bar.querySelector('.task-name').textContent = st.taskName;
        bar.querySelector('#return-to-timer-btn').href = `/timer/${st.userId}?task=${encodeURIComponent(st.taskName)}`;

        bar.intervalId = setInterval(() => {
            let elapsed = st.elapsedSecondsOnSave;
            if (st.isRunning) {
                elapsed += (Date.now() - st.lastSaveTimestamp) / 1000;
            }

            const remaining = st.totalDurationSeconds - elapsed;
            const isOvertime = remaining < 0;
            const displayTime = Math.abs(remaining);
            const minutes = Math.floor(displayTime / 60);
            const seconds = Math.floor(displayTime % 60);

            bar.querySelector('.time-display').textContent = `${isOvertime ? '+' : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
            const statusDot = bar.querySelector('.status-dot');
            if (statusDot) {
                statusDot.style.backgroundColor = isOvertime ? 'var(--orange-color)' : 'var(--green-color)';
            }
        }, 1000);
    } else {
        bar.classList.remove('visible');
    }
}


// =======================================================
//        API ЛОГИРОВАНИЕ
// =======================================================
function logSession(data) {
    if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        navigator.sendBeacon('/api/log_session', blob);
    } else {
        fetch('/api/log_session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })
        .then(response => response.json())
        .then(data => {
            if (data.status !== 'success') {
                console.error('Failed to log session:', data.message);
            }
        })
        .catch(error => console.error('Failed to log session:', error));
    }
}

// =======================================================
//        ИНФРАСТРУКТУРА МОДАЛОВ
// =======================================================
function initStartSessionModal() {
    const showBtn = document.getElementById('show-session-modal-btn');
    const modal = document.getElementById('start-session-modal');
    const confirm = document.getElementById('confirm-start-btn');
    const cancel = document.getElementById('cancel-start-btn');
    const input = document.getElementById('task-name-input');
    const uid = document.body.dataset.userId;
    if (showBtn) showBtn.addEventListener('click', () => showModal('start-session-modal'));
    if (cancel) cancel.addEventListener('click', hideModals);
    if (confirm) confirm.addEventListener('click', () => {
        const name = input.value.trim();
        if (name) {
            hideModals();
            window.location.href = `/timer/${uid}?task=${encodeURIComponent(name)}`;
        } else {
            alert('Пожалуйста, введите название задачи.');
        }
    });
}

// =======================================================
//        ИНИЦИАЛИЗАЦИЯ FAB
// =======================================================
function initFabMenu() {
    const fab = document.getElementById('timer-fab') || document.querySelector('.fab');
    const menu = document.getElementById('timer-fab-menu');
    const btn = document.getElementById('fab-menu-session-btn');
    const modal = document.querySelector('.modal-overlay');
    if (fab && menu) {
        fab.addEventListener('click', e => {
            e.stopPropagation();
            menu.classList.toggle('visible');
        });
        document.addEventListener('click', () => menu.classList.remove('visible'));
        menu.addEventListener('click', e => e.stopPropagation());
        if (btn) btn.addEventListener('click', e => {
            e.preventDefault();
            menu.classList.remove('visible');
            const st = getTimerState();
            if (st && st.isWorkSessionActive) {
                window.location.href = `/timer/${st.userId}?task=${encodeURIComponent(st.taskName)}`;
            } else if (modal) {
                showModal('task-modal');
            }
        });
    }
}

function initModalClose() {
    const close = document.getElementById('close-modal-btn');
    if (close) close.addEventListener('click', hideModals);
}

// =======================================================
//        ТАЙМЕРНАЯ ЛОГИКА
// =======================================================
function initTimerPage() {
    const uid = document.body.dataset.userId;
    appState.userId = uid;
    const params = new URLSearchParams(location.search);
    appState.session.taskName = params.get('task') || 'Без названия';

    const taskNameEl = document.querySelector('.timer-header h1');
    if (taskNameEl) taskNameEl.textContent = appState.session.taskName;

    const timeDisplay = document.querySelector('.time-display');
    const startPauseBtn = document.querySelector('.control-btn-main');
    const stopBtn = document.querySelector('.control-btn-secondary');
    const decreaseBtn = document.getElementById('decrease-time-btn');
    const increaseBtn = document.getElementById('increase-time-btn');
    const presets = document.querySelectorAll('.time-preset-btn');
    const progressBar = document.querySelector('.timer-progress .progress-bar');
    const circumference = progressBar ? 2 * Math.PI * progressBar.r.baseVal.value : 0;

    function saveState() {
        if (!appState.session.startTime) return;
        const stateToSave = {
            isWorkSessionActive: true,
            userId: appState.userId,
            taskName: appState.session.taskName,
            workSessionStartTime: appState.session.startTime,
            totalDurationSeconds: appState.session.totalDuration,
            isRunning: appState.session.isRunning,
            elapsedSecondsOnSave: appState.session.elapsedSeconds,
            lastSaveTimestamp: Date.now()
        };
        setTimerState(stateToSave);
    }

    function updateUI() {
        const isSessionActive = appState.session.elapsedSeconds > 0 || appState.session.isRunning;
        const displayTime = appState.session.isOvertime
            ? appState.session.elapsedSeconds - appState.session.totalDuration
            : appState.session.totalDuration - appState.session.elapsedSeconds;

        const minutes = Math.floor(Math.abs(displayTime) / 60);
        const seconds = Math.floor(Math.abs(displayTime) % 60);

        timeDisplay.textContent = `${appState.session.isOvertime ? '+' : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        timeDisplay.classList.toggle('overtime', appState.session.isOvertime);
        
        if (progressBar) {
            progressBar.classList.toggle('overtime', appState.session.isOvertime);
            if(appState.session.isOvertime) {
                progressBar.style.strokeDashoffset = 0;
            } else {
                const progress = Math.min(1, appState.session.elapsedSeconds / appState.session.totalDuration);
                progressBar.style.strokeDashoffset = circumference * (1 - progress);
            }
        }

        if (appState.session.isOvertime) {
            startPauseBtn.textContent = 'Завершено';
            startPauseBtn.disabled = true;
        } else {
            startPauseBtn.textContent = appState.session.isRunning ? 'Пауза' : (isSessionActive ? 'Продолжить' : 'Старт');
            startPauseBtn.disabled = false;
        }
        
        startPauseBtn.classList.toggle('paused', appState.session.isRunning);
        decreaseBtn.disabled = isSessionActive;
        increaseBtn.disabled = isSessionActive;
        presets.forEach(p => p.disabled = isSessionActive);
    }

    function setDuration(minutes) {
        if (appState.session.isRunning || appState.session.elapsedSeconds > 0) return;
        appState.session.totalDuration = Math.max(60, Math.min(180 * 60, minutes * 60));
        appState.session.elapsedSeconds = 0;
        updateUI();
    }

    function start() {
        if (appState.session.isRunning) return;
        appState.session.isRunning = true;
        if (!appState.session.startTime) {
            appState.session.startTime = new Date().toISOString();
        }

        const baseTime = Date.now() - appState.session.elapsedSeconds * 1000;
        appState.timerInterval = setInterval(() => {
            appState.session.elapsedSeconds = Math.floor((Date.now() - baseTime) / 1000);
            if (!appState.session.isOvertime && appState.session.elapsedSeconds >= appState.session.totalDuration) {
                appState.session.isOvertime = true;
                // Optional: play a sound
            }
            updateUI();
        }, 250);
        
        saveState();
        updateUI();
    }

    function pause() {
        if (!appState.session.isRunning) return;
        appState.session.isRunning = false;
        clearInterval(appState.timerInterval);
        saveState();
        updateUI();
    }

    function stop() {
        if (appState.isStopping) return;
        appState.isStopping = true;

        clearInterval(appState.timerInterval);
        appState.session.isRunning = false;
        
        if (appState.session.startTime && appState.session.elapsedSeconds > 0) {
            logSession({
                user_id: uid,
                task_name: appState.session.taskName,
                start_time: appState.session.startTime,
                end_time: new Date().toISOString(),
                duration_seconds: Math.floor(appState.session.elapsedSeconds)
            });
        }
        clearTimerState();
        window.location.href = `/dashboard/${uid}`;
    }

    function restoreState() {
        const saved = getTimerState();
        if (saved && saved.userId === uid && saved.taskName === appState.session.taskName) {
            appState.session.startTime = saved.workSessionStartTime;
            appState.session.totalDuration = saved.totalDurationSeconds;
            
            let elapsedSinceSave = 0;
            if (saved.isRunning && saved.lastSaveTimestamp) {
                elapsedSinceSave = (Date.now() - saved.lastSaveTimestamp) / 1000;
            }
            appState.session.elapsedSeconds = saved.elapsedSecondsOnSave + elapsedSinceSave;
            appState.session.isOvertime = appState.session.elapsedSeconds >= appState.session.totalDuration;
            
            if (saved.isRunning) {
                start();
            } else {
                updateUI();
            }
        } else {
            updateUI();
        }
    }

    if (startPauseBtn) startPauseBtn.addEventListener('click', () => appState.session.isRunning ? pause() : start());
    if (stopBtn) stopBtn.addEventListener('click', stop);
    if (decreaseBtn) decreaseBtn.addEventListener('click', () => setDuration(appState.session.totalDuration / 60 - 5));
    if (increaseBtn) increaseBtn.addEventListener('click', () => setDuration(appState.session.totalDuration / 60 + 5));
    if (presets) presets.forEach(btn => btn.addEventListener('click', () => setDuration(parseInt(btn.dataset.minutes))));
    
    window.addEventListener('beforeunload', () => {
        if (appState.session.isRunning) saveState();
    });
     window.addEventListener('unload', () => {
        if (appState.session.startTime && !appState.isStopping) {
             stop();
        }
    });

    restoreState();
}


// =======================================================
//        ДИНАМИКА И ЧАРТЫ
// =======================================================
function initDynamicsPage() {
    const uid = document.body.dataset.userId;
    const backBtn = document.getElementById('back-to-timer-from-dynamics');
    if (backBtn) {
        const st = getTimerState();
        if (st && st.isWorkSessionActive) {
            backBtn.style.display = 'inline-block';
            backBtn.href = `/timer/${st.userId}?task=${encodeURIComponent(st.taskName)}`;
        }
    }
    const weeksFilter = document.getElementById('weeks-filter');
    const dayPicker = document.getElementById('day-picker');
    const ctxDaily = document.getElementById('dailyActivityChart')?.getContext('2d');
    const ctxHourly = document.getElementById('hourlyActivityChart')?.getContext('2d');
    let dailyChart, hourlyChart, dataAll;

    async function fetchData() {
        try {
            const res = await fetch(`/api/dynamics_data/${uid}`);
            dataAll = await res.json();
            if (dataAll.error) throw new Error(dataAll.error);
            renderCalendars(dataAll.calendars);
            weeksFilter.innerHTML = '';
            for (let i = 1; i <= dataAll.total_weeks; i++) weeksFilter.add(new Option(`${i} нед.`, i));
            weeksFilter.value = Math.min(4, dataAll.total_weeks);
            dayPicker.value = new Date().toISOString().split('T')[0];
            renderDaily(weeksFilter.value);
            renderHourly(dayPicker.value);
        } catch (e) {
            console.error('Failed to fetch dynamics data:', e);
        }
    }

    function renderCalendars(cals) {
        const cont = document.getElementById('calendars-container');
        cont.innerHTML = '';
        if (!cals || !Object.keys(cals).length) { cont.innerHTML = '<p>Нет данных по задачам.</p>'; return; }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        Object.entries(cals).forEach(([task, dates]) => {
            const div = document.createElement('div');
            div.className = 'calendar';
            let html = `<div class="calendar-header">${task}</div><div class="calendar-body">`;
            ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].forEach(d => html += `<div class="calendar-day header">${d}</div>`);
            const date = new Date(today.getFullYear(), today.getMonth(), 1);
            const offset = date.getDay() == 0 ? 6 : date.getDay() - 1;
            for (let i = 0; i < offset; i++) html += `<div class="calendar-day"></div>`;
            while (date.getMonth() === today.getMonth()) {
                const ds = date.toISOString().split('T')[0];
                let cls = 'calendar-day' + (dates.includes(ds) ? ' active' : '') + (date.getTime() === today.getTime() ? ' today' : '');
                html += `<div class="${cls}">${date.getDate()}</div>`;
                date.setDate(date.getDate() + 1);
            }
            html += '</div>';
            div.innerHTML = html;
            cont.appendChild(div);
        });
    }

    function renderDaily(weeks) {
        const days = weeks * 7;
        const labels = dataAll.activity_by_day.labels.slice(-days);
        const vals = dataAll.activity_by_day.data.slice(-days);
        if (dailyChart) dailyChart.destroy();
        dailyChart = new Chart(ctxDaily, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data: vals,
                    label: 'Часы работы',
                    backgroundColor: 'rgba(0, 122, 255, 0.6)',
                    borderColor: 'rgba(0, 122, 255, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                scales: { y: { beginAtZero: true, max: 15 } },
                plugins: { legend: { display: false } }
            }
        });
    }

    function renderHourly(day) {
        const arr = Array(24).fill(0);
        dataAll.activity_by_hour.filter(d => d.start_time.startsWith(day)).forEach(s => arr[s.hour] += s.duration_hours);
        if (hourlyChart) hourlyChart.destroy();
        hourlyChart = new Chart(ctxHourly, {
            type: 'bar',
            data: {
                labels: Array.from({ length: 24 }, (_, i) => `${i}:00`),
                datasets: [{
                    data: arr,
                    label: `Часы за ${day}`,
                    backgroundColor: 'rgba(0, 122, 255, 0.6)',
                    borderColor: 'rgba(0, 122, 255, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                scales: { y: { beginAtZero: true } },
                plugins: { legend: { display: false } }
            }
        });
    }

    if (weeksFilter) weeksFilter.addEventListener('change', () => renderDaily(weeksFilter.value));
    if (dayPicker) dayPicker.addEventListener('change', () => renderHourly(dayPicker.value));

    fetchData();
}

// =======================================================
//        ИНИЦИАЛИЗАЦИЯ СТРАНИЦЫ
// =======================================================
document.addEventListener('DOMContentLoaded', () => {
    appState.userId = document.body.dataset.userId;
    const fab = document.getElementById('timer-fab') || document.querySelector('.fab');
    const startSessionModal = document.getElementById('task-modal');

    // --- Логика плавающей кнопки (FAB) и меню ---
    initFabMenu();
    initModalClose();
    updatePersistentBar();

    // --- Логика модального окна для старта сессии ---
    if (startSessionModal) {
        const taskForm = document.getElementById('task-form');
        const cancelBtn = document.getElementById('close-modal-btn');
        const taskInput = document.getElementById('task-name-input');
        
        if (cancelBtn) {
            cancelBtn.addEventListener('click', hideModals);
        }
        
        if (taskForm && taskInput) {
            taskForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const taskName = taskInput.value.trim();
                if (taskName && appState.userId) {
                    hideModals();
                    window.location.href = `/timer/${appState.userId}?task=${encodeURIComponent(taskName)}`;
                } else if (!taskName) {
                    alert('Пожалуйста, введите название задачи.');
                }
            });
        }
    }

    // --- Инициализация страниц ---
    if (document.querySelector('.timer-page')) initTimerPage();
    if (document.querySelector('.dynamics-page')) initDynamicsPage();
});
