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
        breakDuration: 10 * 60,
        completionSoundPlayed: false,
        location: null,
        feeling_start: null,
    },
    timerInterval: null,
    audioCtx: null
};

// --- Вспомогательные функции для localStorage ---
function getTimerState() { return JSON.parse(localStorage.getItem(TIMER_STATE_KEY) || 'null'); }
function setTimerState(state) { localStorage.setItem(TIMER_STATE_KEY, JSON.stringify(state)); }
function clearTimerState() { localStorage.removeItem(TIMER_STATE_KEY); }

// --- Функции для модальных окон ---
function showModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('visible');
}

function hideModals() {
    document.querySelectorAll('.modal-overlay.visible').forEach(m => m.classList.remove('visible'));
}

function updatePersistentBar() {
    const bar = document.getElementById('persistent-timer-bar');
    const st = getTimerState();
    if (!bar) return;

    if (bar.intervalId) {
        clearInterval(bar.intervalId);
        bar.intervalId = null;
    }

    const currentUserId = appState.userId;
    if (!currentUserId) return;

    if (st && st.isActive && !document.querySelector('.timer-page')) {
        bar.classList.add('visible');
        bar.querySelector('.task-name').textContent = st.mode === 'work' ? st.taskName : 'Перерыв';
        bar.querySelector('#return-to-timer-btn').href = `/timer/${currentUserId}?task=${encodeURIComponent(st.taskName || '')}`;

        const updateBarTime = () => {
            const duration = st.mode === 'work' ? (st.totalDuration || 25*60) : (st.breakDuration || 10*60);
            let currentElapsed = st.elapsedSeconds || 0;
            if (st.isRunning && st.startTime) {
                currentElapsed += Math.floor((Date.now() - new Date(st.startTime).getTime()) / 1000);
            }
            const remaining = duration - currentElapsed;
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

function playSound() {
    if (!appState.audioCtx) {
        try {
            appState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.error("Web Audio API is not supported in this browser");
            return;
        }
    }
    const oscillator = appState.audioCtx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(440, appState.audioCtx.currentTime);
    oscillator.connect(appState.audioCtx.destination);
    oscillator.start();
    oscillator.stop(appState.audioCtx.currentTime + 0.5);
}

function logSession(data) {
    const sessionData = {
        user_id: appState.userId,
        task_name: appState.session.taskName || 'N/A',
        location: appState.session.location,
        feeling_start: data.feeling_start, 
        ...data
    };

    const blob = new Blob([JSON.stringify(sessionData)], { type: 'application/json' });
    
    if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/log_session', blob);
    } else {
        fetch('/api/log_session', {
            method: 'POST',
            body: blob,
            keepalive: true
        }).catch(error => console.error('Failed to log session with fetch:', error));
    }
}

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
            if (st && st.isActive) {
                const params = new URLSearchParams({
                    task: st.taskName || 'Без названия',
                    location: st.location || '',
                    feeling_start: st.feeling_start || ''
                });
                window.location.href = `/timer/${appState.userId}?${params.toString()}`;
            } else {
                showModal('task-modal');
            }
        });
    }
}

function initModalClose() {
    document.getElementById('close-task-modal-btn')?.addEventListener('click', hideModals);
    document.getElementById('close-start-session-modal-btn')?.addEventListener('click', hideModals);
}

