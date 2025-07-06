document.addEventListener('DOMContentLoaded', () => {

    // Глобальная проверка состояния таймера при загрузке любой страницы
    checkGlobalTimerState();

    // --- ЛОГИКА ДЛЯ ГЛАВНОЙ СТРАНИЦЫ (DASHBOARD) ---
    const timerFab = document.getElementById('timer-fab');
    const modal = document.getElementById('task-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const taskForm = document.getElementById('task-form');

    if (timerFab) {
        timerFab.addEventListener('click', () => {
            const timerState = getTimerState();
            if (timerState && timerState.isActive) {
                // Если таймер активен, переходим на его страницу
                window.location.href = `/timer/${timerState.userId}?task=${encodeURIComponent(timerState.taskName)}`;
            } else {
                // Иначе показываем модальное окно для новой сессии
                modal.style.display = 'flex';
            }
        });
    }

    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });
    }
    
    if (modal) {
        // Закрытие модального окна по клику на фон
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                 modal.style.display = 'none';
            }
        });
    }

    if (taskForm) {
        taskForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const taskName = document.getElementById('task-name-input').value;
            const userId = document.getElementById('modal-user-id').value;
            if (taskName && userId) {
                window.location.href = `/timer/${userId}?task=${encodeURIComponent(taskName)}`;
            }
        });
    }

    // --- ЛОГИКА ДЛЯ СТРАНИЦЫ ТАЙМЕРА ---
    if (document.querySelector('.timer-page')) {
        initTimer();
    }
    
    // --- ЛОГИКА ДЛЯ СТРАНИЦЫ ДИНАМИКИ ---
    if (document.querySelector('.dynamics-page')) {
        loadDynamicsData();
        const backToTimerBtn = document.getElementById('back-to-timer-from-dynamics');
        if (backToTimerBtn) {
            const timerState = getTimerState();
            if (timerState && timerState.isActive) {
                backToTimerBtn.style.display = 'inline-block'; // Показываем кнопку
                backToTimerBtn.href = `/timer/${timerState.userId}?task=${encodeURIComponent(timerState.taskName)}`;
            } else {
                backToTimerBtn.style.display = 'none'; // Скрываем кнопку, если таймер не активен
            }
        }
    }
});


// =======================================================
//        УПРАВЛЕНИЕ ГЛОБАЛЬНЫМ СОСТОЯНИЕМ ТАЙМЕРА
// =======================================================
const TIMER_STATE_KEY = 'timerState';
let globalTimerInterval = null;

function getTimerState() {
    const state = localStorage.getItem(TIMER_STATE_KEY);
    return state ? JSON.parse(state) : null;
}

function setTimerState(state) {
    localStorage.setItem(TIMER_STATE_KEY, JSON.stringify(state));
}

function clearTimerState() {
    localStorage.removeItem(TIMER_STATE_KEY);
    if (globalTimerInterval) clearInterval(globalTimerInterval);
    const persistentBar = document.getElementById('persistent-timer-bar');
    if (persistentBar) persistentBar.style.display = 'none';
}

