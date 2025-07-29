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

/**
 * Основной скрипт приложения, который запускается после загрузки страницы.
 */
document.addEventListener('DOMContentLoaded', function() {
    
    // --------------------------------------------------------------------------
    // Шаг 1: Код для кнопки "Выйти" УДАЛЕН. 
    // Вместо него используется простая ссылка <a href="/logout"> в HTML.
    // Это более правильный и надежный подход.
    // --------------------------------------------------------------------------

    console.log("Страница загружена. Запускаем приложение.");

    // Вызываем главную функцию, которая загрузит все необходимые данные.
    loadInitialData();


    /**
     * Функция для загрузки и отображения мыслей пользователя.
     * Именно сюда мы помещаем ваш код `fetch`.
     */
    function loadInitialData() {
        
        // Находим на странице контейнер, куда будем выводить мысли.
        // Убедитесь, что в вашем home.html есть элемент с id="thoughts-container"
        const thoughtsContainer = document.getElementById('thoughts-container');
        
        // Если контейнера нет на странице, прекращаем выполнение, чтобы избежать ошибок.
        if (!thoughtsContainer) {
            console.error('Контейнер для мыслей #thoughts-container не найден!');
            return;
        }

        // --- Вот ваш код, интегрированный в функцию ---
        fetch('/api/thoughts')
            .then(response => {
                // Если сессия истекла, сервер вернет 401 Unauthorized
                if (response.status === 401) {
                    // Немедленно перенаправляем на страницу входа
                    window.location.href = '/login';
                    return; // Прерываем выполнение, чтобы не было ошибок в консоли
                }
                // Если ответ успешный, преобразуем его в JSON
                if (response.ok) {
                    return response.json();
                }
                // Если произошла другая ошибка, сообщаем о ней
                throw new Error('Сетевой ответ был некорректным.');
            })
            .then(data => {
                // Убеждаемся, что данные пришли, и `then` не был вызван после return;
                if (data) {
                    console.log("Данные успешно получены:", data);

                    // Очищаем контейнер перед добавлением новых данных
                    thoughtsContainer.innerHTML = ''; 

                    // Отображаем данные на странице
                    if (data.length > 0) {
                        data.forEach(thought => {
                            const thoughtElement = document.createElement('div');
                            thoughtElement.textContent = thought.text; // Отображаем текст мысли
                            thoughtsContainer.appendChild(thoughtElement);
                        });
                    } else {
                        thoughtsContainer.textContent = 'У вас пока нет мыслей.';
                    }
                }
            })
            .catch(error => {
                console.error('Ошибка при получении данных:', error);
                // Сообщаем пользователю об ошибке
                thoughtsContainer.textContent = 'Не удалось загрузить данные.';
            });
    }
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
