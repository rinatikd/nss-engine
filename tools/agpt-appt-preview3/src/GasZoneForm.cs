using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;
using AGPT.Shared;

namespace AGPT.Cad
{
    // Data entry only: no database access and no changes until the caller commits.
    internal sealed class GasZoneForm : Form
    {
        private readonly TextBox nameInput = new TextBox();
        private readonly ComboBox agentInput = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList };
        private readonly Dictionary<string, TextBox> numbers = new Dictionary<string, TextBox>();
        private readonly Label errors = new Label { AutoSize = true, ForeColor = Color.Firebrick, MaximumSize = new Size(980, 0) };
        private readonly Label volume = new Label { AutoSize = true };
        private readonly double area;
        public GasZoneInput Input { get; private set; }

        public GasZoneForm(double areaSquareMetres, IReadOnlyDictionary<string, string> existing)
        {
            area = areaSquareMetres;
            Text = "АГПТ — параметры зоны";
            ClientSize = new Size(1080, 780);
            MinimumSize = new Size(920, 650);
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            ShowInTaskbar = false;
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, ColumnCount = 1, Padding = new Padding(12) };
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(1000, 0), Margin = new Padding(0, 0, 0, 12),
                Text = "Заполните исходные данные помещения. Площадь взята из выбранного контура: " + NumericData.Format(area) + " м².\n"
                    + "Пояснения приведены справа. Числовые пределы защищают прототип от ошибок ввода и не заменяют нормативную методику." }, 0, 0);
            var scroll = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
            var table = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 3, Padding = new Padding(0, 0, 18, 0) };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 215));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 235));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            string Read(string key) => existing.TryGetValue(key, out string value) ? value : "";
            nameInput.Text = Read("ZONE_NAME");
            nameInput.MaxLength = 120;
            AddRow(table, "Название помещения", nameInput, "Проектное наименование зоны. Существующие параметры можно изменить без создания новой зоны.");
            foreach (string agent in GasAgentCatalog.Options) agentInput.Items.Add(agent);
            string savedAgent = Read("GOTV");
            int agentIndex = agentInput.Items.IndexOf(savedAgent);
            agentInput.SelectedIndex = agentIndex;
            AddRow(table, "ГОТВ — выбрать из списка", agentInput,
                "HFC-227ea — Хладон 227ea. В текущем прототипе есть допущения для этого вещества. Другие ГОТВ пока не поддержаны; выбор не подставляет концентрацию и плотность."
                + (savedAgent.Length > 0 && agentIndex < 0 ? " Сохранённое значение: " + savedAgent + "; автоматическая замена не выполнена." : ""));
            AddNumber(table, "H", "Высота помещения H, м", Read("H"), "Высота защищаемого помещения. Используется для объёма и поправки на проёмы. Требуется конечное H > 0; нормативный верхний предел здесь не установлен.");
            numbers["H"].TextChanged += (sender, args) => UpdateVolume();
            AddRow(table, "Расчётный объём, м³", volume, "Площадь выбранного контура × высота. Заполняется автоматически после ввода высоты.");
            AddNumber(table, "FH", "Площадь проёмов FH, м²", Read("FH"), "Суммарная площадь негерметичных проёмов, учитываемых принятой методикой. FH ≥ 0. Ноль указывайте только при отсутствии учитываемых проёмов.");
            AddNumber(table, "TM", "Минимальная температура, °C", Read("TM"), "Минимальная расчётная температура по проекту. Нижний предел −73,15 °C относится только к текущему алгоритму; рабочий диапазон ГОТВ уточняют по технической документации.");
            AddNumber(table, "CN", "Концентрация Cn, об. %", Read("CN"), "Нормативная огнетушащая концентрация — по применимой методике и пожарной нагрузке. Программа проверяет 0 < Cn < 100; это не рекомендуемый инженерный диапазон.");
            AddNumber(table, "RHO0", "Плотность паров ρ₀, кг/м³", Read("RHO0"), "Плотность паров ГОТВ при +20 °C и атмосферном давлении 101,3 кПа. Возьмите из технической документации/принятой методики. Требуется ρ₀ > 0; плотность жидкости сюда не вводят.");
            AddNumber(table, "K4", "Множитель K4", Read("K4"), "Безразмерный множитель Mp в формуле прототипа Mg = ceil(1,05 × (Mp × K4 + Mтр)). Нормативное назначение и диапазон в имеющихся источниках не подтверждены. Требуется конечное K4 > 0; значение 1 автоматически не назначается.");
            AddNumber(table, "VTR", "Объём трубопроводов Vтр, м³", Read("VTR"), "Внутренний объём распределительных трубопроводов по их размерам и длинам. Vтр ≥ 0; 1 литр = 0,001 м³. Прототип использует его для оценки остатка ГОТВ, модель требует инженерной проверки.");
            scroll.Controls.Add(table);
            layout.Controls.Add(scroll, 0, 1);
            var footer = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
            footer.Controls.Add(errors);
            var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight };
            var save = new Button { Text = "Сохранить зону", AutoSize = true };
            save.Click += Save;
            var cancel = new Button { Text = "Отмена", AutoSize = true, DialogResult = DialogResult.Cancel };
            buttons.Controls.Add(save);
            buttons.Controls.Add(cancel);
            footer.Controls.Add(buttons);
            layout.Controls.Add(footer, 0, 2);
            AcceptButton = save;
            CancelButton = cancel;
            Controls.Add(layout);
            UpdateVolume();
        }

        private static void AddRow(TableLayoutPanel table, string caption, Control control, string help)
        {
            int row = table.RowCount++;
            table.Controls.Add(new Label { Text = caption, AutoSize = true, Margin = new Padding(0, 8, 6, 8) }, 0, row);
            control.Dock = DockStyle.Top;
            control.Margin = new Padding(3, 6, 10, 12);
            control.AccessibleName = caption;
            table.Controls.Add(control, 1, row);
            table.Controls.Add(new Label { Text = help, AutoSize = true, MaximumSize = new Size(530, 0), Margin = new Padding(3, 6, 0, 12) }, 2, row);
        }

        private void AddNumber(TableLayoutPanel table, string key, string caption, string value, string help)
        {
            var input = new TextBox { Text = value, MaxLength = 64 };
            numbers.Add(key, input);
            AddRow(table, caption, input, help);
        }

        private void UpdateVolume()
        {
            if (NumericData.TryParseFinite(numbers["H"].Text, out double height)
                && height > 0 && double.IsFinite(area * height))
                volume.Text = NumericData.Format(area * height);
            else volume.Text = "Введите высоту помещения";
        }

        private void Save(object sender, EventArgs args)
        {
            var parseErrors = new List<string>();
            double? Number(string key)
            {
                if (string.IsNullOrWhiteSpace(numbers[key].Text)) return null;
                if (NumericData.TryParseFinite(numbers[key].Text, out double value)) return value;
                parseErrors.Add(numbers[key].AccessibleName + ": требуется конечное число (например, 2,5).");
                return null;
            }
            var input = new GasZoneInput { Name = nameInput.Text.Trim(), Gotv = agentInput.SelectedItem as string,
                Height = Number("H"), OpeningsArea = Number("FH"), MinimumTemperature = Number("TM"),
                Concentration = Number("CN"), Density = Number("RHO0"), K4 = Number("K4"), PipeVolume = Number("VTR") };
            parseErrors.AddRange(input.Validate());
            if (parseErrors.Count > 0) { errors.Text = string.Join("\n", parseErrors); return; }
            if (!double.IsFinite(area * input.Height.Value) || area * input.Height.Value <= 0)
            { errors.Text = "Объём помещения выходит за допустимые числовые пределы."; return; }
            Input = input;
            DialogResult = DialogResult.OK;
            Close();
        }
    }
}