function checkGlobalTimerState() {
    const timerState = getTimerState();
    const persistentBar = document.getElementById('persistent-timer-bar');
    const timerPage = document.querySelector('.timer-page');

    // Показываем панель, только если таймер активен И мы НЕ на странице самого таймера
    if (timerState && timerState.isActive && !timerPage) {
        persistentBar.style.display = 'flex';
        const taskNameEl = persistentBar.querySelector('.task-name');
        const timeDisplayEl = persistentBar.querySelector('.time-display');
        const returnBtn = document.getElementById('return-to-timer-btn');

        taskNameEl.textContent = timerState.taskName;
        returnBtn.href = `/timer/${timerState.userId}?task=${encodeURIComponent(timerState.taskName)}`;
        
        if (globalTimerInterval) clearInterval(globalTimerInterval);

        const updateBar = () => {
            const elapsed = Math.floor((new Date() - new Date(timerState.sessionStartTime)) / 1000);
            const remaining = timerState.totalSeconds - elapsed;
            
            const isOvertime = remaining < 0;
            const secondsToDisplay = Math.abs(remaining);
            const minutes = Math.floor(secondsToDisplay / 60);
            const seconds = secondsToDisplay % 60;
            timeDisplayEl.textContent = `${isOvertime ? '+' : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        };
        updateBar(); // Обновляем сразу
        globalTimerInterval = setInterval(updateBar, 1000);

    } else {
        if(persistentBar) persistentBar.style.display = 'none';
        if (globalTimerInterval) clearInterval(globalTimerInterval);
    }
}


// =======================================================
//                    ЛОГИКА ТАЙМЕРА
// =======================================================
function initTimer() {
    const timerPage = document.querySelector('.timer-page');
    const timeDisplay = document.getElementById('time-display');
    const startPauseBtn = document.getElementById('start-pause-btn');
    const stopBtn = document.getElementById('stop-btn');
    const muteBtn = document.getElementById('mute-btn');
    const progressBar = document.querySelector('.timer-progress .progress-bar');
    const radius = progressBar.r.baseVal.value;
    const circumference = 2 * Math.PI * radius;
    
    progressBar.style.strokeDasharray = `${circumference} ${circumference}`;
    progressBar.style.strokeDashoffset = circumference;

    const userId = timerPage.dataset.userId;
    const taskName = timerPage.dataset.taskName;
    const audio = new Audio('https://actions.google.com/sounds/v1/alarms/alarm_clock.ogg');
    
    let timerState = {};
    let totalSeconds = 25 * 60;
    let remainingSeconds = totalSeconds;
    let timerInterval = null;
    let isRunning = false;
    let isMuted = false;

    function setProgress(percent) {
        const offset = circumference - (percent / 100) * circumference;
        progressBar.style.strokeDashoffset = offset;
    }

    function updateDisplay() {
        const isOvertime = remainingSeconds < 0;
        const secondsToDisplay = Math.abs(remainingSeconds);
        const minutes = Math.floor(secondsToDisplay / 60);
        const seconds = secondsToDisplay % 60;
        const displayString = `${isOvertime ? '+' : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        timeDisplay.textContent = displayString;
        document.title = `${displayString} - ${taskName}`;
        timeDisplay.classList.toggle('overtime', isOvertime);
    }

    function startTimer() {
        if (isRunning) return;
        isRunning = true;
        startPauseBtn.textContent = 'Пауза';

        const now = new Date();
        if (!timerState.isActive) { // Начало новой сессии
             timerState = {
                isActive: true,
                userId: userId,
                taskName: taskName,
                totalSeconds: totalSeconds,
                sessionStartTime: now.toISOString(),
            };
        }
        setTimerState(timerState);
        
        timerInterval = setInterval(() => {
            const elapsed = Math.floor((new Date() - new Date(timerState.sessionStartTime)) / 1000);
            remainingSeconds = totalSeconds - elapsed;

            if (remainingSeconds >= 0) {
                const percent = ((totalSeconds - remainingSeconds) / totalSeconds) * 100;
                setProgress(Math.min(100, percent));
            } else {
                 setProgress(100);
            }
            
            if (remainingSeconds === -1 && !isMuted) {
                audio.play();
            }
            updateDisplay();
        }, 1000);
    }
    
    function pauseTimer() {
        if (!isRunning) return;
        isRunning = false;
        startPauseBtn.textContent = 'Старт';
        clearInterval(timerInterval);
        
        // При паузе просто удаляем состояние, т.к. при старте оно создастся заново с верным временем
        clearTimerState(); 
        timerState = {};
    }
    
    function stopTimer() {
        const state = getTimerState();
        if (state && state.isActive) {
            logSession(state); // Логируем, если сессия была активна
        }
        clearTimerState();
        window.location.href = `/dashboard/${userId}`;
    }

    async function logSession(stateToLog) {
        try {
            await fetch('/api/log_session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: stateToLog.userId,
                    task_name: stateToLog.taskName,
                    start_time: stateToLog.sessionStartTime,
                    end_time: new Date().toISOString()
                })
            });
        } catch (error) {
            console.error('Failed to log session:', error);
        }
    }
    
    window.addEventListener('beforeunload', () => {
        // Ничего не делаем, localStorage сохранит состояние
    });

    startPauseBtn.addEventListener('click', () => {
        if (isRunning) {
            pauseTimer();
        } else {
            startTimer();
        }
    });
    
    stopBtn.addEventListener('click', stopTimer);

    muteBtn.addEventListener('click', () => {
        isMuted = !isMuted;
        muteBtn.classList.toggle('muted', isMuted);
    });

    document.querySelectorAll('.time-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (isRunning) return;
            totalSeconds = parseInt(btn.dataset.minutes) * 60;
            remainingSeconds = totalSeconds;
            setProgress(0);
            updateDisplay();
        });
    });

    // --- Логика при загрузке страницы таймера ---
    function initializeOnLoad() {
        const state = getTimerState();
        // Если есть активное состояние, соответствующее этой странице, продолжаем его
        if (state && state.isActive && state.taskName === taskName && state.userId === userId) {
            timerState = state;
            totalSeconds = state.totalSeconds;
            startTimer();
        } else {
            // Иначе это новая сессия, просто обновляем дисплей
            clearTimerState(); // Очищаем на всякий случай любое старое состояние
            updateDisplay();
        }
    }
    initializeOnLoad();
}


