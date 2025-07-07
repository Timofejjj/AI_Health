// =======================================================
//        ГЛОБАЛЬНОЕ СОСТОЯНИЕ И UI
// =======================================================
const TIMER_STATE_KEY = 'timerState';
const appState = {
    userId: null,
    session: {
        mode: 'work', // 'work' | 'break'
        startTime: null,
        isRunning: false,
        taskName: null,
        elapsedSeconds: 0,
        totalDuration: 25 * 60,
        breakDuration: 10 * 60 // Длительность перерыва по умолчанию
    },
    timerInterval: null
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
    const st = getTimerState();
    if (!bar) return;

    if (bar.intervalId) {
        clearInterval(bar.intervalId);
        bar.intervalId = null;
    }

    if (st && st.isWorkSessionActive && !document.querySelector('.timer-page')) {
        bar.classList.add('visible');
        bar.querySelector('.task-name').textContent = st.taskName;
        bar.querySelector('#return-to-timer-btn').href = `/timer/${st.userId}?task=${encodeURIComponent(st.taskName)}`;
        
        const updateBarTime = () => {
            const elapsed = Math.floor((Date.now() - new Date(st.workSessionStartTime)) / 1000);
            const remaining = st.totalDurationSeconds - elapsed;
            const isOvertime = remaining < 0;
            const displaySeconds = Math.abs(remaining);
            const minutes = Math.floor(displaySeconds / 60);
            const seconds = displaySeconds % 60;
            bar.querySelector('.time-display').textContent = `${isOvertime ? '+' : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        };
        
        updateBarTime();
        bar.intervalId = setInterval(updateBarTime, 1000);

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
            body: JSON.stringify(data),
            keepalive: true
        }).catch(error => console.error('Failed to log session:', error));
    }
}

// =======================================================
//        ИНФРАСТРУКТУРА МОДАЛОВ И FAB
// =======================================================
function initFabMenu() {
    const fab = document.getElementById('timer-fab');
    const menu = document.getElementById('timer-fab-menu');
    const btn = document.getElementById('fab-menu-session-btn');
    if (fab && menu && btn) {
        fab.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('visible'); });
        document.addEventListener('click', () => menu.classList.remove('visible'));
        menu.addEventListener('click', e => e.stopPropagation());
        btn.addEventListener('click', e => {
            e.preventDefault();
            menu.classList.remove('visible');
            const st = getTimerState();
            if (st && st.isWorkSessionActive) {
                window.location.href = `/timer/${st.userId}?task=${encodeURIComponent(st.taskName)}`;
            } else {
                showModal('task-modal');
            }
        });
    }
}

function initModalClose() {
    document.getElementById('close-modal-btn')?.addEventListener('click', hideModals);
}

// =======================================================
//        НОВАЯ ЛОГИКА ТАЙМЕРА (РАБОТА + ПЕРЕРЫВ)
// =======================================================
function initTimerPage() {
    const uid = document.body.dataset.userId;
    appState.userId = uid;
    const params = new URLSearchParams(location.search);
    appState.session.taskName = params.get('task') || 'Без названия';

    // --- DOM элементы ---
    const taskTitleHeader = document.getElementById('task-title-header');
    const sessionLabel = document.getElementById('session-label');
    const timeDisplay = document.querySelector('.timer-widget .time-display');
    
    const workControls = document.getElementById('work-session-controls');
    const startPauseBtn = workControls.querySelector('.control-btn-main');
    const stopBtn = workControls.querySelector('.control-btn-secondary');
    const decreaseBtn = document.getElementById('decrease-time-btn');
    const increaseBtn = document.getElementById('increase-time-btn');
    const workPresets = workControls.querySelectorAll('.time-preset-btn');

    const breakControls = document.getElementById('break-session-controls');
    const startBreakBtn = document.getElementById('start-break-btn');
    const skipBreakBtn = document.getElementById('skip-break-btn');
    const breakPresets = breakControls.querySelectorAll('.break-preset-btn');

    taskTitleHeader.textContent = appState.session.taskName;

    const tick = () => {
        appState.session.elapsedSeconds++;
        const duration = (appState.session.mode === 'work') ? appState.session.totalDuration : appState.session.breakDuration;
        
        if (appState.session.elapsedSeconds >= duration) {
            if (appState.session.mode === 'work') {
                endWorkSession();
            } else { // break
                endBreak();
            }
        }
        updateUI();
    };

    function updateUI() {
        // Определяем, какое время показывать
        const duration = (appState.session.mode === 'work') ? appState.session.totalDuration : appState.session.breakDuration;
        const remaining = duration - appState.session.elapsedSeconds;
        const isOvertime = appState.session.mode === 'work' && remaining < 0;

        const minutes = Math.floor(Math.abs(remaining) / 60);
        const seconds = Math.abs(remaining) % 60;
        timeDisplay.textContent = `${isOvertime ? '+' : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        timeDisplay.classList.toggle('overtime', isOvertime);

        // Переключаем видимость блоков управления
        if (appState.session.mode === 'work') {
            workControls.classList.remove('hidden');
            breakControls.classList.add('hidden');
            sessionLabel.textContent = 'СЕССИЯ';
            startPauseBtn.textContent = appState.session.isRunning ? 'Пауза' : (appState.session.elapsedSeconds > 0 ? 'Продолжить' : 'Старт');
            startPauseBtn.classList.toggle('paused', appState.session.isRunning);
        } else { // 'break'
            workControls.classList.add('hidden');
            breakControls.classList.remove('hidden');
            sessionLabel.textContent = 'ПЕРЕРЫВ';
            if(appState.session.isRunning) {
                 startBreakBtn.textContent = 'Завершить перерыв';
                 startBreakBtn.classList.add('paused');
            } else {
                 startBreakBtn.textContent = 'Начать перерыв';
                 startBreakBtn.classList.remove('paused');
            }
        }

        const timerHasStarted = appState.session.elapsedSeconds > 0;
        decreaseBtn.disabled = appState.session.isRunning || timerHasStarted;
        increaseBtn.disabled = appState.session.isRunning || timerHasStarted;
        workPresets.forEach(p => p.disabled = appState.session.isRunning || timerHasStarted);
        updatePersistentBar();
    }
    
    // --- Управление рабочим циклом ---
    function startWork() {
        if (appState.session.isRunning) return;
        appState.session.isRunning = true;
        if (!appState.session.startTime) appState.session.startTime = new Date().toISOString();
        
        appState.timerInterval = setInterval(tick, 1000);
        
        setTimerState({
            isWorkSessionActive: true,
            userId: uid,
            taskName: appState.session.taskName,
            workSessionStartTime: appState.session.startTime,
            totalDurationSeconds: appState.session.totalDuration
        });
        updateUI();
    }

    function pauseWork() {
        if (!appState.session.isRunning) return;
        appState.session.isRunning = false;
        clearInterval(appState.timerInterval);
        updateUI();
    }

    function endWorkSession() {
        clearInterval(appState.timerInterval);
        const st = getTimerState();
        if (st && st.isWorkSessionActive) {
            logSession({
                user_id: uid,
                task_name: appState.session.taskName,
                start_time: st.workSessionStartTime,
                end_time: new Date().toISOString(),
                duration_seconds: appState.session.elapsedSeconds
            });
        }
        clearTimerState();
        appState.session.isRunning = false;
        appState.session.mode = 'break';
        appState.session.elapsedSeconds = 0;
        updateUI();
    }

    // --- Управление перерывом ---
    function startBreak() {
        appState.session.isRunning = true;
        appState.timerInterval = setInterval(tick, 1000);
        updateUI();
    }
    
    function endBreak() {
        clearInterval(appState.timerInterval);
        appState.session.isRunning = false;
        appState.session.mode = 'work';
        appState.session.elapsedSeconds = 0;
        appState.session.startTime = null; 
        appState.session.totalDuration = 25 * 60; // Сброс на стандартное время
        updateUI();
    }

    // --- Привязка событий ---
    startPauseBtn.addEventListener('click', () => appState.session.isRunning ? pauseWork() : startWork());
    stopBtn.addEventListener('click', endWorkSession);
    decreaseBtn.addEventListener('click', () => { appState.session.totalDuration = Math.max(60, appState.session.totalDuration - 300); updateUI(); });
    increaseBtn.addEventListener('click', () => { appState.session.totalDuration = Math.min(180 * 60, appState.session.totalDuration + 300); updateUI(); });
    workPresets.forEach(btn => btn.addEventListener('click', () => { appState.session.totalDuration = parseInt(btn.dataset.minutes) * 60; updateUI(); }));

    startBreakBtn.addEventListener('click', () => {
        if(appState.session.isRunning) {
            endBreak(); // Если перерыв идет, кнопка его завершает
        } else {
            startBreak();
        }
    });
    skipBreakBtn.addEventListener('click', endBreak);
    breakPresets.forEach(btn => {
        btn.addEventListener('click', () => {
            breakPresets.forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            appState.session.breakDuration = parseInt(btn.dataset.minutes) * 60;
            updateUI();
        });
    });

    // --- Инициализация при загрузке ---
    const existingState = getTimerState();
    if (existingState && existingState.isWorkSessionActive && existingState.taskName === appState.session.taskName) {
        appState.session.totalDuration = existingState.totalDurationSeconds;
        appState.session.startTime = existingState.workSessionStartTime;
        appState.session.elapsedSeconds = Math.floor((Date.now() - new Date(existingState.workSessionStartTime).getTime()) / 1000);
        startWork();
    } else {
        updateUI(); 
    }
}


// =======================================================
//        ДИНАМИКА И ЧАРТЫ (без изменений)
// =======================================================
function initDynamicsPage() {
    const uid = document.body.dataset.userId;
    async function fetchData() {
        try {
            const res = await fetch(`/api/dynamics_data/${uid}`);
            const dataAll = await res.json();
            if (dataAll.error) throw new Error(dataAll.error);
            renderCalendars(dataAll.calendars);
            const weeksFilter = document.getElementById('weeks-filter');
            weeksFilter.innerHTML = '';
            for (let i = 1; i <= dataAll.total_weeks; i++) weeksFilter.add(new Option(`${i} нед.`, i));
            weeksFilter.value = Math.min(4, dataAll.total_weeks);
            const dayPicker = document.getElementById('day-picker');
            dayPicker.value = new Date().toISOString().split('T')[0];
            
            let dailyChart, hourlyChart;
            const ctxDaily = document.getElementById('dailyActivityChart')?.getContext('2d');
            const ctxHourly = document.getElementById('hourlyActivityChart')?.getContext('2d');

            function renderDaily(weeks) {
                const days = weeks * 7;
                const labels = dataAll.activity_by_day.labels.slice(-days);
                const vals = dataAll.activity_by_day.data.slice(-days);
                if (dailyChart) dailyChart.destroy();
                dailyChart = new Chart(ctxDaily, { type: 'bar', data: { labels, datasets: [{ data: vals, label: 'Часы работы', backgroundColor: 'rgba(0, 122, 255, 0.6)' }] }, options: { scales: { y: { beginAtZero: true, max: 15 } }, plugins: { legend: { display: false } } } });
            }

            function renderHourly(day) {
                const arr = Array(24).fill(0);
                dataAll.activity_by_hour.filter(d => d.start_time.startsWith(day)).forEach(s => arr[s.hour] += s.duration_hours);
                if (hourlyChart) hourlyChart.destroy();
                hourlyChart = new Chart(ctxHourly, { type: 'bar', data: { labels: Array.from({ length: 24 }, (_, i) => `${i}:00`), datasets: [{ data: arr, label: `Часы за ${day}`, backgroundColor: 'rgba(0, 122, 255, 0.6)' }] }, options: { scales: { y: { beginAtZero: true } }, plugins: { legend: { display: false } } } });
            }

            renderDaily(weeksFilter.value);
            renderHourly(dayPicker.value);
            weeksFilter.addEventListener('change', () => renderDaily(weeksFilter.value));
            dayPicker.addEventListener('change', () => renderHourly(dayPicker.value));

        } catch (e) { console.error('Failed to fetch dynamics data:', e); }
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
            const offset = date.getDay() === 0 ? 6 : date.getDay() - 1;
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
    fetchData();
}

// =======================================================
//        ИНИЦИАЛИЗАЦИЯ СТРАНИЦЫ
// =======================================================
document.addEventListener('DOMContentLoaded', () => {
    appState.userId = document.body.dataset.userId;
    initFabMenu();
    initModalClose();
    updatePersistentBar();
    const taskForm = document.getElementById('task-form');
    if (taskForm) {
        taskForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const taskName = document.getElementById('task-name-input').value.trim();
            if (taskName && appState.userId) {
                hideModals();
                window.location.href = `/timer/${appState.userId}?task=${encodeURIComponent(taskName)}`;
            }
        });
    }
    if (document.querySelector('.timer-page')) initTimerPage();
    if (document.querySelector('.dynamics-page')) initDynamicsPage();
});
