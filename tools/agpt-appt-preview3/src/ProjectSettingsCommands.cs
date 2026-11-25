using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;
using AGPT.Shared;
using Autodesk.AutoCAD.Runtime;
using CadApplication = Autodesk.AutoCAD.ApplicationServices.Application;

[assembly: CommandClass(typeof(AGPT.Cad.ProjectSettingsCommands))]

namespace AGPT.Cad
{
    public sealed class ProjectSettingsCommands
    {
        [CommandMethod("AGPT_PROJECT")]
        public void AgptProject() { Edit("AGPT"); }

        [CommandMethod("APPT_PROJECT")]
        public void ApptProject() { Edit("APPT"); }

        private static void Edit(string system)
        {
            var document = CadApplication.DocumentManager.MdiActiveDocument;
            if (document == null) return;
            try
            {
                EditForDocument(document, system, forceEdit: true);
            }
            catch (System.Exception ex)
            { document.Editor.WriteMessage("\n[" + system + "] Реквизиты проекта: " + ex.Message); }
        }

        public static bool EnsureConfigured(Autodesk.AutoCAD.ApplicationServices.Document document, string system)
        {
            if (document == null) return false;
            return EditForDocument(document, system, forceEdit: false);
        }

        private static bool EditForDocument(Autodesk.AutoCAD.ApplicationServices.Document document,
            string system, bool forceEdit)
        {
            ProjectMetadata metadata;
            bool found;
            using (var transaction = document.Database.TransactionManager.StartTransaction())
                found = ProjectSettingsStore.TryRead(document.Database, transaction, system, out metadata);
            if (!forceEdit && found && metadata.Validate(requireProjectFields: true).Count == 0) return true;
            if (!forceEdit)
                document.Editor.WriteMessage("\n[" + system + "] Для альбома нужны реквизиты текущего проекта. Заполните форму.");
            using var form = new ProjectSettingsForm(system, metadata);
            if (CadApplication.ShowModalDialog(form) != DialogResult.OK)
            {
                if (!forceEdit) document.Editor.WriteMessage("\n[" + system + "] Построение альбома отменено: реквизиты не подтверждены.");
                return false;
            }
            if (CadApplication.DocumentManager.MdiActiveDocument != document)
                throw new InvalidOperationException("Активный чертёж изменился. Повторите команду в нужном DWG.");
            using (var transaction = document.Database.TransactionManager.StartTransaction())
            {
                ProjectSettingsStore.Write(document.Database, transaction, system, form.Metadata);
                transaction.Commit();
            }
            document.Editor.WriteMessage("\n[" + system + "] Реквизиты сохранены в текущем чертеже. Сохраните DWG для записи на диск.");
            return true;
        }
    }

    internal sealed class ProjectSettingsForm : Form
    {
        private readonly Dictionary<string, TextBox> inputs = new Dictionary<string, TextBox>();
        private static readonly (string Property, string Label)[] Fields = {
            (nameof(ProjectMetadata.Cipher), "Шифр проекта *"),
            (nameof(ProjectMetadata.ObjectName), "Полное наименование объекта *"),
            (nameof(ProjectMetadata.ObjectShort), "Краткое наименование объекта"),
            (nameof(ProjectMetadata.Stage), "Стадия проектирования"),
            (nameof(ProjectMetadata.CityYear), "Город и год выпуска"),
            (nameof(ProjectMetadata.Company), "Проектная организация *"),
            (nameof(ProjectMetadata.CompanyGsl), "Реквизиты / лицензия организации"),
            (nameof(ProjectMetadata.GenDesigner), "Генеральный проектировщик"),
            (nameof(ProjectMetadata.VolumeTitle), "Наименование тома"),
            (nameof(ProjectMetadata.VolumeNo), "Номер тома"),
            (nameof(ProjectMetadata.Gip), "Главный инженер проекта"),
            (nameof(ProjectMetadata.Checked), "Проверил"),
            (nameof(ProjectMetadata.Drawn), "Разработал"),
            (nameof(ProjectMetadata.NormCtrl), "Нормоконтроль") };

        public ProjectMetadata Metadata { get; private set; }

        public ProjectSettingsForm(string system, ProjectMetadata metadata)
        {
            Text = "Реквизиты проекта — " + (system == "AGPT" ? "АГПТ" : "АППТ");
            AutoScaleMode = AutoScaleMode.Font;
            ClientSize = new Size(780, 650);
            MinimumSize = new Size(650, 460);
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            ShowInTaskbar = false;
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Padding = new Padding(12) };
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(720, 0),
                Text = "Реквизиты относятся к текущему чертежу и выбранной системе. Поля со * обязательны.\nФамилии и адреса указывайте только для вашего проекта.", Margin = new Padding(0, 0, 0, 10) }, 0, 0);
            var scroll = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
            var table = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, Padding = new Padding(0, 0, 18, 0) };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 265));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            for (int i = 0; i < Fields.Length; i++)
            {
                var field = Fields[i];
                bool multiline = field.Property == nameof(ProjectMetadata.ObjectName) || field.Property == nameof(ProjectMetadata.VolumeTitle);
                var input = new TextBox { Dock = DockStyle.Top, MaxLength = ProjectMetadata.MaxFieldCharacters,
                    Multiline = multiline, Height = multiline ? 52 : 24, Margin = new Padding(3, 3, 3, 7),
                    Text = (string)typeof(ProjectMetadata).GetProperty(field.Property).GetValue(metadata),
                    AccessibleName = field.Label, TabIndex = i };
                inputs.Add(field.Property, input);
                table.Controls.Add(new Label { Text = field.Label, AutoSize = true, Margin = new Padding(0, 7, 6, 3) }, 0, i);
                table.Controls.Add(input, 1, i);
            }
            scroll.Controls.Add(table);
            layout.Controls.Add(scroll, 0, 1);
            var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(0, 10, 0, 0) };
            var cancel = new Button { Text = "Отмена", AutoSize = true, DialogResult = DialogResult.Cancel };
            var save = new Button { Text = "Сохранить", AutoSize = true };
            save.Click += Save;
            buttons.Controls.Add(cancel);
            buttons.Controls.Add(save);
            layout.Controls.Add(buttons, 0, 2);
            CancelButton = cancel;
            AcceptButton = save;
            Controls.Add(layout);
        }

        private void Save(object sender, EventArgs args)
        {
            var metadata = new ProjectMetadata();
            foreach (var field in Fields)
                typeof(ProjectMetadata).GetProperty(field.Property).SetValue(metadata, inputs[field.Property].Text.Trim());
            var errors = metadata.Validate(requireProjectFields: true);
            if (errors.Count > 0)
            { MessageBox.Show(this, string.Join("\n", errors), "Проверьте реквизиты", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            try { metadata.Serialize(); }
            catch (System.IO.InvalidDataException ex)
            { MessageBox.Show(this, ex.Message, "Проверьте реквизиты", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            Metadata = metadata;
            DialogResult = DialogResult.OK;
            Close();
        }
    }
}
