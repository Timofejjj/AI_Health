document.addEventListener('DOMContentLoaded', () => {

    // --- Управление FAB меню ---
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
            fabMenu.classList.remove('visible');
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
    
    // --- Инициализация модального окна ---
    if (modal) {
        const taskForm = document.getElementById('task-form');
        const closeModalBtn = document.getElementById('close-modal-btn');
        const userId = document.body.dataset.userId;

        if (closeModalBtn) {
            closeModalBtn.addEventListener('click', () => modal.style.display = 'none');
        }
        if (taskForm) {
            taskForm.addEventListener('submit', (e) => {
                 e.preventDefault();
                 const taskName = document.getElementById('task-name-input').value;
                 if (taskName && userId) {
                     window.location.href = `/timer/${userId}?task=${encodeURIComponent(taskName)}`;
                 }
            });
        }
    }
    
    // --- Инициализация страниц ---
    if (document.querySelector('.timer-page')) initTimer();
    if (document.querySelector('.dynamics-page')) initDynamics();

    updateFabButton();
});


// =======================================================
//        ГЛОБАЛЬНОЕ СОСТОЯНИЕ ТАЙМЕРА
// =======================================================
const TIMER_STATE_KEY = 'timerState';

function getTimerState() { return JSON.parse(localStorage.getItem(TIMER_STATE_KEY) || 'null'); }
function setTimerState(state) { localStorage.setItem(TIMER_STATE_KEY, JSON.stringify(state)); }
function clearTimerState() { localStorage.removeItem(TIMER_STATE_KEY); }

function updateFabButton() {
    const fabSessionBtn = document.getElementById('fab-menu-session-btn');
    if (!fabSessionBtn) return;
    const state = getTimerState();
    if (state && state.isWorkSessionActive) {
        fabSessionBtn.textContent = 'Вернуться к сессии';
    } else {
        fabSessionBtn.textContent = 'Начать сессию';
    }
}

// =======================================================
//          НАДЕЖНОЕ СОХРАНЕНИЕ СЕССИИ
// =======================================================
function logSession(sessionData) {
    if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(sessionData)], { type: 'application/json' });
        navigator.sendBeacon('/api/log_session', blob);
    }
}


// =======================================================
//                    ЛОГИКА ТАЙМЕРА
// =======================================================
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
        const minutes = Math.floor(remainingSeconds / 60);
        const seconds = remainingSeconds % 60;
        timeDisplay.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        
        if(progressBar) {
            const progressPercent = (elapsedSeconds / totalDurationSeconds) * 100;
            progressBar.style.strokeDashoffset = circumference - (progressPercent / 100) * circumference;
        }
        
        decreaseBtn.disabled = totalDurationSeconds <= 60 * 5 || isRunning;
        increaseBtn.disabled = totalDurationSeconds >= 180 * 60 || isRunning;
        presets.forEach(p => p.disabled = isRunning);
        
        if (isRunning) {
            startPauseBtn.textContent = 'Пауза';
            startPauseBtn.classList.add('paused');
        } else {
            startPauseBtn.textContent = elapsedSeconds > 0 ? 'Продолжить' : 'Старт';
            startPauseBtn.classList.remove('paused');
        }
    }

    function setDuration(minutes) {
        if (isRunning) return;
        totalDurationSeconds = Math.max(60, Math.min(180 * 60, minutes * 60));
        if (elapsedSeconds > totalDurationSeconds) elapsedSeconds = totalDurationSeconds;
        updateUI();
    }

    function start() {
        if (isRunning) return;
        isRunning = true;
        
        let state = getTimerState();
        if (!state || !state.isWorkSessionActive) {
            state = {
                isWorkSessionActive: true, userId, taskName,
                workSessionStartTime: new Date().toISOString(),
                totalDurationSeconds, totalElapsedSecondsAtStart: elapsedSeconds
            };
        }
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
            const delta = Math.floor((Date.now() - tickStartTime) / 1000);
            elapsedSeconds = initialElapsed + delta;
            
            if (elapsedSeconds >= totalDurationSeconds) {
                stop(true);
            } else {
                updateUI();
            }
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
    
    function stop(isCompleted = false) {
        clearInterval(timerInterval);
        const state = getTimerState();
        if (state && state.isWorkSessionActive) {
            if (lastPauseStartTime) {
                logSession({
                    session_type: 'pause', userId, taskName,
                    start_time: lastPauseStartTime, end_time: new Date().toISOString(),
                    duration_seconds: Math.floor((new Date() - new Date(lastPauseStartTime)) / 1000)
                });
            }
            logSession({
                session_type: 'work', userId, taskName,
                start_time: state.workSessionStartTime, end_time: new Date().toISOString(),
                duration_seconds: elapsedSeconds
            });
        }
        clearTimerState();
        updateFabButton();
        window.location.href = `/dashboard/${userId}`;
    }

    startPauseBtn.addEventListener('click', () => isRunning ? pause() : start());
    stopBtn.addEventListener('click', () => stop(false));
    decreaseBtn.addEventListener('click', () => setDuration(totalDurationSeconds / 60 - 5));
    increaseBtn.addEventListener('click', () => setDuration(totalDurationSeconds / 60 + 5));
    presets.forEach(btn => btn.addEventListener('click', () => setDuration(parseInt(btn.dataset.minutes))));
    
    window.addEventListener('unload', () => { if (isRunning) stop(false); });

    updateUI();
}


