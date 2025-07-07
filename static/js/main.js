document.addEventListener('DOMContentLoaded', () => {

    // --- Управление FAB меню ---
    const fab = document.getElementById('timer-fab');
    const fabMenu = document.getElementById('timer-fab-menu');
    const fabSessionBtn = document.getElementById('fab-menu-session-btn');
    const modal = document.getElementById('task-modal');
    
    if (fab) {
        fab.addEventListener('click', (e) => {
            e.stopPropagation(); // Предотвращаем закрытие меню сразу после открытия
            fabMenu.classList.toggle('visible');
        });

        // Закрытие меню при клике вне его
        document.addEventListener('click', (e) => {
            if (fabMenu && !fab.contains(e.target) && !fabMenu.contains(e.target)) {
                fabMenu.classList.remove('visible');
            }
        });
        
        fabSessionBtn.addEventListener('click', (e) => {
            e.preventDefault();
            fabMenu.classList.remove('visible');
            const timerState = getTimerState();
            if (timerState && timerState.isWorkSessionActive) {
                // Если сессия активна, переходим к ней
                window.location.href = `/timer/${timerState.userId}?task=${encodeURIComponent(timerState.taskName)}`;
            } else {
                // Иначе показываем модальное окно для новой сессии
                if (modal) modal.style.display = 'flex';
            }
        });
    }

    // Закрытие модального окна
    const closeModalBtn = document.getElementById('close-modal-btn');
    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', () => {
            if(modal) modal.style.display = 'none';
        });
    }
    
    // --- Инициализация страниц ---
    if (document.querySelector('.timer-page')) initTimer();
    if (document.querySelector('.dynamics-page')) initDynamics();

    // Обновление текста кнопки в FAB меню при загрузке страницы
    updateFabButton();
});


// =======================================================
//        ГЛОБАЛЬНОЕ СОСТОЯНИЕ ТАЙМЕРА (localStorage)
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
//          НАДЕЖНОЕ СОХРАНЕНИЕ СЕССИИ (sendBeacon)
// =======================================================
function logSession(sessionData) {
    if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(sessionData)], { type: 'application/json' });
        navigator.sendBeacon('/api/log_session', blob);
    } else {
        // Fallback для очень старых браузеров
        fetch('/api/log_session', {
            method: 'POST',
            body: JSON.stringify(sessionData),
            headers: { 'Content-Type': 'application/json' },
            keepalive: true
        });
    }
}