function initTimerPage() {
    let timerModule = {}; 

    const params = new URLSearchParams(location.search);
    let taskNameFromUrl = params.get('task');
    let locationFromUrl = params.get('location');
    let feelingStartFromUrl = params.get('feeling_start');

    const taskTitleHeader = document.getElementById('task-title-header');
    const sessionLabel = document.getElementById('session-label');
    const timeDisplay = document.querySelector('.timer-widget .time-display');
    const workControls = document.getElementById('work-session-controls');
    const startPauseBtn = workControls.querySelector('.control-btn-main');
    const stopBtn = workControls.querySelector('.control-btn-secondary');
    const breakControls = document.getElementById('break-session-controls');
    const startBreakBtn = document.getElementById('start-break-btn');
    const skipBreakBtn = document.getElementById('skip-break-btn');
    const forceEndBtn = document.getElementById('force-end-session-btn');
    const decreaseWorkBtn = document.getElementById('decrease-work-time-btn');
    const increaseWorkBtn = document.getElementById('increase-work-time-btn');
    const decreaseBreakBtn = document.getElementById('decrease-break-time-btn');
    const increaseBreakBtn = document.getElementById('increase-break-time-btn');

    timerModule.saveCurrentState = () => setTimerState({ isActive: true, ...appState.session });

    timerModule.tick = () => {
        if (!appState.session.isRunning) return;
        const duration = (appState.session.mode === 'work') ? appState.session.totalDuration : appState.session.breakDuration;
        let currentTotalElapsed = appState.session.elapsedSeconds + Math.floor((Date.now() - new Date(appState.session.startTime).getTime()) / 1000);
        
        if (currentTotalElapsed >= duration && !appState.session.completionSoundPlayed) {
            playSound();
            appState.session.completionSoundPlayed = true;
        }
        timerModule.updateUI();
    };

    timerModule.updateUI = () => {
        let currentTotalElapsed = Math.floor(appState.session.elapsedSeconds);
        if (appState.session.isRunning && appState.session.startTime) {
            currentTotalElapsed = Math.floor(appState.session.elapsedSeconds + (Date.now() - new Date(appState.session.startTime).getTime()) / 1000);
        }
        const duration = (appState.session.mode === 'work') ? appState.session.totalDuration : appState.session.breakDuration;
        const remaining = duration - currentTotalElapsed;
        const isOvertime = remaining < 0;
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
        } else {
            workControls.classList.add('hidden');
            breakControls.classList.remove('hidden');
            sessionLabel.textContent = 'ПЕРЕРЫВ';
            startBreakBtn.textContent = appState.session.isRunning ? 'Пауза' : 'Начать перерыв';
            startBreakBtn.classList.toggle('paused', appState.session.isRunning);
            skipBreakBtn.textContent = appState.session.isRunning ? 'Завершить' : 'Пропустить';
        }
        updatePersistentBar();
    };

    timerModule.startTimer = () => {
        if (appState.session.isRunning) return;
        appState.session.isRunning = true;
        appState.session.startTime = new Date().toISOString();
        if (appState.timerInterval) clearInterval(appState.timerInterval);
        appState.timerInterval = setInterval(timerModule.tick, 1000);
        timerModule.saveCurrentState();
        timerModule.updateUI();
    };

    timerModule.pauseTimer = () => {
        if (!appState.session.isRunning) return;
        clearInterval(appState.timerInterval);
        appState.timerInterval = null;
        const elapsedSinceLastStart = Math.floor((Date.now() - new Date(appState.session.startTime).getTime()) / 1000);
        appState.session.elapsedSeconds += elapsedSinceLastStart;
        appState.session.isRunning = false;
        appState.session.startTime = null;
        timerModule.saveCurrentState();
        timerModule.updateUI();
    };

    function completeWorkSession(feeling_end) {
        timerModule.pauseTimer();
        const finalState = appState.session;
        logSession({
            session_type: 'Работа',
            start_time: new Date(Date.now() - finalState.elapsedSeconds * 1000).toISOString(),
            end_time: new Date().toISOString(),
            duration_seconds: finalState.elapsedSeconds,
            feeling_start: finalState.feeling_start, 
            feeling_end: feeling_end,
        });
        appState.session.mode = 'break';
        appState.session.elapsedSeconds = 0;
        appState.session.completionSoundPlayed = false;
        appState.session.feeling_start = null; 
        timerModule.saveCurrentState();
        timerModule.updateUI();
    }

    function endWorkSessionWithPrompt() {
        timerModule.pauseTimer();
        showModal('end-session-modal');
        document.querySelectorAll('#end-session-modal .choice-btn').forEach(btn => btn.classList.remove('selected'));
        const feelingEndButtons = document.querySelectorAll('#feeling-end-group .choice-btn');
        feelingEndButtons.forEach(btn => {
            btn.onclick = () => {
                const feeling_end = btn.dataset.value;
                hideModals();
                completeWorkSession(feeling_end);
            };
        });
    }

    function startWorkSessionWithPrompt() {
        showModal('start-session-modal');
        document.querySelectorAll('#start-session-modal .choice-btn').forEach(btn => btn.classList.remove('selected'));
        const startBtn = document.getElementById('start-resumed-session-btn');
        startBtn.onclick = () => {
             const selectedFeeling = document.querySelector('#feeling-start-group-resumed .choice-btn.selected');
             if (!selectedFeeling) {
                 alert('Пожалуйста, выберите ваше состояние.');
                 return;
             }
             appState.session.feeling_start = selectedFeeling.dataset.value;
             hideModals();
             timerModule.startTimer();
        };
    }

    function switchToWorkMode() {
        timerModule.pauseTimer();
        if (appState.session.elapsedSeconds > 10) {
            logSession({
                session_type: 'Перерыв',
                task_name: 'Перерыв', 
                start_time: new Date(Date.now() - appState.session.elapsedSeconds * 1000).toISOString(),
                end_time: new Date().toISOString(),
                duration_seconds: appState.session.elapsedSeconds,
            });
        }
        appState.session.mode = 'work';
        appState.session.elapsedSeconds = 0;
        appState.session.completionSoundPlayed = false;
        timerModule.saveCurrentState();
        timerModule.updateUI();
        startWorkSessionWithPrompt();
    }
    
    function handleStartPauseClick() {
        if (appState.session.isRunning) {
            timerModule.pauseTimer();
        } else {
            if (appState.session.elapsedSeconds > 0) {
                startWorkSessionWithPrompt();
            } else {
                timerModule.startTimer();
            }
        }
    }

    function forceEndSession() {
        timerModule.pauseTimer();
        const finalState = appState.session;
        if (finalState.elapsedSeconds > 0) {
            logSession({
                session_type: finalState.mode === 'work' ? 'Работа' : 'Перерыв',
                task_name: finalState.mode === 'work' ? finalState.taskName : 'Перерыв',
                start_time: new Date(Date.now() - finalState.elapsedSeconds * 1000).toISOString(),
                end_time: new Date().toISOString(),
                duration_seconds: finalState.elapsedSeconds,
                feeling_start: finalState.feeling_start,
                feeling_end: 'Принудительно завершено',
            });
        }
        clearTimerState();
        window.location.href = `/dashboard/${appState.userId}`;
    }

    startPauseBtn.addEventListener('click', handleStartPauseClick);
    stopBtn.addEventListener('click', endWorkSessionWithPrompt);
    startBreakBtn.addEventListener('click', () => appState.session.isRunning ? timerModule.pauseTimer() : timerModule.startTimer());
    skipBreakBtn.addEventListener('click', switchToWorkMode);
    forceEndBtn.addEventListener('click', forceEndSession);
    decreaseWorkBtn.addEventListener('click', () => { appState.session.totalDuration = Math.max(60, appState.session.totalDuration - 60); timerModule.updateUI(); });
    increaseWorkBtn.addEventListener('click', () => { appState.session.totalDuration += 60; timerModule.updateUI(); });
    decreaseBreakBtn.addEventListener('click', () => { appState.session.breakDuration = Math.max(60, appState.session.breakDuration - 60); timerModule.updateUI(); });
    increaseBreakBtn.addEventListener('click', () => { appState.session.breakDuration += 60; timerModule.updateUI(); });
    document.querySelectorAll('.time-preset-btn').forEach(btn => btn.addEventListener('click', () => { appState.session.totalDuration = parseInt(btn.dataset.minutes) * 60; timerModule.updateUI(); }));
    document.querySelectorAll('.break-preset-btn').forEach(btn => btn.addEventListener('click', () => { appState.session.breakDuration = parseInt(btn.dataset.minutes) * 60; timerModule.updateUI(); }));

    const existingState = getTimerState();
    if (existingState && existingState.isActive) {
        Object.assign(appState.session, existingState);
        if (taskNameFromUrl) {
            appState.session.taskName = taskNameFromUrl;
            appState.session.location = locationFromUrl;
            appState.session.feeling_start = feelingStartFromUrl;
        }
        if (appState.session.isRunning) {
            if (appState.timerInterval) clearInterval(appState.timerInterval);
            appState.timerInterval = setInterval(timerModule.tick, 1000);
        }
    } else if (taskNameFromUrl) {
        appState.session.taskName = taskNameFromUrl;
        appState.session.location = locationFromUrl;
        appState.session.feeling_start = feelingStartFromUrl;
        timerModule.saveCurrentState();
    }
    taskTitleHeader.textContent = appState.session.taskName;
    timerModule.updateUI();
}

