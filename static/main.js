// =======================================================
//        ГЛОБАЛЬНОЕ СОСТОЯНИЕ И UI
// =======================================================
const TIMER_STATE_KEY = 'timerState';
const appState = {
    userId: null,
    session: {
        mode: 'work', // 'work' | 'break'
        startTime: null, // Время начала текущей фазы (работы или перерыва)
        isRunning: false,
        taskName: null,
        elapsedSeconds: 0,
        totalDuration: 25 * 60,
        breakDuration: 10 * 60
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

    if (st && st.isActive && !document.querySelector('.timer-page')) {
        bar.classList.add('visible');
        bar.querySelector('.task-name').textContent = st.mode === 'work' ? st.taskName : 'Перерыв';
        bar.querySelector('#return-to-timer-btn').href = `/timer/${st.userId}?task=${encodeURIComponent(st.taskName)}`;
        
        const updateBarTime = () => {
            const elapsed = Math.floor((Date.now() - new Date(st.startTime).getTime()) / 1000);
            const remaining = st.totalDuration - elapsed;
            const isOvertime = st.mode === 'work' && remaining < 0;
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
            if (st && st.isActive) { // Проверяем, активна ли любая сессия (работа или перерыв)
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
//        ЛОГИКА ТАЙМЕРА (РАБОТА + ПЕРЕРЫВ)
// =======================================================
function initTimerPage() {
    const uid = document.body.dataset.userId;
    appState.userId = uid;
    const params = new URLSearchParams(location.search);
    appState.session.taskName = params.get('task') || 'Без названия';

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

    function saveCurrentState() {
        const stateToSave = {
            isActive: true,
            isRunning: appState.session.isRunning,
            mode: appState.session.mode,
            userId: appState.userId,
            taskName: appState.session.taskName,
            startTime: appState.session.startTime,
            totalDuration: appState.session.mode === 'work' ? appState.session.totalDuration : appState.session.breakDuration,
            workDuration: appState.session.totalDuration,
            breakDuration: appState.session.breakDuration,
        };
        setTimerState(stateToSave);
    }
    
    const tick = () => {
        appState.session.elapsedSeconds = Math.floor((Date.now() - new Date(appState.session.startTime).getTime()) / 1000);
        const duration = (appState.session.mode === 'work') ? appState.session.totalDuration : appState.session.breakDuration;
        
        if (appState.session.elapsedSeconds >= duration && appState.session.mode === 'work') {
            endWorkSession();
        } else if (appState.session.elapsedSeconds >= duration && appState.session.mode === 'break') {
            endBreak();
        }
        updateUI();
    };

    function updateUI() {
        const duration = (appState.session.mode === 'work') ? appState.session.totalDuration : appState.session.breakDuration;
        const remaining = duration - appState.session.elapsedSeconds;
        const isOvertime = appState.session.mode === 'work' && remaining < 0;

        const minutes = Math.floor(Math.abs(remaining) / 60);
        const seconds = Math.abs(remaining) % 60;
        timeDisplay.textContent = `${isOvertime ? '+' : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        timeDisplay.classList.toggle('overtime', isOvertime);

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
            startBreakBtn.textContent = appState.session.isRunning ? 'Завершить перерыв' : 'Начать перерыв';
            startBreakBtn.classList.toggle('paused', appState.session.isRunning);
        }
        decreaseBtn.disabled = appState.session.isRunning || appState.session.elapsedSeconds > 0;
        increaseBtn.disabled = appState.session.isRunning || appState.session.elapsedSeconds > 0;
        workPresets.forEach(p => p.disabled = appState.session.isRunning || appState.session.elapsedSeconds > 0);
        updatePersistentBar();
    }
    
    function startWork() {
        if (appState.session.isRunning) return;
        appState.session.isRunning = true;
        if (!appState.session.startTime || appState.session.mode !== 'work') {
            appState.session.startTime = new Date().toISOString();
        }
        appState.timerInterval = setInterval(tick, 1000);
        saveCurrentState();
        updateUI();
    }

    function pauseWork() {
        if (!appState.session.isRunning) return;
        appState.session.isRunning = false;
        clearInterval(appState.timerInterval);
        saveCurrentState();
        updateUI();
    }

    function endWorkSession() {
        clearInterval(appState.timerInterval);
        const st = getTimerState();
        if (st && st.isActive && st.mode === 'work') {
            const durationToSend = Math.min(appState.session.elapsedSeconds, appState.session.totalDuration);
            logSession({
                user_id: uid, task_name: st.taskName, start_time: st.startTime,
                end_time: new Date().toISOString(), duration_seconds: durationToSend
            });
        }
        appState.session.isRunning = false;
        appState.session.mode = 'break';
        appState.session.elapsedSeconds = 0;
        appState.session.startTime = null; // сброс, установится при старте перерыва
        saveCurrentState(); // Сохраняем состояние "ожидания перерыва"
        updateUI();
    }

    function startBreak() {
        if (appState.session.isRunning) return;
        appState.session.isRunning = true;
        appState.session.startTime = new Date().toISOString();
        appState.timerInterval = setInterval(tick, 1000);
        saveCurrentState();
        updateUI();
    }
    
    function endBreak() {
        clearInterval(appState.timerInterval);
        appState.session.isRunning = false;
        appState.session.mode = 'work';
        appState.session.elapsedSeconds = 0;
        appState.session.startTime = null; 
        appState.session.totalDuration = 25 * 60;
        clearTimerState(); // Полное завершение цикла
        updateUI();
    }

    startPauseBtn.addEventListener('click', () => appState.session.isRunning ? pauseWork() : startWork());
    stopBtn.addEventListener('click', endWorkSession);
    decreaseBtn.addEventListener('click', () => { appState.session.totalDuration = Math.max(60, appState.session.totalDuration - 300); updateUI(); });
    increaseBtn.addEventListener('click', () => { appState.session.totalDuration = Math.min(180 * 60, appState.session.totalDuration + 300); updateUI(); });
    workPresets.forEach(btn => btn.addEventListener('click', () => { appState.session.totalDuration = parseInt(btn.dataset.minutes) * 60; updateUI(); }));
    startBreakBtn.addEventListener('click', () => appState.session.isRunning ? endBreak() : startBreak());
    skipBreakBtn.addEventListener('click', endBreak);
    breakPresets.forEach(btn => {
        btn.addEventListener('click', () => {
            breakPresets.forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            appState.session.breakDuration = parseInt(btn.dataset.minutes) * 60;
        });
    });

    const existingState = getTimerState();
    if (existingState && existingState.isActive && existingState.taskName === appState.session.taskName) {
        appState.session.mode = existingState.mode;
        appState.session.totalDuration = existingState.workDuration;
        appState.session.breakDuration = existingState.breakDuration;
        appState.session.startTime = existingState.startTime;
        appState.session.isRunning = existingState.isRunning;
        
        if (appState.session.isRunning) {
            appState.session.elapsedSeconds = Math.floor((Date.now() - new Date(existingState.startTime).getTime()) / 1000);
            appState.timerInterval = setInterval(tick, 1000);
        } else {
             appState.session.elapsedSeconds = 0;
        }
    }
    updateUI();
}

// =======================================================
//        ИСПРАВЛЕННАЯ ЛОГИКА ДИНАМИКИ И ЧАРТОВ
// =======================================================
function initDynamicsPage() {
    const uid = document.body.dataset.userId;
    const weeksFilter = document.getElementById('weeks-filter');
    const dayPicker = document.getElementById('day-picker');
    const ctxDaily = document.getElementById('dailyActivityChart')?.getContext('2d');
    const ctxHourly = document.getElementById('hourlyActivityChart')?.getContext('2d');
    let dailyChart, hourlyChart, dataAll;

    async function fetchData() {
        try {
            const res = await fetch(`/api/dynamics_data/${uid}`);
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
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
            document.getElementById('calendars-container').innerHTML = '<p>Ошибка загрузки данных. Попробуйте позже.</p>';
        }
    }

    function renderCalendars(cals) {
        const cont = document.getElementById('calendars-container');
        cont.innerHTML = '';
        if (!cals || Object.keys(cals).length === 0) {
            cont.innerHTML = '<p>Нет данных по задачам для отображения.</p>';
            return;
        }
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

    function renderDaily(weeks) {
        if (!dataAll || !ctxDaily) return;
        const days = weeks * 7;
        const labels = dataAll.activity_by_day.labels.slice(-days);
        const vals = dataAll.activity_by_day.data.slice(-days);
        if (dailyChart) dailyChart.destroy();
        dailyChart = new Chart(ctxDaily, {
            type: 'bar',
            data: { labels, datasets: [{ data: vals, label: 'Часы работы', backgroundColor: 'rgba(0, 122, 255, 0.6)'}] },
            options: { scales: { y: { beginAtZero: true, max: 15 } }, plugins: { legend: { display: false } } }
        });
    }

    function renderHourly(day) {
        if (!dataAll || !ctxHourly) return;
        const arr = Array(24).fill(0);
        dataAll.activity_by_hour.filter(d => d.start_time.startsWith(day)).forEach(s => arr[s.hour] += s.duration_hours);
        if (hourlyChart) hourlyChart.destroy();
        hourlyChart = new Chart(ctxHourly, {
            type: 'bar',
            data: { labels: Array.from({ length: 24 }, (_, i) => `${i}:00`), datasets: [{ data: arr, label: `Часы за ${day}`, backgroundColor: 'rgba(0, 122, 255, 0.6)' }] },
            options: { scales: { y: { beginAtZero: true } }, plugins: { legend: { display: false } } }
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