// =======================================================
//                   ЛОГИКА ДИНАМИКИ
// =======================================================
async function loadDynamicsData() {
    const dynamicsPage = document.querySelector('.dynamics-page');
    const userId = dynamicsPage.dataset.userId;
    const calendarsContainer = document.getElementById('calendars-container');
    
    try {
        const response = await fetch(`/api/dynamics_data/${userId}`);
        if (!response.ok) throw new Error('Network response was not ok');
        const data = await response.json();

        calendarsContainer.innerHTML = '';
        renderCalendars(data.calendars, calendarsContainer);
        renderDailyChart(data.activity_by_day);
        renderHourlyChart(data.activity_by_hour);

    } catch (error) {
        console.error('Failed to load dynamics data:', error);
        calendarsContainer.innerHTML = '<p>Не удалось загрузить данные.</p>';
    }
}

function renderCalendars(calendarsData, container) {
    if (Object.keys(calendarsData).length === 0) {
        container.innerHTML = '<p>Пока нет данных о рабочих сессиях. Начните использовать таймер!</p>';
        return;
    }

    const today = new Date();
    today.setHours(0,0,0,0);
    
    for (const taskName in calendarsData) {
        const activeDates = new Set(calendarsData[taskName]);
        const calendarEl = document.createElement('div');
        calendarEl.className = 'calendar';
        
        let html = `<div class="calendar-header">${taskName}</div><div class="calendar-body">`;
        const daysOfWeek = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
        daysOfWeek.forEach(day => html += `<div class="calendar-day header">${day}</div>`);

        const date = new Date(today.getFullYear(), today.getMonth(), 1);
        let firstDayOffset = date.getDay() - 1;
        if (firstDayOffset === -1) firstDayOffset = 6;

        for(let i=0; i < firstDayOffset; i++) {
            html += `<div class="calendar-day"></div>`;
        }

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

let dailyChartInstance = null;
function renderDailyChart(chartData) {
    const ctx = document.getElementById('dailyActivityChart').getContext('2d');
    const allLabels = chartData.labels;
    const allData = chartData.data;

    function drawChart(days) {
        if(dailyChartInstance) {
            dailyChartInstance.destroy();
        }
        // Убедимся, что данные есть, чтобы slice не вызвал ошибку
        const labels = allLabels ? allLabels.slice(-days) : [];
        const data = allData ? allData.slice(-days) : [];

        dailyChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Минут в день',
                    data: data,
                    backgroundColor: 'rgba(0, 122, 255, 0.6)',
                    borderColor: 'rgba(0, 122, 255, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                scales: {
                    x: { type: 'time', time: { unit: 'day' } },
                    y: { beginAtZero: true }
                },
                plugins: { legend: { display: false } }
            }
        });
    }

    const initialRange = 7;
    drawChart(initialRange); 
    
    document.querySelectorAll('.chart-filters .filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelector('.chart-filters .filter-btn.active').classList.remove('active');
            e.target.classList.add('active');
            const range = parseInt(e.target.dataset.range);
            drawChart(range);
        });
    });
}

function renderHourlyChart(chartData) {
    const ctx = document.getElementById('hourlyActivityChart').getContext('2d');
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: chartData.labels,
            datasets: [{
                label: 'Всего минут',
                data: chartData.data,
                backgroundColor: 'rgba(52, 199, 89, 0.6)',
                borderColor: 'rgba(52, 199, 89, 1)',
                borderWidth: 1
            }]
        },
        options: {
            scales: { y: { beginAtZero: true } },
            plugins: { legend: { display: false } }
        }
    });
}