async function initDynamicsPage() {
    const userId = document.body.dataset.userId;
    if (!userId) return;

    const calendarsContainer = document.getElementById('calendars-container');
    const weeksFilter = document.getElementById('weeks-filter');
    const dailyChartCanvas = document.getElementById('dailyActivityChart');
    const dayPicker = document.getElementById('day-picker');
    const hourlyChartCanvas = document.getElementById('hourlyActivityChart');

    try {
        const response = await fetch(`/api/dynamics_data/${userId}`);
        if (!response.ok) throw new Error(`Network response was not ok: ${response.statusText}`);
        const data = await response.json();
        renderCalendars(data.calendars, calendarsContainer);
        renderDailyChart(data.activity_by_day, data.total_weeks, dailyChartCanvas, weeksFilter);
        renderHourlyChart(data.work_sessions_list, hourlyChartCanvas, dayPicker);
    } catch (error) {
        calendarsContainer.innerHTML = `<p style="color: red;">Не удалось загрузить данные: ${error.message}</p>`;
        console.error('Error fetching dynamics data:', error);
    }
}

function renderCalendars(calendarsData, container) {
    container.innerHTML = '';
    if (Object.keys(calendarsData).length === 0) {
        container.innerHTML = '<p>Нет данных по задачам для отображения.</p>';
        return;
    }
    const today = new Date();
    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();
    for (const taskName in calendarsData) {
        const activeDays = calendarsData[taskName];
        const calendarEl = document.createElement('div');
        calendarEl.className = 'calendar';
        calendarEl.innerHTML = `<div class="calendar-header">${taskName}</div><div class="calendar-body"></div>`;
        container.appendChild(calendarEl);
        const calendarBody = calendarEl.querySelector('.calendar-body');
        const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
        const firstDayOfMonth = new Date(currentYear, currentMonth, 1).getDay();
        const adjustedFirstDay = (firstDayOfMonth === 0) ? 6 : firstDayOfMonth - 1;
        const дниНедели = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
        дниНедели.forEach(day => { calendarBody.innerHTML += `<div class="calendar-day header">${day}</div>`; });
        for (let i = 0; i < adjustedFirstDay; i++) { calendarBody.innerHTML += `<div class="calendar-day"></div>`; }
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const dayEl = document.createElement('div');
            dayEl.className = 'calendar-day';
            dayEl.textContent = day;
            if (activeDays.includes(dateStr)) dayEl.classList.add('active');
            if (day === today.getDate() && currentMonth === today.getMonth() && currentYear === today.getFullYear()) dayEl.classList.add('today');
            calendarBody.appendChild(dayEl);
        }
    }
}

