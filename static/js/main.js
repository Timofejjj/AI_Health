document.addEventListener('DOMContentLoaded', () => {

    // --- ЛОГИКА ДЛЯ DASHBOARD (МОДАЛЬНОЕ ОКНО) ---
    const startTimerBtn = document.getElementById('start-timer-btn');
    const modal = document.getElementById('task-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const taskForm = document.getElementById('task-form');

    if (startTimerBtn) {
        startTimerBtn.addEventListener('click', () => {
            modal.style.display = 'flex';
        });
    }

    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });
    }
    
    if (modal) {
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
    const timerPage = document.querySelector('.timer-page');
    if (timerPage) {
        initTimer();
    }
    
    // --- ЛОГИКА ДЛЯ СТРАНИЦЫ ДИНАМИКИ ---
    const dynamicsPage = document.querySelector('.dynamics-page');
    if (dynamicsPage) {
        loadDynamicsData();
    }
});


// =======================================================
//                    КЛАСС ТАЙМЕРА
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

    let totalSeconds = 25 * 60;
    let remainingSeconds = totalSeconds;
    let timerInterval = null;
    let isRunning = false;
    let isMuted = false;
    let startTime = null;

    const userId = timerPage.dataset.userId;
    const taskName = timerPage.dataset.taskName;
    const audio = new Audio('https://actions.google.com/sounds/v1/alarms/alarm_clock.ogg');

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
        startTime = startTime || new Date().toISOString(); // Устанавливаем время старта только в первый раз
        
        timerInterval = setInterval(() => {
            remainingSeconds--;
            if (remainingSeconds >= 0) {
                const percent = ((totalSeconds - remainingSeconds) / totalSeconds) * 100;
                setProgress(Math.min(100, percent));
            } else {
                 setProgress(100); // Полный круг в овертайме
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
    }
    
    function stopTimer() {
        logSession();
        window.location.href = `/dashboard/${userId}`;
    }

    async function logSession() {
        if (!startTime) return; // Не логируем, если таймер не был запущен

        pauseTimer();
        const endTime = new Date().toISOString();
        
        try {
            await fetch('/api/log_session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: userId,
                    task_name: taskName,
                    start_time: startTime,
                    end_time: endTime
                })
            });
        } catch (error) {
            console.error('Failed to log session:', error);
        } finally {
            startTime = null; // Сброс для следующей сессии
        }
    }
    
    // Логирование при закрытии/перезагрузке страницы
    window.addEventListener('beforeunload', (e) => {
        if(isRunning) {
            logSession();
        }
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
        muteBtn.style.opacity = isMuted ? 0.5 : 1.0;
    });

    document.querySelectorAll('.time-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (isRunning) return; // Нельзя менять время во время работы
            totalSeconds = parseInt(btn.dataset.minutes) * 60;
            remainingSeconds = totalSeconds;
            setProgress(0);
            updateDisplay();
        });
    });

    // Initial setup
    updateDisplay();
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

        calendarsContainer.innerHTML = ''; // Очищаем 'Загрузка...'
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
        let firstDayOffset = date.getDay() - 1; // 0=Mon, 6=Sun
        if (firstDayOffset === -1) firstDayOffset = 6; // Sunday fix

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

        const labels = allLabels.slice(-days);
        const data = allData.slice(-days);

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
                    x: {
                        type: 'time',
                        time: { unit: 'day' }
                    },
                    y: { beginAtZero: true }
                },
                plugins: { legend: { display: false } }
            }
        });
    }

    // Initial render for 7 days
    drawChart(7); 
    
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