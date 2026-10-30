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
                "HFC-227ea — Хладон 227ea. В текущем прототипе есть допущения для этого вещества. Другие ГОТВ пока не поддержаны. Концентрация и плотность заполняются из явно выбранного справочного профиля предоставленного проекта."
                + (savedAgent.Length > 0 && agentIndex < 0 ? " Сохранённое значение: " + savedAgent + "; автоматическая замена не выполнена." : ""));
            AddNumber(table, "H", "Высота помещения H, м", Read("H"), "Высота защищаемого помещения. Используется для объёма и поправки на проёмы. Требуется конечное H > 0; нормативный верхний предел здесь не установлен.");
            numbers["H"].TextChanged += (sender, args) => UpdateVolume();
            AddRow(table, "Расчётный объём, м³", volume, "Площадь выбранного контура × высота. Заполняется автоматически после ввода высоты.");
            AddNumber(table, "FH", "Площадь проёмов FH, м²", Read("FH"), "Суммарная площадь негерметичных проёмов, учитываемых принятой методикой. FH ≥ 0. Ноль указывайте только при отсутствии учитываемых проёмов.");
            AddNumber(table, "TM", "Минимальная температура, °C", Read("TM"), "Минимальная расчётная температура по проекту. Нижний предел −73,15 °C относится только к текущему алгоритму; рабочий диапазон ГОТВ уточняют по технической документации.");
            AddNumber(table, "CN", "Концентрация Cн, об. %", Read("CN"), "Справочное значение из выбранного профиля. Вручную не вводится. Для HFC-227ea в предоставленном проектном эталоне указано 7,2. Применимость профиля к другим объектам отдельно проверяется.");
            AddNumber(table, "RHO0", "Плотность паров ρ₀, кг/м³", Read("RHO0"), "Справочное значение профиля при +20 °C и атмосферном давлении 101,3 кПа. Вручную не вводится; не путать с плотностью жидкости.");
            numbers["CN"].ReadOnly = true;
            numbers["RHO0"].ReadOnly = true;
            numbers["CN"].BackColor = numbers["RHO0"].BackColor = SystemColors.Control;
            numbers["CN"].TabStop = numbers["RHO0"].TabStop = false;
            var applyProfile = new Button { Text = "Применить профиль", AutoSize = true };
            void ApplyProfile()
            {
                if (!(agentInput.SelectedItem is string agent)) { errors.Text = "Сначала выберите ГОТВ."; return; }
                var profile = GasAgentCatalog.GetReferenceProfile(agent);
                numbers["CN"].Text = NumericData.Format(profile.Concentration);
                numbers["RHO0"].Text = NumericData.Format(profile.VaporDensity);
                errors.Text = "";
            }
            applyProfile.Click += (sender, args) => ApplyProfile();
            agentInput.SelectedIndexChanged += (sender, args) => ApplyProfile();
            AddRow(table, "Справочный профиль", applyProfile, "Источник: предоставленный проектный эталон, лист расчёта ГОТВ. Это не универсальная норма для любой пожарной нагрузки. Старые отличающиеся значения изменяются только после явного применения профиля.");
            AddRow(table, "Объём трубопроводов", new Label { AutoSize = true, Text = "Вычисляется по модели сети" }, "При расчёте суммируются объёмы участков выбранной зоны по фактическим длинам и внутренним диаметрам труб. Не вводится в параметры помещения.");
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
                parseErrors.Add(numbers[key].AccessibleName + (key == "CN" || key == "RHO0"
                    ? ": повреждено справочное значение; примените профиль ГОТВ."
                    : ": требуется конечное число (например, 2,5)."));
                return null;
            }
            var input = new GasZoneInput { Name = nameInput.Text.Trim(), Gotv = agentInput.SelectedItem as string,
                Height = Number("H"), OpeningsArea = Number("FH"), MinimumTemperature = Number("TM"),
                Concentration = Number("CN"), Density = Number("RHO0") };
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
