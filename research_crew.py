"""
Прототип мультиагентной системы: Исследователь -> Аналитик -> Автор (CrewAI).

Установка:
    pip install crewai crewai-tools

Переменные окружения:
    ANTHROPIC_API_KEY  - ключ модели (или поменяйте MODEL на другого провайдера)
    SERPER_API_KEY     - (необязательно) ключ serper.dev для веб-поиска

Запуск:
    python research_crew.py "Рынок мультиагентных фреймворков в 2026 году"
"""
import os
import sys

from crewai import Agent, Crew, LLM, Process, Task

# Имя модели в формате "провайдер/модель". Измените под свой аккаунт.
MODEL = os.getenv("CREW_MODEL", "anthropic/claude-sonnet-5-5")
llm = LLM(model=MODEL, temperature=0.3)

# Поиск подключается только если задан ключ
tools = []
if os.getenv("SERPER_API_KEY"):
    from crewai_tools import SerperDevTool

    tools.append(SerperDevTool())

topic = sys.argv[1] if len(sys.argv) > 1 else "Мультиагентные ИИ-системы"

# --- Агенты ---------------------------------------------------------------
researcher = Agent(
    role="Исследователь",
    goal=f"Собрать актуальные факты и цифры по теме: {topic}",
    backstory="Дотошный аналитик-разведчик. Всегда указывает источник и отличает факты от мнений.",
    tools=tools,
    llm=llm,
    verbose=True,
)

analyst = Agent(
    role="Аналитик",
    goal="Отфильтровать шум, выделить главные выводы, тренды и риски",
    backstory="Критически мыслящий эксперт: проверяет противоречия и не принимает слабые данные на веру.",
    llm=llm,
    verbose=True,
)

writer = Agent(
    role="Автор",
    goal="Написать понятный структурированный отчёт для руководителя",
    backstory="Редактор деловых текстов: пишет коротко, ясно, без воды.",
    llm=llm,
    verbose=True,
)

# --- Задачи (выход каждой автоматически передаётся следующей) -------------
research_task = Task(
    description=f"Найди ключевые факты, цифры и источники по теме «{topic}». Дай 8-12 пунктов со ссылками.",
    expected_output="Маркированный список фактов с указанием источников.",
    agent=researcher,
)

analysis_task = Task(
    description="Проанализируй собранные факты: убери дубли и слабые данные, выдели 3-5 ключевых выводов, тренды и риски.",
    expected_output="Структурированный анализ: выводы, тренды, риски, пробелы в данных.",
    agent=analyst,
    context=[research_task],
)

writing_task = Task(
    description="Напиши отчёт на 1-2 страницы: краткое резюме, основные выводы, рекомендации.",
    expected_output="Готовый отчёт в формате Markdown.",
    agent=writer,
    context=[analysis_task],
    output_file="report.md",
)

# --- Сборка и запуск -----------------------------------------------------
crew = Crew(
    agents=[researcher, analyst, writer],
    tasks=[research_task, analysis_task, writing_task],
    process=Process.sequential,
    verbose=True,
)

if __name__ == "__main__":
    result = crew.kickoff()
    print("\n=== ИТОГОВЫЙ ОТЧЁТ ===\n")
    print(result)