function renderDailyChart(dailyData, totalWeeks, canvas, filter) {
    const allLabels = dailyData.labels;
    const allDataPoints = dailyData.data;

    filter.innerHTML = '';
    [1, 2, 4].forEach(w => {
        if (totalWeeks >= w) {
            const option = document.createElement('option');
            option.value = w * 7;
            option.textContent = `${w} недел${w === 1 ? 'я' : (w > 1 && w < 5 ? 'и' : 'ь')}`;
            filter.appendChild(option);
        }
    });
    const allTimeOption = document.createElement('option');
    allTimeOption.value = allLabels.length;
    allTimeOption.textContent = 'Все время';
    allTimeOption.selected = true;
    filter.appendChild(allTimeOption);

    const chart = new Chart(canvas, { type: 'bar', data: { labels: allLabels, datasets: [{ label: 'Часы работы', data: allDataPoints, backgroundColor: 'rgba(0, 122, 255, 0.6)', borderColor: 'rgba(0, 122, 255, 1)', borderWidth: 1 }] }, options: { scales: { y: { beginAtZero: true, title: { display: true, text: 'Часы' } }, x: { type: 'time', time: { unit: 'day', tooltipFormat: 'd MMM yyyy' }, ticks: { autoSkip: true, maxTicksLimit: 15 } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { title: (ctx) => new Date(ctx[0].parsed.x).toLocaleDateString('ru-RU') } } } } });

    function updateChartData(daysToShow) {
        const visibleLabels = allLabels.slice(-daysToShow);
        const visibleData = allDataPoints.slice(-daysToShow);
        chart.data.labels = visibleLabels;
        chart.data.datasets[0].data = visibleData;
        chart.update();
    }
    
    filter.addEventListener('change', (e) => {
        const daysToShow = parseInt(e.target.value, 10);
        updateChartData(daysToShow);
    });

    updateChartData(allLabels.length);
    filter.value = allLabels.length;
}