// =======================================================
//                ЛОГИКА СТРАНИЦЫ ОТЧЕТОВ
// =======================================================
function initDynamics() {
    const userId = document.body.dataset.userId;
    const weeksFilter = document.getElementById('weeks-filter');
    const dayPicker = document.getElementById('day-picker');
    const ctxDaily = document.getElementById('dailyActivityChart')?.getContext('2d');
    const ctxHourly = document.getElementById('hourlyActivityChart')?.getContext('2d');
    let dailyChart, hourlyChart;
    let allData;

    async function fetchData() {
        try {
            const response = await fetch(`/api/dynamics_data/${userId}`);
            if (!response.ok) throw new Error('Failed to fetch data');
            allData = await response.json();
            
            if (allData.error || !ctxDaily || !ctxHourly) { console.error(allData.error || "Chart context not found"); return; }

            weeksFilter.innerHTML = '';
            for (let i = 1; i <= allData.total_weeks; i++) {
                const option = new Option(`Последние ${i} нед.`, i);
                weeksFilter.add(option);
            }
            weeksFilter.value = Math.min(4, allData.total_weeks);
            
            dayPicker.value = new Date().toISOString().split('T')[0];

            renderDailyChart(weeksFilter.value);
            renderHourlyChart(dayPicker.value);
        } catch (e) { console.error(e); }
    }
    
    function renderDailyChart(weeksToShow) {
        const daysToShow = weeksToShow * 7;
        const labels = allData.activity_by_day.labels.slice(-daysToShow);
        const data = allData.activity_by_day.data.slice(-daysToShow);
        
        if (dailyChart) dailyChart.destroy();
        dailyChart = new Chart(ctxDaily, {
            type: 'bar',
            data: { labels, datasets: [{ data, label: 'Часы работы', backgroundColor: 'rgba(0, 122, 255, 0.6)' }] },
            options: { scales: { y: { beginAtZero: true, max: 15, title: { display: true, text: 'Часы' }}}}
        });
    }
    
    function renderHourlyChart(dateString) {
        const hourlyData = Array(24).fill(0);
        if (allData.activity_by_hour) {
            const dayData = allData.activity_by_hour.filter(d => d.start_time.startsWith(dateString));
            dayData.forEach(session => { hourlyData[session.hour] += session.duration_hours; });
        }
        
        if (hourlyChart) hourlyChart.destroy();
        hourlyChart = new Chart(ctxHourly, {
            type: 'bar',
            data: { 
                labels: Array.from({length: 24}, (_, i) => `${i}:00`),
                datasets: [{ data: hourlyData, label: `Часы работы за ${dateString}`, backgroundColor: 'rgba(52, 199, 89, 0.6)' }]
            },
            options: { scales: { y: { beginAtZero: true }}}
        });
    }
    
    weeksFilter.addEventListener('change', () => renderDailyChart(weeksFilter.value));
    dayPicker.addEventListener('change', () => renderHourlyChart(dayPicker.value));

    fetchData();
}
