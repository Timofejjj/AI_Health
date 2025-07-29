// Обработчики события  нажатия на кнопку
document.querySelectorAll('.action-btn, .action-btn-icon').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = btn.nextElementSibling;
    if (menu.classList.contains('popup-menu')) {
      document.querySelectorAll('.popup-menu').forEach(m => m.classList.remove('show'));
      menu.classList.toggle('show');
    }
  });
});

document.getElementById('logout-btn').addEventListener('click', function() {
    // Отправляем запрос на сервер для выхода
    fetch('/logout', {
        method: 'POST',
        credentials: 'same-origin' // для передачи кук
    })
    .then(response => {
        if (response.ok) {
            window.location.href = 'templates/login.html'; // Перенаправляем после выхода
        }
    })
    .catch(error => console.error('Ошибка при выходе:', error));
});

//------------------------------------------------------------------


// Закрывать меню при клике вне его
document.addEventListener('click', () => {
  document.querySelectorAll('.popup-menu').forEach(m => m.classList.remove('show'));
});


document.addEventListener('DOMContentLoaded', () => {

    // 1. Динамическое приветствие в зависимости от времени суток
    function setGreeting() {
        const greetingEl = document.querySelector('.greeting');
        if (!greetingEl) return;

        const userName = document.body.dataset.userId || 'Пользователь';
        const hour = new Date().getHours();
        let greetingText = '';

        if (hour >= 4 && hour < 12) {
            greetingText = 'Доброе утро';
        } else if (hour >= 12 && hour < 17) {
            greetingText = 'Добрый день';
        } else if (hour >= 17 && hour < 23) {
            greetingText = 'Добрый вечер';
        } else {
            greetingText = 'Доброй ночи';
        }
        
        greetingEl.textContent = `${greetingText}, ${userName}`;
    }

    // 2. Логика управления панелями
    const leftPane = document.getElementById('thoughts-list-pane');
    const composePanel = document.getElementById('compose-thought-panel');
    
    // Функция для переключения левой панели
    function toggleLeftPane() {
        const isOpening = !leftPane.classList.contains('visible');
        if (isOpening && composePanel.classList.contains('open')) {
            composePanel.classList.remove('open');
        }

        leftPane.classList.toggle('visible');
        if (leftPane.classList.contains('visible')) {
            loadThoughts();
        }
    }

    // Функция для переключения нижней панели
    function toggleComposePanel() {
        const isOpening = !composePanel.classList.contains('open');
        if (isOpening && leftPane.classList.contains('visible')) {
            leftPane.classList.remove('visible');
        }

        composePanel.classList.toggle('open');
        if (composePanel.classList.contains('open')) {
            document.getElementById('thought-input').focus();
        }
    }

    // 3. Загрузка списка мыслей
    async function loadThoughts() {
        const userId = document.body.dataset.userId;
        const thoughtsList = document.getElementById('thoughts-list');
        thoughtsList.innerHTML = '<div class="loader"></div>'; 
        try {
            const response = await fetch(`/api/thoughts/${userId}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const thoughts = await response.json();
            
            thoughtsList.innerHTML = ''; 

            if (thoughts.length === 0) {
                thoughtsList.innerHTML = '<p class="empty-list-message">Записей пока нет.</p>';
                return;
            }

            thoughts.forEach(thought => {
                const item = document.createElement('div');
                item.classList.add('list-item');
                item.innerHTML = `
                    <div class="item-meta">${new Date(thought.timestamp).toLocaleString()}</div>
                    <div class="item-content">${thought.content}</div>
                `;
                thoughtsList.appendChild(item);
            });
        } catch (error) {
            console.error('Ошибка загрузки мыслей:', error);
            thoughtsList.innerHTML = '<p class="error-message">Не удалось загрузить записи.</p>';
        }
    }

    // 4. Отправка новой мысли
    async function submitThought() {
        const thoughtInput = document.getElementById('thought-input');
        const thought = thoughtInput.value.trim();
        if (!thought) return;
        const userId = document.body.dataset.userId;
        try {
            const response = await fetch(`/api/thoughts/${userId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ thought })
            });
            if (response.ok) {
                thoughtInput.value = '';
                toggleComposePanel();
            } else {
                console.error('Ошибка отправки мысли');
            }
        } catch (error) {
            console.error('Ошибка отправки мысли:', error);
        }
    }

    // Назначаем обработчики на кнопки
    document.body.addEventListener('click', (e) => {
        const toggleLeftPaneBtn = e.target.closest('[data-action="toggle-left-pane"]');
        const toggleComposePanelBtn = e.target.closest('[data-action="toggle-compose-panel"]');
        const submitThoughtBtn = e.target.closest('[data-action="submit-thought"]');

        if (toggleLeftPaneBtn) {
            toggleLeftPane();
            return;
        }

        if (toggleComposePanelBtn) {
            toggleComposePanel();
            return;
        }

        if (submitThoughtBtn) {
            submitThought();
            return;
        }
    });

    // --- Инициализация ---
    setGreeting();
});