// --- ИЗМЕНЕНИЕ: Полностью новая функция для Gantt-графика ---
function renderHourlyChart(workSessions, canvas, picker) {
    let chart = null;
    const colorPalette = [
        'rgba(255, 99, 132, 0.7)', 'rgba(54, 162, 235, 0.7)',
        'rgba(255, 206, 86, 0.7)', 'rgba(75, 192, 192, 0.7)',
        'rgba(153, 102, 255, 0.7)', 'rgba(255, 159, 64, 0.7)'
    ];

    function updateChart(selectedDateStr) {
        const daySessions = workSessions.filter(s => new Date(s.start_time).toISOString().startsWith(selectedDateStr));

        const tasksForDay = daySessions.reduce((acc, session) => {
            if (!acc[session.task_name]) {
                acc[session.task_name] = [];
            }
            acc[session.task_name].push([new Date(session.start_time), new Date(session.end_time)]);
            return acc;
        }, {});

        const labels = Object.keys(tasksForDay);
        const datasets = labels.map((taskName, index) => ({
            label: taskName,
            data: tasksForDay[taskName],
            backgroundColor: colorPalette[index % colorPalette.length],
            barPercentage: 0.8,
            categoryPercentage: 0.9,
        }));
        
        const dayStart = new Date(`${selectedDateStr}T00:00:00`);
        const dayEnd = new Date(`${selectedDateStr}T23:59:59`);

        const chartData = { labels, datasets };

        if (chart) {
            chart.data = chartData;
            chart.options.scales.x.min = dayStart;
            chart.options.scales.x.max = dayEnd;
            chart.update();
        } else {
            chart = new Chart(canvas, {
                type: 'bar',
                data: chartData,
                options: {
                    indexAxis: 'y', // Делаем график горизонтальным
                    responsive: true,
                    scales: {
                        x: {
                            type: 'time',
                            min: dayStart,
                            max: dayEnd,
                            time: {
                                unit: 'hour',
                                displayFormats: { hour: 'HH:mm' }
                            },
                            position: 'bottom',
                            title: { display: true, text: 'Время дня' }
                        },
                        y: {
                           title: { display: true, text: 'Задачи' }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                title: (context) => context[0]?.dataset.label || '',
                                label: (context) => {
                                    const start = new Date(context.raw[0]);
                                    const end = new Date(context.raw[1]);
                                    const durationMs = end - start;
                                    const durationMins = Math.round(durationMs / 60000);
                                    const startTime = start.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                                    const endTime = end.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                                    return `Период: ${startTime} - ${endTime} (${durationMins} мин)`;
                                }
                            }
                        }
                    }
                }
            });
        }
    }
    
    const todayStr = new Date().toISOString().split('T')[0];
    picker.value = todayStr;
    picker.addEventListener('change', (e) => updateChart(e.target.value));
    updateChart(todayStr);
}

document.addEventListener('DOMContentLoaded', () => {
    appState.userId = document.body.dataset.userId;

    initFabMenu();
    initModalClose();
    updatePersistentBar();

    document.querySelectorAll('.choice-group').forEach(group => {
        group.addEventListener('click', (e) => {
            if (e.target.classList.contains('choice-btn')) {
                group.querySelectorAll('.choice-btn').forEach(btn => btn.classList.remove('selected'));
                e.target.classList.add('selected');
            }
        });
    });

    const taskForm = document.getElementById('task-form');
    if (taskForm) {
        taskForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const taskName = document.getElementById('task-name-input').value.trim();
            const location = document.querySelector('#location-group .choice-btn.selected')?.dataset.value;
            const feeling_start = document.querySelector('#feeling-start-group .choice-btn.selected')?.dataset.value;
            if (!taskName || !location || !feeling_start) {
                alert('Пожалуйста, заполните все поля.');
                return;
            }
            if (appState.userId) {
                hideModals();
                clearTimerState();
                const params = new URLSearchParams({ task: taskName, location: location, feeling_start: feeling_start });
                window.location.href = `/timer/${appState.userId}?${params.toString()}`;
            }
        });
    }

    if (document.querySelector('.timer-page')) {
        initTimerPage();
    }
    if (document.querySelector('.dynamics-page')) {
        initDynamicsPage();
    }
});