// =======================================================
//                    ЛОГИКА ТАЙМЕРА
// =======================================================
function initTimer() {
    // --- Элементы UI ---
    const timeDisplay = document.getElementById('time-display');
    const decreaseBtn = document.getElementById('decrease-time-btn');
    const increaseBtn = document.getElementById('increase-time-btn');
    const startPauseBtn = document.getElementById('start-pause-resume-btn');
    const stopBtn = document.getElementById('stop-btn');
    const presets = document.querySelectorAll('.time-preset-btn');
    const timerPage = document.querySelector('.timer-page');
    const progressBar = document.querySelector('.timer-progress .progress-bar');
    const radius = progressBar.r.baseVal.value;
    const circumference = 2 * Math.PI * radius;
    progressBar.style.strokeDasharray = `${circumference} ${circumference}`;

    const userId = timerPage.dataset.userId;
    const taskName = timerPage.dataset.taskName;

    // --- Состояние ---
    let totalDurationSeconds = 25 * 60;
    let elapsedSeconds = 0;
    let timerInterval = null;
    let isRunning = false;
    let lastPauseStartTime = null;

    // --- Обновление UI ---
    function updateUI() {
        const remainingSeconds = totalDurationSeconds - elapsedSeconds;
        const minutes = Math.floor(remainingSeconds / 60);
        const seconds = remainingSeconds % 60;
        timeDisplay.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        
        const progressPercent = (elapsedSeconds / totalDurationSeconds) * 100;
        const offset = circumference - (progressPercent / 100) * circumference;
        progressBar.style.strokeDashoffset = offset;
        
        decreaseBtn.disabled = totalDurationSeconds <= 60 || isRunning;
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
        elapsedSeconds = 0;
        updateUI();
    }

    // --- Логика таймера ---
    function start() {
        if (isRunning) return;
        isRunning = true;
        
        // Создаем новое состояние сессии
        let state = getTimerState();
        if (!state || !state.isWorkSessionActive) {
            state = {
                isWorkSessionActive: true,
                userId, taskName,
                workSessionStartTime: new Date().toISOString(),
                totalDurationSeconds,
                totalElapsedSecondsAtStart: elapsedSeconds
            };
        }
        setTimerState(state);
        
        // Логируем конец предыдущей паузы, если она была
        if (lastPauseStartTime) {
            logSession({
                session_type: 'pause', userId, taskName,
                start_time: lastPauseStartTime,
                end_time: new Date().toISOString(),
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
                // Завершаем сессию, когда время истекло
                updateUI();
                stop(true); // true означает, что сессия завершена успешно
            } else {
                updateUI();
            }
        }, 250); // Интервал почаще для плавности
        
        updateFabButton();
        updateUI();
    }

    function pause() {
        if (!isRunning) return;
        isRunning = false;
        clearInterval(timerInterval);
        lastPauseStartTime = new Date().toISOString();
        // При паузе состояние сессии в localStorage остается, чтобы ее можно было продолжить
        updateFabButton();
        updateUI();
    }
    
    function stop(isCompleted = false) {
        clearInterval(timerInterval);
        const state = getTimerState();
        if (state && state.isWorkSessionActive) {
            // Если сессия была на паузе, сначала логируем паузу
            if (lastPauseStartTime) {
                logSession({
                    session_type: 'pause', userId, taskName,
                    start_time: lastPauseStartTime,
                    end_time: new Date().toISOString(),
                    duration_seconds: Math.floor((new Date() - new Date(lastPauseStartTime)) / 1000)
                });
            }
            // Затем логируем саму рабочую сессию
            logSession({
                session_type: 'work', userId, taskName,
                start_time: state.workSessionStartTime,
                end_time: new Date().toISOString(),
                duration_seconds: elapsedSeconds
            });
        }
        clearTimerState();
        window.location.href = `/dashboard/${userId}`;
    }

    // --- Обработчики ---
    startPauseBtn.addEventListener('click', () => isRunning ? pause() : start());
    stopBtn.addEventListener('click', () => stop(false));
    decreaseBtn.addEventListener('click', () => setDuration(totalDurationSeconds / 60 - 5));
    increaseBtn.addEventListener('click', () => setDuration(totalDurationSeconds / 60 + 5));
    presets.forEach(btn => btn.addEventListener('click', () => setDuration(parseInt(btn.dataset.minutes))));
    
    // Обработка закрытия страницы
    window.addEventListener('unload', () => {
        if (isRunning) {
             // Если таймер работал, сессия считается прерванной и сохраняется
             stop(false);
        }
    });

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
            
            if (allData.error) {
                console.error(allData.error);
                return;
            }

            // Заполняем фильтр по неделям
            weeksFilter.innerHTML = '';
            for (let i = 1; i <= allData.total_weeks; i++) {
                const option = new Option(`Последние ${i} нед.`, i);
                weeksFilter.add(option);
            }
            weeksFilter.value = Math.min(4, allData.total_weeks);
            
            // Устанавливаем сегодняшний день в date-picker
            dayPicker.value = new Date().toISOString().split('T')[0];

            renderDailyChart(weeksFilter.value);
            renderHourlyChart(dayPicker.value);
        } catch (e) {
            console.error(e);
        }
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
        const dayData = allData.activity_by_hour.filter(d => d.start_time.startsWith(dateString));
        
        dayData.forEach(session => {
            hourlyData[session.hour] += session.duration_hours;
        });
        
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
