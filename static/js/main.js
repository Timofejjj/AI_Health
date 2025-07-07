document.addEventListener('DOMContentLoaded', () => {
    checkPersistentTimerBar();
    initFabMenu();
    initModal();
    if (document.querySelector('.timer-page')) initTimer();
    if (document.querySelector('.dynamics-page')) initDynamics();
    updateFabButton();
});

// =======================================================
//        ГЛОБАЛЬНОЕ СОСТОЯНИЕ И UI
// =======================================================
const TIMER_STATE_KEY = 'timerState';

function getTimerState() { return JSON.parse(localStorage.getItem(TIMER_STATE_KEY) || 'null'); }
function setTimerState(state) { localStorage.setItem(TIMER_STATE_KEY, JSON.stringify(state)); }
function clearTimerState() { localStorage.removeItem(TIMER_STATE_KEY); }

function updateFabButton() {
    const fabSessionBtn = document.getElementById('fab-menu-session-btn');
    if (!fabSessionBtn) return;
    const state = getTimerState();
    fabSessionBtn.textContent = (state && state.isWorkSessionActive) ? 'Вернуться к сессии' : 'Начать сессию';
}

function checkPersistentTimerBar() {
    const bar = document.getElementById('persistent-timer-bar');
    if (!bar) return;
    const timerState = getTimerState();
    if (timerState && timerState.isWorkSessionActive && !document.querySelector('.timer-page')) {
        bar.style.display = 'flex';
        bar.querySelector('.task-name').textContent = timerState.taskName;
        const returnBtn = bar.querySelector('#return-to-timer-btn');
        if (returnBtn) {
            returnBtn.href = `/timer/${timerState.userId}?task=${encodeURIComponent(timerState.taskName)}`;
        }
        setInterval(() => {
            const elapsed = Math.floor((new Date() - new Date(timerState.workSessionStartTime)) / 1000) + timerState.totalElapsedSecondsAtStart;
            const remaining = timerState.totalDurationSeconds - elapsed;
            const minutes = Math.floor(Math.abs(remaining) / 60);
            const seconds = Math.abs(remaining) % 60;
            bar.querySelector('.time-display').textContent = `${remaining < 0 ? '+' : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }, 1000);
    } else {
        bar.style.display = 'none';
    }
}

function initFabMenu() {
    const fab = document.getElementById('timer-fab');
    const fabMenu = document.getElementById('timer-fab-menu');
    const fabSessionBtn = document.getElementById('fab-menu-session-btn');
    const modal = document.querySelector('.modal-overlay');

    if (fab && fabMenu) {
        fab.addEventListener('click', (e) => {
            e.stopPropagation();
            fabMenu.classList.toggle('visible');
        });
        document.addEventListener('click', () => {
            if (fabMenu.classList.contains('visible')) {
                fabMenu.classList.remove('visible');
            }
        });
        fabMenu.addEventListener('click', (e) => e.stopPropagation());
        
        if (fabSessionBtn) {
            fabSessionBtn.addEventListener('click', (e) => {
                e.preventDefault();
                fabMenu.classList.remove('visible');
                const timerState = getTimerState();
                if (timerState && timerState.isWorkSessionActive) {
                    window.location.href = `/timer/${timerState.userId}?task=${encodeURIComponent(timerState.taskName)}`;
                } else {
                    if (modal) modal.style.display = 'flex';
                }
            });
        }
    }
}

function initModal() {
    const modal = document.querySelector('.modal-overlay');
    if (!modal) return;
    const taskForm = document.getElementById('task-form');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const userId = document.body.dataset.userId;

    if (closeModalBtn) closeModalBtn.addEventListener('click', () => modal.style.display = 'none');
    
    if (taskForm) {
        taskForm.addEventListener('submit', (e) => {
             e.preventDefault();
             const taskNameInput = document.getElementById('task-name-input');
             const taskName = taskNameInput ? taskNameInput.value : '';
             if (taskName && userId) {
                 window.location.href = `/timer/${userId}?task=${encodeURIComponent(taskName)}`;
             }
        });
    }
}

function logSession(sessionData) {
    if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(sessionData)], { type: 'application/json' });
        navigator.sendBeacon('/api/log_session', blob);
    }
}

function initTimer() {
    const timeDisplay = document.getElementById('time-display');
    const decreaseBtn = document.getElementById('decrease-time-btn');
    const increaseBtn = document.getElementById('increase-time-btn');
    const startPauseBtn = document.getElementById('start-pause-resume-btn');
    const stopBtn = document.getElementById('stop-btn');
    const presets = document.querySelectorAll('.time-preset-btn');
    const timerPage = document.querySelector('.timer-page');
    const progressBar = document.querySelector('.timer-progress .progress-bar');
    const circumference = progressBar ? 2 * Math.PI * progressBar.r.baseVal.value : 0;
    if (progressBar) progressBar.style.strokeDasharray = `${circumference} ${circumference}`;

    const userId = timerPage.dataset.userId;
    const taskName = timerPage.dataset.taskName;

    let totalDurationSeconds = 25 * 60;
    let elapsedSeconds = 0;
    let timerInterval = null;
    let isRunning = false;
    let lastPauseStartTime = null;

    function updateUI() {
        const remainingSeconds = totalDurationSeconds - elapsedSeconds;
        const minutes = Math.floor(Math.abs(remainingSeconds) / 60);
        const seconds = Math.abs(remainingSeconds) % 60;
        timeDisplay.textContent = `${remainingSeconds < 0 ? '+' : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        if (progressBar) {
            const progressPercent = Math.min(100, (elapsedSeconds / totalDurationSeconds) * 100);
            progressBar.style.strokeDashoffset = circumference - (progressPercent / 100) * circumference;
        }
        decreaseBtn.disabled = totalDurationSeconds <= 60 || isRunning;
        increaseBtn.disabled = totalDurationSeconds >= 180 * 60 || isRunning;
        presets.forEach(p => p.disabled = isRunning);
        startPauseBtn.textContent = isRunning ? 'Пауза' : (elapsedSeconds > 0 ? 'Продолжить' : 'Старт');
        startPauseBtn.classList.toggle('paused', isRunning);
    }

    function setDuration(minutes) {
        if (isRunning) return;
        totalDurationSeconds = Math.max(60, Math.min(180 * 60, minutes * 60));
        updateUI();
    }

    function start() {
        if (isRunning) return;
        isRunning = true;
        const state = {
            isWorkSessionActive: true, userId, taskName,
            workSessionStartTime: new Date().toISOString(),
            totalDurationSeconds, totalElapsedSecondsAtStart: elapsedSeconds
        };
        setTimerState(state);
        if (lastPauseStartTime) {
            logSession({
                session_type: 'pause', userId, taskName,
                start_time: lastPauseStartTime, end_time: new Date().toISOString(),
                duration_seconds: Math.floor((new Date() - new Date(lastPauseStartTime)) / 1000)
            });
            lastPauseStartTime = null;
        }
        const tickStartTime = Date.now();
        const initialElapsed = elapsedSeconds;
        timerInterval = setInterval(() => {
            elapsedSeconds = initialElapsed + Math.floor((Date.now() - tickStartTime) / 1000);
            updateUI();
        }, 250);
        updateFabButton();
        updateUI();
    }

    function pause() {
        if (!isRunning) return;
        isRunning = false;
        clearInterval(timerInterval);
        lastPauseStartTime = new Date().toISOString();
        updateUI();
    }
    
    function stop() {
        clearInterval(timerInterval);
        const state = getTimerState();
        if (state && state.isWorkSessionActive) {
            const finalElapsedSeconds = elapsedSeconds > 0 ? elapsedSeconds : Math.floor((new Date() - new Date(state.workSessionStartTime)) / 1000) + state.totalElapsedSecondsAtStart;
            logSession({
                session_type: 'work', userId, taskName,
                start_time: state.workSessionStartTime, end_time: new Date().toISOString(),
                duration_seconds: finalElapsedSeconds
            });
        }
        clearTimerState();
        updateFabButton();
        window.location.href = `/dashboard/${userId}`;
    }

    startPauseBtn.addEventListener('click', () => isRunning ? pause() : start());
    stopBtn.addEventListener('click', () => stop());
    decreaseBtn.addEventListener('click', () => setDuration(totalDurationSeconds / 60 - 5));
    increaseBtn.addEventListener('click', () => setDuration(totalDurationSeconds / 60 + 5));
    presets.forEach(btn => btn.addEventListener('click', () => setDuration(parseInt(btn.dataset.minutes))));
    
    window.addEventListener('unload', () => { if (isRunning) stop(); });
    updateUI();
}

function initDynamics() {
    const backToTimerBtn = document.getElementById('back-to-timer-from-dynamics');
    if (backToTimerBtn) {
        const timerState = getTimerState();
        if (timerState && timerState.isWorkSessionActive) {
            backToTimerBtn.style.display = 'inline-block';
            backToTimerBtn.href = `/timer/${timerState.userId}?task=${encodeURIComponent(timerState.taskName)}`;
        } else {
            backToTimerBtn.style.display = 'none';
        }
    }
    const userId = document.body.dataset.userId;
    const weeksFilter = document.getElementById('weeks-filter');
    const dayPicker = document.getElementById('day-picker');
    const ctxDaily = document.getElementById('dailyActivityChart')?.getContext('2d');
    const ctxHourly = document.getElementById('hourlyActivityChart')?.getContext('2d');
    let dailyChart, hourlyChart, allData;

    async function fetchData() {
        try {
            const response = await fetch(`/api/dynamics_data/${userId}`);
            if (!response.ok) throw new Error('Failed to fetch data');
            allData = await response.json();
            if (allData.error || !ctxDaily || !ctxHourly) { return; }
            renderCalendars(allData.calendars);
            weeksFilter.innerHTML = '';
            for (let i = 1; i <= allData.total_weeks; i++) {
                weeksFilter.add(new Option(`Последние ${i} нед.`, i));
            }
            weeksFilter.value = Math.min(4, allData.total_weeks);
            dayPicker.value = new Date().toISOString().split('T')[0];
            renderDailyChart(weeksFilter.value);
            renderHourlyChart(dayPicker.value);
        } catch (e) { console.error(e); }
    }
    
    function renderCalendars(calendarsData) {
        const container = document.getElementById('calendars-container');
        if (!container) return;
        container.innerHTML = '';
        if (!calendarsData || Object.keys(calendarsData).length === 0) {
            container.innerHTML = '<p>Нет данных по задачам.</p>';
            return;
        }
        const today = new Date(); today.setHours(0,0,0,0);
        for (const taskName in calendarsData) {
            const activeDates = new Set(calendarsData[taskName]);
            const calendarEl = document.createElement('div');
            calendarEl.className = 'calendar';
            let html = `<div class="calendar-header">${taskName}</div><div class="calendar-body">`;
            ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].forEach(day => html += `<div class="calendar-day header">${day}</div>`);
            const date = new Date(today.getFullYear(), today.getMonth(), 1);
            let firstDayOffset = date.getDay() === 0 ? 6 : date.getDay() - 1;
            for(let i=0; i < firstDayOffset; i++) { html += `<div class="calendar-day"></div>`; }
            while (date.getMonth() === today.getMonth()) {
                const dateString = date.toISOString().split('T')[0];
                let classes = 'calendar-day';
                if (activeDates.has(dateString)) classes += ' active';
                if (date.getTime() === today.getTime()) classes += ' today';
                html += `<div class="${classes}">${date.getDate()}</div>`;
                date.setDate(date.getDate() + 1);
            }
            html += `</div>`;
            calendarEl.innerHTML = html;
            container.appendChild(calendarEl);
        }
    }

    function renderDailyChart(weeksToShow) {
        const daysToShow = weeksToShow * 7;
        const labels = allData.activity_by_day.labels.slice(-daysToShow);
        const data = allData.activity_by_day.data.slice(-daysToShow);
        if (dailyChart) dailyChart.destroy();
        dailyChart = new Chart(ctxDaily, { type: 'bar', data: { labels, datasets: [{ data, label: 'Часы работы' }] }, options: { scales: { y: { beginAtZero: true, max: 15 }}} });
    }
    
    function renderHourlyChart(dateString) {
        const hourlyData = Array(24).fill(0);
        if (allData.activity_by_hour) {
            allData.activity_by_hour.filter(d => d.start_time.startsWith(dateString)).forEach(session => { hourlyData[session.hour] += session.duration_hours; });
        }
        if (hourlyChart) hourlyChart.destroy();
        hourlyChart = new Chart(ctxHourly, { type: 'bar', data: { labels: Array.from({length: 24}, (_, i) => `${i}:00`), datasets: [{ data: hourlyData, label: `Часы работы за ${dateString}` }] }, options: { scales: { y: { beginAtZero: true }}} });
    }
    
    weeksFilter.addEventListener('change', () => renderDailyChart(weeksFilter.value));
    dayPicker.addEventListener('change', () => renderHourlyChart(dayPicker.value));

    fetchData();
}
