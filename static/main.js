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

function getTimerState() { return JSON.parse(localStorage.getItem(TIMER_STATE_KEY) || 'null'); }
function setTimerState(state) { localStorage.setItem(TIMER_STATE_KEY, JSON.stringify(state)); }
function clearTimerState() { localStorage.removeItem(TIMER_STATE_KEY); }

function showModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.add('visible');
    }
}

function hideModals() {
    document.querySelectorAll('.modal-overlay.visible').forEach(m => {
        m.classList.remove('visible');
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
        
        const href = `/timer/${st.userId}?task=${encodeURIComponent(st.taskName || '')}`;
        bar.querySelector('#return-to-timer-btn').href = href;
        
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
        feeling_start: appState.session.feeling_start,
        ...data 
    };

    fetch('/api/log_session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionData),
        keepalive: true
    }).catch(error => console.error('Failed to log session:', error));
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
                window.location.href = `/timer/${st.userId}?${params.toString()}`;
            } else {
                showModal('task-modal');
            }
        });
    }
}

function initModalClose() {
    document.getElementById('close-task-modal-btn')?.addEventListener('click', hideModals);
}

function initTimerPage() {
    const uid = document.body.dataset.userId;
    appState.userId = uid;
    const params = new URLSearchParams(location.search);
    
    let taskNameFromUrl = params.get('task') || 'Без названия';
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
    
    function saveCurrentState() {
        setTimerState({
            isActive: true,
            ...appState.session
        });
    }
    
    function tick() {
        if (!appState.session.isRunning) return;
        let currentTotalElapsed = appState.session.elapsedSeconds;
        if (appState.session.startTime) {
            currentTotalElapsed = appState.session.elapsedSeconds + Math.floor((Date.now() - new Date(appState.session.startTime).getTime()) / 1000);
        }
        const duration = (appState.session.mode === 'work') ? appState.session.totalDuration : appState.session.breakDuration;
        if (currentTotalElapsed >= duration && !appState.session.completionSoundPlayed) {
            playSound();
            appState.session.completionSoundPlayed = true;
        }
        updateUI();
    };

    function updateUI() {
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
    }
    
    function startTimer() {
        if (appState.session.isRunning) return;
        appState.session.isRunning = true;
        appState.session.startTime = new Date().toISOString();
        if (appState.timerInterval) clearInterval(appState.timerInterval);
        appState.timerInterval = setInterval(tick, 1000);
        saveCurrentState();
        updateUI();
    }

    function pauseTimer() {
        if (!appState.session.isRunning) return;
        clearInterval(appState.timerInterval);
        appState.timerInterval = null;
        const elapsedSinceLastStart = Math.floor((Date.now() - new Date(appState.session.startTime).getTime()) / 1000);
        appState.session.elapsedSeconds += elapsedSinceLastStart;
        appState.session.isRunning = false;
        appState.session.startTime = null;
        saveCurrentState();
        updateUI();
    }

    function completeWorkSession(feeling_end) {
        pauseTimer();
        const finalState = appState.session;
        logSession({
            session_type: 'Работа',
            start_time: new Date(Date.now() - finalState.elapsedSeconds * 1000).toISOString(),
            end_time: new Date().toISOString(),
            duration_seconds: finalState.elapsedSeconds,
            feeling_end: feeling_end,
        });
        appState.session.mode = 'break';
        appState.session.elapsedSeconds = 0;
        appState.session.completionSoundPlayed = false;
        saveCurrentState();
        updateUI();
    }
    
    function endWorkSessionWithPrompt() {
        pauseTimer();
        showModal('end-session-modal');
        const feelingEndButtons = document.querySelectorAll('#feeling-end-group .choice-btn');
        feelingEndButtons.forEach(btn => {
            btn.onclick = () => {
                const feeling_end = btn.dataset.value;
                hideModals();
                completeWorkSession(feeling_end);
            };
        });
    }

    function switchToWorkMode() {
        pauseTimer();
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
        // Важно: Не сбрасываем taskName, location, feeling_start,
        // чтобы можно было продолжить ту же задачу
        saveCurrentState();
        updateUI();
    }

    function forceEndSession() {
        pauseTimer();
        const finalState = appState.session;
        if (finalState.elapsedSeconds > 0) {
            logSession({
                session_type: finalState.mode === 'work' ? 'Работа' : 'Перерыв',
                task_name: finalState.mode === 'work' ? finalState.taskName : 'Перерыв',
                start_time: new Date(Date.now() - finalState.elapsedSeconds * 1000).toISOString(),
                end_time: new Date().toISOString(),
                duration_seconds: finalState.elapsedSeconds,
                feeling_end: 'Принудительно завершено',
            });
        }
        clearTimerState();
        window.location.href = `/dashboard/${appState.userId}`;
    }

    startPauseBtn.addEventListener('click', () => appState.session.isRunning ? pauseTimer() : startTimer());
    stopBtn.addEventListener('click', endWorkSessionWithPrompt);
    startBreakBtn.addEventListener('click', () => appState.session.isRunning ? pauseTimer() : startTimer());
    skipBreakBtn.addEventListener('click', switchToWorkMode); // ИСПРАВЛЕНО
    forceEndBtn.addEventListener('click', forceEndSession);
    
    decreaseWorkBtn.addEventListener('click', () => { appState.session.totalDuration = Math.max(60, appState.session.totalDuration - 60); updateUI(); });
    increaseWorkBtn.addEventListener('click', () => { appState.session.totalDuration += 60; updateUI(); });
    decreaseBreakBtn.addEventListener('click', () => { appState.session.breakDuration = Math.max(60, appState.session.breakDuration - 60); updateUI(); });
    increaseBreakBtn.addEventListener('click', () => { appState.session.breakDuration += 60; updateUI(); });
    
    document.querySelectorAll('.time-preset-btn').forEach(btn => btn.addEventListener('click', () => {
        appState.session.totalDuration = parseInt(btn.dataset.minutes) * 60; updateUI();
    }));
    document.querySelectorAll('.break-preset-btn').forEach(btn => btn.addEventListener('click', () => {
        appState.session.breakDuration = parseInt(btn.dataset.minutes) * 60; updateUI();
    }));

    const existingState = getTimerState();
    if (existingState && existingState.isActive) {
        Object.assign(appState.session, existingState);
        if (locationFromUrl) appState.session.location = locationFromUrl;
        if (feelingStartFromUrl) appState.session.feeling_start = feelingStartFromUrl;
        if (taskNameFromUrl) appState.session.taskName = taskNameFromUrl;

        if (existingState.isRunning && existingState.startTime) {
            const offlineDuration = Math.floor((Date.now() - new Date(existingState.startTime).getTime()) / 1000);
            appState.session.elapsedSeconds += offlineDuration;
            startTimer();
        }
    } else {
        appState.session.taskName = taskNameFromUrl;
        appState.session.location = locationFromUrl;
        appState.session.feeling_start = feelingStartFromUrl;
    }
    
    taskTitleHeader.textContent = appState.session.taskName;
    updateUI();
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
                const params = new URLSearchParams({ task: taskName, location: location, feeling_start: feeling_start });
                window.location.href = `/timer/${appState.userId}?${params.toString()}`;
            }
        });
    }

    if (document.querySelector('.timer-page')) initTimerPage();
    if (document.querySelector('.dynamics-page')) {
        // initDynamicsPage(); // Если есть страница динамики, ее тоже нужно будет инициализировать
    }
});
